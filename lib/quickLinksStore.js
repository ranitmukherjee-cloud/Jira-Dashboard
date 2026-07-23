// Storage for Quick Links: shared, persistent, user-added data with no Jira
// equivalent -- same pattern as the Daily Task Tracker. Upstash Redis in
// production (the serverless filesystem doesn't persist between requests),
// a local JSON file everywhere else (self-hosted server.js, local dev).
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

const FILE_PATH = path.join(__dirname, '..', 'data', 'quicklinks.json');

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

// Returns null (distinct from []) when nothing has been stored yet, so the
// caller can tell "never initialized" apart from "initialized but emptied".
async function getLinks() {
  if (USE_REDIS) return (await redis.get('quicklinks:items')) ?? null;
  return readJsonFile(FILE_PATH);
}

async function setLinks(links) {
  if (USE_REDIS) return redis.set('quicklinks:items', links);
  writeJsonFile(FILE_PATH, links);
}

module.exports = { getLinks, setLinks, USE_REDIS };
