import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN;
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;
const HISTORY_PER_CHANNEL = Number(process.env.HISTORY_PER_CHANNEL || 20);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30_000);

let cache = { at: 0, data: null };
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

async function slackApi(method, params = {}, useGet = false) {
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

async function collectMessages() {
  const uid = await getSelfUserId();

  const [publicPrivate, ims] = await Promise.all([
    listAllConversations('public_channel,private_channel,mpim'),
    listAllConversations('im'),
  ]);

  const mentionResults = [];
  for (const ch of publicPrivate) {
    if (!ch.is_member) continue;
    try {
      const msgs = await fetchHistory(ch.id);
      for (const m of msgs) {
        if (m.type !== 'message' || m.subtype) continue;
        if (m.user === uid) continue;
        if (typeof m.text === 'string' && m.text.includes(`<@${uid}>`)) {
          mentionResults.push({
            kind: 'mention',
            channel: ch.id,
            channelLabel: channelLabel(ch),
            userId: m.user,
            text: m.text,
            ts: m.ts,
          });
        }
      }
    } catch (e) {
      // 個別チャンネルの取得失敗（権限不足等）はスキップして続行
    }
  }

  const dmResults = [];
  for (const ch of ims) {
    try {
      const msgs = await fetchHistory(ch.id);
      for (const m of msgs) {
        if (m.type !== 'message' || m.subtype) continue;
        if (m.user === uid) continue;
        dmResults.push({
          kind: 'dm',
          channel: ch.id,
          channelLabel: channelLabel(ch),
          userId: m.user,
          text: m.text || '',
          ts: m.ts,
        });
      }
    } catch (e) {
      // skip
    }
  }

  const all = [...mentionResults, ...dmResults];

  const userIds = [...new Set(all.map((m) => m.userId).filter(Boolean))];
  const nameMap = {};
  for (const id of userIds) {
    try {
      const json = await slackApi('users.info', { user: id }, true);
      nameMap[id] = json.user?.real_name || json.user?.name || id;
    } catch (e) {
      nameMap[id] = id;
    }
  }

  return all
    .map((m) => ({ ...m, fromName: nameMap[m.userId] || m.userId }))
    .sort((a, b) => Number(b.ts) - Number(a.ts));
}

app.get('/messages', async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!assertEnv(res)) return;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  try {
    const now = Date.now();
    if (!cache.data || now - cache.at > CACHE_TTL_MS) {
      cache = { at: now, data: await collectMessages() };
    }
    res.json({ messages: cache.data.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'fj-slack-backend' }));

app.listen(PORT, () => console.log(`fj-slack-backend listening on port ${PORT}`));
