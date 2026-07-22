// Appends one snapshot per calendar day (IST) so the dashboard can show trends
// over time. Re-running on the same day overwrites that day's entry rather
// than duplicating it, so both the 5-min live poller and the daily scheduled
// refresh can safely call this.
const fs = require('fs');
const path = require('path');
const { isMrrMissing } = require('./jira');

const HISTORY_PATH = path.join(__dirname, '..', 'public', 'data', 'history.json');
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

function appendSnapshot(issues) {
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    } catch {
      history = [];
    }
  }
  const snapshot = buildSnapshot(issues);
  const idx = history.findIndex((h) => h.date === snapshot.date);
  if (idx >= 0) history[idx] = snapshot;
  else history.push(snapshot);

  history = history.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  return history;
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    return [];
  }
}

module.exports = { appendSnapshot, loadHistory, buildSnapshot };
