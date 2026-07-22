require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getConfig, reconcile } = require('./lib/jira');
const { appendSnapshot, loadHistory } = require('./lib/history');

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5 * 60 * 1000); // 5 min default
const DATA_PATH = path.join(__dirname, 'public', 'data', 'psv-data.json');

let cache = { generatedAt: null, count: 0, issues: [] };
let lastError = null;
let refreshing = false;

function loadFromDisk() {
  if (fs.existsSync(DATA_PATH)) {
    try {
      cache = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    } catch (err) {
      console.error('Failed to parse cached data file:', err.message);
    }
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const cfg = getConfig();
    const previous = Object.fromEntries(cache.issues.map((i) => [i.key, i]));
    const { issues, changelogFetches, total } = await reconcile(cfg, previous);
    cache = { generatedAt: new Date().toISOString(), count: issues.length, issues };
    lastError = null;
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(cache, null, 2));
    appendSnapshot(issues);
    console.log(
      `[${cache.generatedAt}] Refreshed ${total} issues (${changelogFetches} changelog re-fetches)`
    );
  } catch (err) {
    lastError = err.message;
    console.error('Refresh failed:', err.message);
  } finally {
    refreshing = false;
  }
}

loadFromDisk();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', (req, res) => res.json(cache));

app.get('/api/history', (req, res) => res.json(loadHistory()));

app.get('/api/health', (req, res) =>
  res.json({ ok: !lastError, lastRefresh: cache.generatedAt, lastError, refreshing })
);

app.post('/api/refresh', async (req, res) => {
  await refresh();
  res.json({ ok: !lastError, lastRefresh: cache.generatedAt, lastError });
});

app.listen(PORT, () => {
  console.log(`PSV dashboard running at http://localhost:${PORT}`);
});

refresh();
setInterval(refresh, POLL_INTERVAL_MS);
