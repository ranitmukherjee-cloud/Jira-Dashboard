// Appends one snapshot per calendar day (IST) so the dashboard can show trends
// over time. Re-running on the same day overwrites that day's entry rather
// than duplicating it, so both on-demand refreshes and the daily cron/scheduled
// task can safely call this.
const { isMrrMissing } = require('./jira');
const { getHistory, setHistory } = require('./store');

const MAX_ENTRIES = 180;

function istDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d); // YYYY-MM-DD
}

function buildSnapshot(issues) {
  const byStageGroup = { active: 0, won: 0, churn: 0, cold: 0, rejected: 0 };
  let totalMrr = 0;
  let validMrrCount = 0;
  let missingMrrCount = 0;
  const completedTats = [];

  for (const i of issues) {
    byStageGroup[i.stageGroup] = (byStageGroup[i.stageGroup] || 0) + 1;
    if (isMrrMissing(i.mrr)) missingMrrCount++;
    else {
      totalMrr += i.mrr;
      validMrrCount++;
    }
    if (i.tatStatus === 'completed' && i.tatDays != null) completedTats.push(i.tatDays);
  }

  const avgTatCompletedDays = completedTats.length
    ? Math.round(completedTats.reduce((a, b) => a + b, 0) / completedTats.length)
    : null;

  return {
    date: istDateString(),
    generatedAt: new Date().toISOString(),
    count: issues.length,
    totalMrr,
    validMrrCount,
    missingMrrCount,
    byStageGroup,
    avgTatCompletedDays,
  };
}

async function appendSnapshot(issues) {
  let history = await getHistory();
  const snapshot = buildSnapshot(issues);
  const idx = history.findIndex((h) => h.date === snapshot.date);
  if (idx >= 0) history[idx] = snapshot;
  else history.push(snapshot);

  history = history.slice(-MAX_ENTRIES);
  await setHistory(history);
  return history;
}

async function loadHistory() {
  return getHistory();
}

module.exports = { appendSnapshot, loadHistory, buildSnapshot };
