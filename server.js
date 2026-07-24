import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN;
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;
const HISTORY_PER_CHANNEL = Number(process.env.HISTORY_PER_CHANNEL || 20);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30_000);
const CHANNEL_LIST_TTL_MS = Number(process.env.CHANNEL_LIST_TTL_MS || 5 * 60_000);
const FETCH_CONCURRENCY = Number(process.env.SLACK_FETCH_CONCURRENCY || 8);

let messageCache = { at: 0, data: null };
let channelListCache = { at: 0, data: null };
const userNameCache = new Map();
let selfUserId = null;

function checkAuth(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!API_TOKEN || token !== API_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function assertEnv(res) {
  if (!SLACK_USER_TOKEN) {
    res.status(500).json({ error: 'SLACK_USER_TOKEN が設定されていません（環境変数）' });
    return false;
  }
  return true;
}

// 複数チャンネル/ユーザーへの問い合わせを、指定件数だけ同時実行する（Slackのレート制限を考慮した並列化）
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function slackApi(method, params = {}, useGet = false, retried = false) {
  const url = new URL(`https://slack.com/api/${method}`);
  let res;
  if (useGet) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${SLACK_USER_TOKEN}` },
    });
  } else {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SLACK_USER_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });
  }
  // Slackのレート制限（429）は一度だけ待って再試行する
  if (res.status === 429 && !retried) {
    const wait = Number(res.headers.get('retry-after') || 1);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return slackApi(method, params, useGet, true);
  }
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`slack:${method}:${json.error || 'unknown_error'}`);
  }
  return json;
}

async function getSelfUserId() {
  if (selfUserId) return selfUserId;
  const auth = await slackApi('auth.test', {}, true);
  selfUserId = auth.user_id;
  return selfUserId;
}

async function listAllConversations(types) {
  const channels = [];
  let cursor;
  do {
    const params = { types, limit: '200', exclude_archived: 'true' };
    if (cursor) params.cursor = cursor;
    const json = await slackApi('conversations.list', params, true);
    channels.push(...json.channels);
    cursor = json.response_metadata?.next_cursor || null;
  } while (cursor);
  return channels;
}

// チャンネル一覧は頻繁には変わらないため、メッセージ本体より長いTTLで別キャッシュする
async function getConversationLists() {
  const now = Date.now();
  if (channelListCache.data && now - channelListCache.at < CHANNEL_LIST_TTL_MS) {
    return channelListCache.data;
  }
  const [publicPrivate, ims] = await Promise.all([
    listAllConversations('public_channel,private_channel,mpim'),
    listAllConversations('im'),
  ]);
  channelListCache = { at: now, data: { publicPrivate, ims } };
  return channelListCache.data;
}

async function fetchHistory(channelId) {
  const json = await slackApi(
    'conversations.history',
    { channel: channelId, limit: String(HISTORY_PER_CHANNEL) },
    true
  );
  return json.messages || [];
}

function channelLabel(ch) {
  if (ch.is_im) return 'DM';
  return ch.name ? `#${ch.name}` : ch.id;
}

// ユーザー名は変わらない前提でプロセス内に永続キャッシュ（毎回引き直さない）
async function resolveUserName(userId) {
  if (userNameCache.has(userId)) return userNameCache.get(userId);
  try {
    const json = await slackApi('users.info', { user: userId }, true);
    const name = json.user?.real_name || json.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch (e) {
    userNameCache.set(userId, userId);
    return userId;
  }
}

async function collectMessages() {
  const uid = await getSelfUserId();
  const { publicPrivate, ims } = await getConversationLists();
  const memberChannels = publicPrivate.filter((ch) => ch.is_member);

  const [mentionLists, dmLists] = await Promise.all([
    mapWithConcurrency(memberChannels, FETCH_CONCURRENCY, async (ch) => {
      try {
        const msgs = await fetchHistory(ch.id);
        return msgs
          .filter(
            (m) =>
              m.type === 'message' &&
              !m.subtype &&
              m.user !== uid &&
              typeof m.text === 'string' &&
              m.text.includes(`<@${uid}>`)
          )
          .map((m) => ({
            kind: 'mention',
            channel: ch.id,
            channelLabel: channelLabel(ch),
            userId: m.user,
            text: m.text,
            ts: m.ts,
          }));
      } catch (e) {
        // 個別チャンネルの取得失敗（権限不足等）はスキップして続行
        return [];
      }
    }),
    mapWithConcurrency(ims, FETCH_CONCURRENCY, async (ch) => {
      try {
        const msgs = await fetchHistory(ch.id);
        return msgs
          .filter((m) => m.type === 'message' && !m.subtype && m.user !== uid)
          .map((m) => ({
            kind: 'dm',
            channel: ch.id,
            channelLabel: channelLabel(ch),
            userId: m.user,
            text: m.text || '',
            ts: m.ts,
          }));
      } catch (e) {
        return [];
      }
    }),
  ]);

  const all = [...mentionLists.flat(), ...dmLists.flat()];

  const userIds = [...new Set(all.map((m) => m.userId).filter(Boolean))];
  await mapWithConcurrency(userIds, FETCH_CONCURRENCY, resolveUserName);

  return all
    .map((m) => ({ ...m, fromName: userNameCache.get(m.userId) || m.userId }))
    .sort((a, b) => Number(b.ts) - Number(a.ts));
}

app.get('/messages', async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!assertEnv(res)) return;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  try {
    const now = Date.now();
    if (!messageCache.data || now - messageCache.at > CACHE_TTL_MS) {
      messageCache = { at: now, data: await collectMessages() };
    }
    res.json({ messages: messageCache.data.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 指定したチャンネル/DMそれぞれについて、直近の発言者が自分自身かどうかを返す
// （「自分が最後に返信済み」のスレッドを自動で完了扱いにするための判定に使う）
app.get('/channel-last-sender', async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!assertEnv(res)) return;
  const channelsParam = req.query.channels;
  if (!channelsParam) {
    res.status(400).json({ error: 'channels クエリパラメータが必要です（カンマ区切りのチャンネルID）' });
    return;
  }
  const channelIds = [...new Set(String(channelsParam).split(',').map((c) => c.trim()).filter(Boolean))];
  try {
    const uid = await getSelfUserId();
    const results = {};
    await mapWithConcurrency(channelIds, FETCH_CONCURRENCY, async (channelId) => {
      try {
        const json = await slackApi('conversations.history', { channel: channelId, limit: '1' }, true);
        const last = (json.messages || [])[0];
        results[channelId] = last
          ? { userId: last.user || null, ts: last.ts, isSelf: last.user === uid }
          : { userId: null, ts: null, isSelf: false };
      } catch (e) {
        results[channelId] = { error: e.message };
      }
    });
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'fj-slack-backend' }));

app.listen(PORT, () => console.log(`fj-slack-backend listening on port ${PORT}`));
