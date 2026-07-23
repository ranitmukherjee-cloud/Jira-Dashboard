// Slack integration: posts messages to the product-solutions-team channel and
// direct messages to individual workspace members, via a Slack Bot (bot
// tokens are the only way a third-party app can post into Slack -- there is
// no API to send "as" a specific human user).
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

function isConfigured() {
  return !!(SLACK_BOT_TOKEN && SLACK_CHANNEL_ID);
}

async function slackCall(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Slack API error');
  return data;
}

function requireConfigured() {
  if (!SLACK_BOT_TOKEN) throw new Error('Slack is not connected yet (missing SLACK_BOT_TOKEN)');
  if (!SLACK_CHANNEL_ID) throw new Error('Slack is not connected yet (missing SLACK_CHANNEL_ID)');
}

async function postToChannel(text) {
  requireConfigured();
  if (!text || !text.trim()) throw new Error('Message is required');
  return slackCall('chat.postMessage', { channel: SLACK_CHANNEL_ID, text });
}

async function sendDm(userId, text) {
  requireConfigured();
  if (!userId) throw new Error('A recipient is required');
  if (!text || !text.trim()) throw new Error('Message is required');
  const opened = await slackCall('conversations.open', { users: userId });
  return slackCall('chat.postMessage', { channel: opened.channel.id, text });
}

// Cached briefly in memory so DM-recipient autocomplete doesn't hit Slack's
// users.list on every keystroke -- same pattern as lib/live.js's TTL cache.
let usersCache = null;
let usersCacheAt = 0;
const USERS_TTL_MS = 5 * 60 * 1000;

async function listUsers({ force } = {}) {
  requireConfigured();
  if (!force && usersCache && Date.now() - usersCacheAt < USERS_TTL_MS) return usersCache;
  const data = await slackCall('users.list', {});
  const users = (data.members || [])
    .filter((u) => !u.is_bot && !u.deleted && u.id !== 'USLACKBOT')
    .map((u) => ({
      id: u.id,
      name: u.profile?.real_name || u.real_name || u.name,
      handle: u.name,
      avatar: u.profile?.image_48 || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  usersCache = users;
  usersCacheAt = Date.now();
  return users;
}

module.exports = { isConfigured, postToChannel, sendDm, listUsers, SLACK_CHANNEL_ID };
