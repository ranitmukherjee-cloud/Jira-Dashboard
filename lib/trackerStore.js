// Storage for the Daily Task Tracker: manually-entered, shared, persistent
// data with no Jira equivalent, so — unlike the rest of this dashboard — it
// genuinely needs a real store. Upstash Redis in production, since the
// serverless filesystem doesn't persist between requests; a local JSON file
// everywhere else (self-hosted server.js, local dev), so no setup is
// required to develop against it.
const fs = require('fs');
const path = require('path');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);

let redis;
let initError = null;
if (USE_REDIS) {
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  } catch (err) {
    // Don't let a bad URL/token crash the whole serverless function at import
    // time — surface it as a normal error the API can report instead.
    initError = err;
  }
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

function assertReady() {
  if (initError) {
    throw new Error(`Redis client failed to initialize: ${initError.message}`);
  }
}

async function getTasks() {
  assertReady();
  if (USE_REDIS) return (await redis.get('tracker:tasks')) || [];
  return readJsonFile(FILE_PATH, []);
}

async function setTasks(tasks) {
  assertReady();
  if (USE_REDIS) return redis.set('tracker:tasks', tasks);
  writeJsonFile(FILE_PATH, tasks);
}

module.exports = { getTasks, setTasks, USE_REDIS, initError: () => initError };
