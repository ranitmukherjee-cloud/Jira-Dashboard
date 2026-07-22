// Local / self-hosted server. Serves the static dashboard and the same live API
// the Vercel deployment exposes, all backed by live Jira fetches (no database,
// no cron, no disk). Handy for running the dashboard on your own machine.
require('dotenv').config();
const express = require('express');
const path = require('path');
const { getLiveData } = require('./lib/live');
const { listTasks, createTask, updateTask, deleteTask } = require('./lib/tracker');
const { USE_REDIS, initError } = require('./lib/trackerStore');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    res.json(await getLiveData());
  } catch (err) {
    console.error('Live data fetch failed:', err.message);
    res.status(500).json({ generatedAt: null, count: 0, issues: [], error: err.message });
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
app.get('/api/tracker/debug', (req, res) => {
  const err = initError();
  res.json({
    hasKvUrl: !!process.env.KV_REST_API_URL,
    hasKvToken: !!process.env.KV_REST_API_TOKEN,
    hasUpstashUrl: !!process.env.UPSTASH_REDIS_REST_URL,
    hasUpstashToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    useRedis: USE_REDIS,
    initError: err ? err.message : null,
  });
});
app.get('/api/tracker', async (req, res) => {
  res.json(await listTasks());
});
app.post('/api/tracker', async (req, res) => {
  try {
    res.status(201).json(await createTask(req.body || {}));
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

app.listen(PORT, () => {
  console.log(`PSV dashboard running at http://localhost:${PORT}`);
});
