// Login gate for the whole dashboard: a single shared username/password (env
// vars DASHBOARD_USERNAME / DASHBOARD_PASSWORD) plus server-side, revocable
// sessions -- same Redis-in-prod / local-JSON-file-in-dev split as
// trackerStore.js and quickLinksStore.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
let redis;
if (USE_REDIS) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}

const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days
const SESSIONS_FILE = path.join(__dirname, '..', 'data', 'sessions.json');

function readLocalSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeLocalSessions(sessions) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

async function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  if (USE_REDIS) {
    await redis.set(`session:${token}`, '1', { ex: SESSION_TTL_SECONDS });
  } else {
    const sessions = readLocalSessions();
    sessions[token] = Date.now() + SESSION_TTL_SECONDS * 1000;
    writeLocalSessions(sessions);
  }
  return token;
}

async function isValidSession(token) {
  if (!token) return false;
  if (USE_REDIS) {
    const val = await redis.get(`session:${token}`);
    return val != null;
  }
  const sessions = readLocalSessions();
  const expiresAt = sessions[token];
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    delete sessions[token];
    writeLocalSessions(sessions);
    return false;
  }
  return true;
}

async function destroySession(token) {
  if (!token) return;
  if (USE_REDIS) {
    await redis.del(`session:${token}`);
  } else {
    const sessions = readLocalSessions();
    delete sessions[token];
    writeLocalSessions(sessions);
  }
}

// Hash both sides to a fixed length first so timingSafeEqual compares
// equal-length buffers regardless of the submitted string's length -- avoids
// leaking anything about the real credentials via early-exit timing.
function checkCredentials(username, password) {
  const expectedUser = process.env.DASHBOARD_USERNAME || '';
  const expectedPass = process.env.DASHBOARD_PASSWORD || '';
  if (!expectedUser || !expectedPass) return false; // gate not configured yet
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const userMatch = crypto.timingSafeEqual(hash(username || ''), hash(expectedUser));
  const passMatch = crypto.timingSafeEqual(hash(password || ''), hash(expectedPass));
  return userMatch && passMatch;
}

// Basic brute-force guard: lock out an identifier (IP) after too many failed
// attempts within a short window.
const FAIL_WINDOW_SECONDS = 15 * 60;
const FAIL_LIMIT = 8;
const localFails = new Map(); // used only when Redis isn't configured (local dev)

async function recordFailedAttempt(id) {
  const key = `loginfail:${id}`;
  if (USE_REDIS) {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, FAIL_WINDOW_SECONDS);
    return count;
  }
  const rec = localFails.get(id);
  const now = Date.now();
  if (!rec || now > rec.resetAt) {
    localFails.set(id, { count: 1, resetAt: now + FAIL_WINDOW_SECONDS * 1000 });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

async function isRateLimited(id) {
  const key = `loginfail:${id}`;
  if (USE_REDIS) {
    const count = await redis.get(key);
    return Number(count || 0) >= FAIL_LIMIT;
  }
  const rec = localFails.get(id);
  if (!rec || Date.now() > rec.resetAt) return false;
  return rec.count >= FAIL_LIMIT;
}

async function clearFailedAttempts(id) {
  if (USE_REDIS) {
    await redis.del(`loginfail:${id}`);
  } else {
    localFails.delete(id);
  }
}

module.exports = {
  createSession,
  isValidSession,
  destroySession,
  checkCredentials,
  recordFailedAttempt,
  isRateLimited,
  clearFailedAttempts,
  USE_REDIS,
};
