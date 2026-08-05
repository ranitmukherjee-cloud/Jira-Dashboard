// Storage for the Fireflies retry queue: meetings whose title had no PSV key
// at webhook time, kept around so the hourly/daily retry can catch a later
// title rename. Same Redis-in-prod / local-JSON-file-in-dev pattern as
// trackerStore.js, since this needs to persist across serverless invocations
// too.
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
    initError = err;
  }
}

const FILE_PATH = path.join(__dirname, '..', 'data', 'fireflies-pending.json');

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
  if (initError) throw new Error(`Redis client failed to initialize: ${initError.message}`);
}

async function getPending() {
  assertReady();
  if (USE_REDIS) return (await redis.get('fireflies:pending')) || [];
  return readJsonFile(FILE_PATH, []);
}

async function setPending(list) {
  assertReady();
  if (USE_REDIS) return redis.set('fireflies:pending', list);
  writeJsonFile(FILE_PATH, list);
}

module.exports = { getPending, setPending, USE_REDIS, initError: () => initError };
