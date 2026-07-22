// One-shot refresh: pulls PSV issues + changelogs, writes public/data/psv-data.json.
// Used by the daily scheduled task and for manual `npm run fetch-data` runs.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getConfig, reconcile } = require('../lib/jira');
const { appendSnapshot } = require('../lib/history');

const OUT_PATH = path.join(__dirname, '..', 'public', 'data', 'psv-data.json');

(async () => {
  const cfg = getConfig();

  let previous = {};
  if (fs.existsSync(OUT_PATH)) {
    const prevData = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    previous = Object.fromEntries(prevData.issues.map((i) => [i.key, i]));
  }

  console.log(`Fetching ${cfg.projectKey} issues from ${cfg.domain}...`);
  const { issues, changelogFetches, total } = await reconcile(cfg, previous);
  console.log(`Fetched ${total} issues, refreshed changelogs for ${changelogFetches}.`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), count: issues.length, issues }, null, 2)
  );
  console.log(`Wrote ${issues.length} issues to ${OUT_PATH}`);

  await appendSnapshot(issues);
  console.log('Appended daily history snapshot.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
