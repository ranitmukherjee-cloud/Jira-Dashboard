// Local / self-hosted server. Serves the static dashboard and the same live API
// the Vercel deployment exposes, all backed by live Jira fetches (no database,
// no cron, no disk). Handy for running the dashboard on your own machine.
require('dotenv').config();
const express = require('express');
const path = require('path');
const { getLiveData } = require('./lib/live');
const { UPDATE_CHECK_STATUSES, WON_STATUSES } = require('./lib/jira');
const { listTasks, createTask, updateTask, deleteTask, listLeave, setLeaveStatus, listHolidays, setHolidayStatus } = require('./lib/tracker');
const { USE_REDIS, initError } = require('./lib/trackerStore');
const { listLinks, addLink, updateLink, reorderLinks, deleteLink, listGroups, createGroup, renameGroup, deleteGroup } = require('./lib/quickLinks');
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

app.use(express.json());

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

// Login gate — mirrors middleware.js on Vercel. Runs before static files and
// every API route except the login page itself and the auth endpoint.
app.use(async (req, res, next) => {
  if (req.path === '/login.html' || req.path === '/api/auth') return next();
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
    const won = req.query.set === 'won';
    const statuses = won ? WON_STATUSES : UPDATE_CHECK_STATUSES;
    const pool = won ? [...(allCards || []), ...(unassignedCards || [])] : allCards || [];
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
app.get('/api/quicklinks', async (req, res) => {
  res.json(await listLinks());
});
app.post('/api/quicklinks', async (req, res) => {
  try {
    res.status(201).json(await addLink(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.patch('/api/quicklinks/:id', async (req, res) => {
  try {
    res.json(await updateLink(req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/quicklinks/reorder', async (req, res) => {
  try {
    const { group, ids } = req.body || {};
    if (!group || !Array.isArray(ids)) throw new Error('group and ids[] are required');
    res.json(await reorderLinks(group, ids));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/quicklinks/:id', async (req, res) => {
  try {
    res.json(await deleteLink(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get('/api/quicklinks/groups', async (req, res) => {
  res.json(await listGroups());
});
app.post('/api/quicklinks/groups', async (req, res) => {
  try {
    res.status(201).json(await createGroup((req.body || {}).name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.patch('/api/quicklinks/groups/:name', async (req, res) => {
  try {
    res.json(await renameGroup(req.params.name, (req.body || {}).name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/quicklinks/groups/:name', async (req, res) => {
  try {
    res.json(await deleteGroup(req.params.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PSV dashboard running at http://localhost:${PORT}`);
});
