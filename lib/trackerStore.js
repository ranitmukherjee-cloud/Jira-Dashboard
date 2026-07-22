// Storage for the Daily Task Tracker: manually-entered, shared, persistent
// data with no Jira equivalent, so — unlike the rest of this dashboard — it
// genuinely needs a real store. Upstash Redis (via Vercel's Marketplace
// integration) in production, since the serverless filesystem doesn't
// persist between requests; a local JSON file everywhere else (self-hosted
// server.js, local dev), so no setup is required to develop against it.
const fs = require('fs');
const path = require('path');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
let redis;
if (USE_REDIS) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}

const FILE_PATH = path.join(__dirname, '..', 'data', 'tracker.json');

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

async function getTasks() {
  if (USE_REDIS) return (await redis.get('tracker:tasks')) || [];
  return readJsonFile(FILE_PATH, []);
}

async function setTasks(tasks) {
  if (USE_REDIS) return redis.set('tracker:tasks', tasks);
  writeJsonFile(FILE_PATH, tasks);
}

module.exports = { getTasks, setTasks, USE_REDIS };
