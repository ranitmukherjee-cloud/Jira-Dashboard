// Local / self-hosted server. Serves the static dashboard and the same live API
// the Vercel deployment exposes, all backed by live Jira fetches (no database,
// no cron, no disk). Handy for running the dashboard on your own machine.
require('dotenv').config();
const express = require('express');
const path = require('path');
const { getLiveData } = require('./lib/live');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.listen(PORT, () => {
  console.log(`PSV dashboard running at http://localhost:${PORT}`);
});
