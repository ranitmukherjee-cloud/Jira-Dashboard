// Storage abstraction: Upstash Redis (via Vercel's Marketplace integration) in
// production — required there, since the serverless filesystem doesn't persist
// between invocations — local JSON files everywhere else (self-hosted server.js,
// local dev). Picked automatically based on whether Redis env vars are present.
const fs = require('fs');
const path = require('path');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_KV = !!(REDIS_URL && REDIS_TOKEN);
let redis;
if (USE_KV) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}

const DATA_PATH = path.join(__dirname, '..', 'public', 'data', 'psv-data.json');
const HISTORY_PATH = path.join(__dirname, '..', 'public', 'data', 'history.json');

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function getData() {
  if (USE_KV) return (await redis.get('psv:data')) || { generatedAt: null, count: 0, issues: [] };
  return readJsonFile(DATA_PATH, { generatedAt: null, count: 0, issues: [] });
}

async function setData(data) {
  if (USE_KV) return redis.set('psv:data', data);
  writeJsonFile(DATA_PATH, data);
}

async function getHistory() {
  if (USE_KV) return (await redis.get('psv:history')) || [];
  return readJsonFile(HISTORY_PATH, []);
}

async function setHistory(history) {
  if (USE_KV) return redis.set('psv:history', history);
  writeJsonFile(HISTORY_PATH, history);
}

module.exports = { getData, setData, getHistory, setHistory, USE_KV };
