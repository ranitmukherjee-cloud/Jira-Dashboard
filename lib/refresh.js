// Shared by the manual "Refresh now" endpoint and the daily cron endpoint.
const { getConfig, reconcile } = require('./jira');
const { getData, setData } = require('./store');
const { appendSnapshot } = require('./history');

async function runRefresh() {
  const cfg = getConfig();
  const previousData = await getData();
  const previous = Object.fromEntries((previousData.issues || []).map((i) => [i.key, i]));
  const { issues, changelogFetches, total } = await reconcile(cfg, previous);
  const newData = { generatedAt: new Date().toISOString(), count: issues.length, issues };
  await setData(newData);
  await appendSnapshot(issues);
  return { generatedAt: newData.generatedAt, count: issues.length, changelogFetches, total };
}

module.exports = { runRefresh };
