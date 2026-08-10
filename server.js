// Local / self-hosted server. Serves the static dashboard and the same live API
// the Vercel deployment exposes, all backed by live Jira fetches (no database,
// no cron, no disk). Handy for running the dashboard on your own machine.
require('dotenv').config();
const express = require('express');
const path = require('path');
const { getLiveData } = require('./lib/live');
const { UPDATE_CHECK_STATUSES, WON_STATUSES, OVERVIEW_STATUSES, getConfig: getJiraConfig } = require('./lib/jira');
const { verifySignature, handleTranscriptionCompleted, queuePendingMeeting, retryPendingMeetings } = require('./lib/fireflies');
const SET_STATUSES = { won: WON_STATUSES, overview: OVERVIEW_STATUSES };
const { listTasks, createTask, updateTask, deleteTask, listLeave, setLeaveStatus, listHolidays, setHolidayStatus } = require('./lib/tracker');
const { USE_REDIS, initError } = require('./lib/trackerStore');
const quickLinksHandler = require('./api/quicklinks');
const {
  createSession,
  isValidSession,
  destroySession,
  checkCredentials,
  recordFailedAttempt,
  isRateLimited,
  clearFailedAttempts,
} = require('./lib/authStore');

const app = express();
const PORT = process.env.PORT || 3000;

// verify captures the exact raw bytes alongside the parsed body, needed to
// check the Fireflies webhook's HMAC signature (which is computed over the
// raw request, not our re-serialized copy of it).
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

// Login gate — mirrors middleware.js on Vercel. Runs before static files and
// every API route except the login page itself and the auth endpoint.
app.use(async (req, res, next) => {
  // The Fireflies webhook authenticates via HMAC signature, not a session
  // cookie — it's a server-to-server call, not a browser visit.
  if (req.path === '/login.html' || req.path === '/api/auth' || req.path === '/api/fireflies-webhook') return next();
  const valid = await isValidSession(getCookie(req, 'session'));
  if (valid) return next();
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  res.redirect('/login.html');
});

app.post('/api/auth', async (req, res) => {
  const id = req.ip || 'unknown';
  if (await isRateLimited(id)) {
    res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    return;
  }
  const { username, password } = req.body || {};
  if (!checkCredentials(username, password)) {
    await recordFailedAttempt(id);
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  await clearFailedAttempts(id);
  const token = await createSession();
  res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 24 * 60 * 60}`);
  res.json({ ok: true });
});
app.delete('/api/auth', async (req, res) => {
  const token = getCookie(req, 'session');
  if (token) await destroySession(token);
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const { allCards, unassignedCards, ...data } = await getLiveData(); // strip tab-specific sets
    res.json(data);
  } catch (err) {
    console.error('Live data fetch failed:', err.message);
    res.status(500).json({ generatedAt: null, count: 0, issues: [], error: err.message });
  }
});

// Jira Update Check — full assigned set filtered to the sanity-check statuses.
app.get('/api/update-check', async (req, res) => {
  try {
    const { allCards, unassignedCards, generatedAt } = await getLiveData();
    const set = req.query.set;
    const statuses = SET_STATUSES[set] || UPDATE_CHECK_STATUSES;
    const pool = SET_STATUSES[set] ? [...(allCards || []), ...(unassignedCards || [])] : allCards || [];
    const cards = pool.filter((c) => statuses.includes(c.status));
    res.json({ generatedAt, count: cards.length, cards });
  } catch (err) {
    console.error('Update Check fetch failed:', err.message);
    res.status(500).json({ generatedAt: null, count: 0, cards: [], error: err.message });
  }
});

// No persistent storage in this design, so no day-over-day trend history.
app.get('/api/history', (req, res) => res.json([]));

app.post('/api/refresh', async (req, res) => {
  try {
    const data = await getLiveData({ force: true });
    res.json({ ok: true, generatedAt: data.generatedAt, count: data.count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fireflies webhook: fires when a meeting's transcript finishes processing.
// We verify the HMAC signature, then pull the summary + full transcript and
// post them as comments on the PSV card named in the meeting title.
app.post('/api/fireflies-webhook', async (req, res) => {
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'FIREFLIES_WEBHOOK_SECRET not configured' });
    return;
  }
  if (!verifySignature(req.rawBody, req.headers['x-hub-signature'], secret)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const payload = req.body || {};
  if (payload.eventType !== 'Transcription completed') {
    res.status(200).json({ ok: true, skipped: true, reason: 'ignored event type' });
    return;
  }

  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'FIREFLIES_API_KEY not configured' });
    return;
  }

  try {
    const jiraCfg = getJiraConfig();
    const result = await handleTranscriptionCompleted({
      meetingId: payload.meetingId,
      jiraCfg,
      projectKey: jiraCfg.projectKey,
      apiKey,
    });
    if (result.skipped && result.reason === 'no Jira key found in meeting title') {
      await queuePendingMeeting(payload.meetingId, result.title);
    }
    res.status(200).json(result);
  } catch (err) {
    console.error('Fireflies webhook failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Local-dev equivalent of the Vercel retry cron (see api/cron/fireflies-retry.js)
// — Vercel's own cron scheduling doesn't apply when running this server
// yourself, so this re-checks the pending queue on the same cadence directly.
if (process.env.FIREFLIES_API_KEY) {
  const RETRY_INTERVAL_MS = 60 * 60 * 1000; // hourly; no Vercel plan limits apply locally
  setInterval(async () => {
    try {
      const jiraCfg = getJiraConfig();
      const result = await retryPendingMeetings({ jiraCfg, projectKey: jiraCfg.projectKey, apiKey: process.env.FIREFLIES_API_KEY });
      if (result.matched.length || result.expired.length) {
        console.log('Fireflies retry:', result);
      }
    } catch (err) {
      console.error('Fireflies retry failed:', err.message);
    }
  }, RETRY_INTERVAL_MS);
}

// Daily Task Tracker — manually entered, shared, persistent (not from Jira).
app.get('/api/tracker', async (req, res) => {
  // ?debug=1 folded in here (matches api/tracker/index.js on Vercel) instead
  // of its own route, to keep the two deployments' API surface identical.
  if (req.query.debug) {
    const err = initError();
    res.json({
      hasKvUrl: !!process.env.KV_REST_API_URL,
      hasKvToken: !!process.env.KV_REST_API_TOKEN,
      hasUpstashUrl: !!process.env.UPSTASH_REDIS_REST_URL,
      hasUpstashToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
      useRedis: USE_REDIS,
      initError: err ? err.message : null,
    });
    return;
  }
  if (req.query.resource === 'leave') {
    res.json(await listLeave());
    return;
  }
  if (req.query.resource === 'holidays') {
    res.json(await listHolidays());
    return;
  }
  res.json(await listTasks());
});
app.post('/api/tracker', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.resource === 'leave') {
      res.json(await setLeaveStatus(body.pse, body.date, !!body.onLeave));
      return;
    }
    if (body.resource === 'holidays') {
      res.json(await setHolidayStatus(body.date, !!body.isHoliday));
      return;
    }
    res.status(201).json(await createTask(body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.put('/api/tracker/:id', async (req, res) => {
  try {
    res.json(await updateTask(req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/tracker/:id', async (req, res) => {
  try {
    res.json(await deleteTask(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Quick Links — user-added, shared, persistent (not from Jira).
// Delegates to the very same handler Vercel runs in production (one function,
// dispatching on ?resource=), so local and deployed behaviour can't drift.
app.all('/api/quicklinks', quickLinksHandler);

app.listen(PORT, () => {
  console.log(`PSV dashboard running at http://localhost:${PORT}`);
});
