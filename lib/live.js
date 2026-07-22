// Live Jira data with a short in-memory cache. No database, no cron, no disk:
// every miss pulls the whole board straight from Jira. The cache only exists to
// absorb bursts (page loads, the 60s frontend poll, multiple viewers) so we
// don't refetch on every single request. "Refresh now" passes force:true to
// bypass it. On Vercel each serverless instance keeps its own cache, which is
// fine — worst case is one extra live pull per cold instance.
const { getConfig, fetchLive } = require('./jira');

const TTL_MS = Number(process.env.LIVE_TTL_MS || 30000);

let cache = null; // { data, at }
let inFlight = null;

async function getLiveData({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!force && inFlight) return inFlight; // dedupe concurrent misses

  const run = (async () => {
    const cfg = getConfig();
    const { issues } = await fetchLive(cfg);
    const data = { generatedAt: new Date().toISOString(), count: issues.length, issues };
    cache = { data, at: Date.now() };
    return data;
  })();

  if (!force) inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

module.exports = { getLiveData };
