// Shared Jira REST API client: fetches PSV issues + changelogs and computes TAT.
const PSE_LIST = [
  'Ankith Prabhu',
  'Apoorv Gokhale',
  'Avani Khandelwal',
  'Dhananjay Venkatesh',
  'Karan Charkha',
  'surabhi.kumari',
  'Utkarsh Agrawal',
];

const FIELDS = [
  'summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter',
  'created', 'updated', 'duedate',
  'customfield_10330', // KAM
  'customfield_10631', // Sales Representative
  'customfield_11022', // List of Modules
  'customfield_11025', // Shipment Volume per Month
  'customfield_11027', // Expected Sales Closure
  'customfield_11056', // Request Category
  'customfield_13058', // Expected closure in weeks
  'customfield_10566', // Solutioning Start Date
  'customfield_11187', // SoW Confirmation Date
  'customfield_11303', // SoW Send Date
  'customfield_10443', // MRR (USD)
];

// Only "Project Card" is a real deal on the PSV Kanban board — Epics/Tasks/
// Stories/Sub-tasks live in the same Jira project but aren't deals and were
// previously (incorrectly) being counted in every total.
const ISSUE_TYPE = 'Project Card';

// The 6 statuses that count as "still open, not yet closed" for the Active
// Pipeline tab. Note: the board displays status id 10526 under the column
// label "Solution Design", but its real Jira status name is "Internal
// Sign-off" — verified directly against live cards (PSV-561, PSV-414, PSV-541).
const ACTIVE_PIPELINE_STATUSES = [
  'Req. Gathering',
  'Internal Sign-off',
  'Pending On Client',
  'Solutions Draft Shared',
  'COMMERCIALS',
  'Solutioning (Post closure)',
];

// Current active quarter start — deals whose Solutioning Start Date is before
// this but are still open get red-flagged as pre-quarter holdovers.
const QUARTER_START = '2026-05-01';

const LARGE_DEAL_ARR_THRESHOLD = 100000;

function isActivePipelineStatus(status) {
  return ACTIVE_PIPELINE_STATUSES.includes(status);
}

function computeArr(mrr) {
  return isMrrMissing(mrr) ? null : mrr * 12;
}

// 'large' if ARR > $100k, 'small' otherwise — null when MRR isn't set, since
// deal size can't be judged without it.
function dealSizeTag(mrr) {
  const arr = computeArr(mrr);
  if (arr == null) return null;
  return arr > LARGE_DEAL_ARR_THRESHOLD ? 'large' : 'small';
}

function getConfig() {
  const cfg = {
    domain: process.env.JIRA_DOMAIN,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_API_TOKEN,
    projectKey: process.env.JIRA_PROJECT_KEY || 'PSV',
  };
  if (!cfg.domain || !cfg.email || !cfg.token) {
    throw new Error('Missing JIRA_DOMAIN, JIRA_EMAIL, or JIRA_API_TOKEN in .env');
  }
  return cfg;
}

function authHeader(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
}

async function fetchChangelog(cfg, key) {
  const history = [];
  let startAt = 0;
  const maxResults = 100;

  for (;;) {
    const res = await fetch(
      `https://${cfg.domain}/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=${maxResults}`,
      { headers: { Authorization: authHeader(cfg), Accept: 'application/json' } }
    );
    if (!res.ok) throw new Error(`Jira changelog error ${res.status} for ${key}: ${await res.text()}`);

    const data = await res.json();
    for (const entry of data.values) {
      for (const item of entry.items) {
        history.push({
          id: entry.id,
          author: entry.author?.displayName || null,
          created: entry.created,
          field: item.field,
          from: item.fromString,
          to: item.toString,
        });
      }
    }
    if (data.isLast || data.values.length === 0) break;
    startAt += maxResults;
  }

  history.sort((a, b) => new Date(a.created) - new Date(b.created));
  return history;
}

// Converts the inline changelog format (issue.changelog.histories, returned by
// the bulk search when expand:'changelog' is set) into the same flat, ascending
// shape fetchChangelog() produces.
function flattenHistories(histories = []) {
  const flat = [];
  for (const entry of histories) {
    for (const item of entry.items) {
      flat.push({
        id: entry.id,
        author: entry.author?.displayName || null,
        created: entry.created,
        field: item.field,
        from: item.fromString,
        to: item.toString,
      });
    }
  }
  flat.sort((a, b) => new Date(a.created) - new Date(b.created));
  return flat;
}

function pickValue(field) {
  if (field === null || field === undefined) return null;
  if (Array.isArray(field)) return field.map(pickValue);
  if (typeof field === 'object') {
    if ('displayName' in field) return field.displayName;
    if ('value' in field) return field.value;
    if ('name' in field) return field.name;
  }
  return field;
}

function parseMrr(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseFloat(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// MRR is considered "not filled in" when it's blank, or left at the placeholder 0/1.
function isMrrMissing(mrr) {
  return mrr === null || mrr === 0 || mrr === 1;
}

// Buckets a status into a stage group for win/churn reporting. Jira's own
// statusCategory is almost entirely "In Progress" for this board, so we
// classify by status name instead.
function stageGroup(status) {
  if (!status) return 'active';
  if (status === 'Completed' || status === 'Closure/Contract Won') return 'won';
  if (/churn/i.test(status)) return 'churn';
  if (/reject/i.test(status)) return 'rejected';
  if (/check in 3 months/i.test(status)) return 'cold';
  return 'active';
}

const PENDING_ON_CLIENT_STATUS = 'Pending On Client';

// TAT = Solutioning Start Date -> SoW Send Date, EXCLUDING any time the card
// spent in "Pending On Client" during that window (client-side hold time
// shouldn't count against the PSE). Reconstructs status segments from the
// changelog to find exactly how long each Pending-On-Client stretch lasted and
// how much of it overlapped the TAT window.
function computeTat({ created, currentStatus, solutioningStartDate, sowSendDate }, history) {
  if (!solutioningStartDate) {
    return { tatStartDate: null, tatEndDate: null, tatDays: null, tatHoldDays: 0, tatStatus: 'not_started' };
  }

  const start = new Date(solutioningStartDate);
  const end = sowSendDate ? new Date(sowSendDate) : new Date();
  const tatStatus = sowSendDate ? 'completed' : 'in_progress';

  const statusChanges = history
    .filter((h) => h.field === 'status')
    .slice()
    .sort((a, b) => new Date(a.created) - new Date(b.created));

  const segments = [];
  let segStart = created ? new Date(created) : start;
  let segStatus = statusChanges.length ? statusChanges[0].from : currentStatus;
  for (const change of statusChanges) {
    const t = new Date(change.created);
    segments.push({ from: segStart, to: t, status: segStatus });
    segStart = t;
    segStatus = change.to;
  }
  segments.push({ from: segStart, to: new Date(), status: segStatus });

  let holdMs = 0;
  for (const seg of segments) {
    if (seg.status !== PENDING_ON_CLIENT_STATUS) continue;
    const overlapStart = seg.from > start ? seg.from : start;
    const overlapEnd = seg.to < end ? seg.to : end;
    if (overlapEnd > overlapStart) holdMs += overlapEnd.getTime() - overlapStart.getTime();
  }

  const totalMs = Math.max(0, end.getTime() - start.getTime());
  const netMs = Math.max(0, totalMs - holdMs);

  return {
    tatStartDate: solutioningStartDate,
    tatEndDate: sowSendDate || null,
    tatDays: Math.round(netMs / 86400000),
    tatHoldDays: Math.round(holdMs / 86400000),
    tatStatus,
  };
}

function transformIssue(raw, history, domain) {
  const f = raw.fields;
  const status = f.status?.name ?? null;
  const solutioningStartDate = f.customfield_10566 ?? null;
  const sowSendDate = f.customfield_11303 ?? null;
  const mrr = parseMrr(f.customfield_10443);
  const tat = computeTat({ created: f.created, currentStatus: status, solutioningStartDate, sowSendDate }, history);
  const isActivePipeline = isActivePipelineStatus(status);

  return {
    key: raw.key,
    summary: f.summary,
    status,
    statusCategory: f.status?.statusCategory?.name ?? null,
    issueType: f.issuetype?.name ?? null,
    priority: f.priority?.name ?? null,
    assignee: pickValue(f.assignee),
    reporter: pickValue(f.reporter),
    kam: pickValue(f.customfield_10330),
    salesRep: pickValue(f.customfield_10631),
    modules: pickValue(f.customfield_11022) || [],
    shipmentVolume: f.customfield_11025 ?? null,
    expectedSalesClosure: f.customfield_11027 ?? null,
    requestCategory: pickValue(f.customfield_11056),
    expectedClosureWeeks: pickValue(f.customfield_13058),
    solutioningStartDate,
    sowConfirmationDate: f.customfield_11187 ?? null,
    sowSendDate,
    mrr,
    arr: computeArr(mrr),
    dealSize: dealSizeTag(mrr),
    stageGroup: stageGroup(status),
    isActivePipeline,
    isPreQuarterHoldover: isActivePipeline && !!solutioningStartDate && solutioningStartDate < QUARTER_START,
    created: f.created,
    updated: f.updated,
    dueDate: f.duedate ?? null,
    url: `https://${domain}/browse/${raw.key}`,
    ...tat,
    history,
  };
}

// Fetches the whole board live in one shot: a paginated bulk search with the
// changelog expanded inline (~5 API calls for the whole project). The inline
// changelog is capped at the 40 most-recent entries per issue, which drops the
// OLDEST transitions — exactly the ones TAT depends on — so for any issue whose
// changelog was truncated we fetch its full changelog individually (concurrency
// limited). In practice that's only a few dozen active cards, keeping a complete
// live pull to well under 10s.
async function fetchLive(cfg, concurrency = 8) {
  const raw = [];
  let nextPageToken;

  for (;;) {
    const body = {
      jql: `project = ${cfg.projectKey} AND issuetype = "${ISSUE_TYPE}" ORDER BY updated DESC`,
      maxResults: 100,
      fields: FIELDS,
      expand: 'changelog',
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await fetch(`https://${cfg.domain}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(cfg),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jira search error ${res.status}: ${await res.text()}`);

    const data = await res.json();
    raw.push(...data.issues);
    if (!data.nextPageToken || data.issues.length === 0) break;
    nextPageToken = data.nextPageToken;
  }

  const truncated = raw.filter((i) => i.changelog && i.changelog.histories.length < i.changelog.total);
  const fullByKey = {};
  const queue = truncated.slice();
  async function worker() {
    while (queue.length) {
      const it = queue.shift();
      fullByKey[it.key] = await fetchChangelog(cfg, it.key);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  // No-unassigned policy: unassigned cards aren't attributable to a PSE, so
  // they're dropped here, once, rather than every consumer having to remember.
  const issues = raw
    .map((r) => {
      const history = fullByKey[r.key] || flattenHistories(r.changelog ? r.changelog.histories : []);
      return transformIssue(r, history, cfg.domain);
    })
    .filter((i) => i.assignee);
  issues.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  return { issues, total: raw.length, unassignedExcluded: raw.length - issues.length, fullChangelogFetches: truncated.length };
}

module.exports = {
  getConfig,
  fetchLive,
  fetchChangelog,
  flattenHistories,
  transformIssue,
  computeTat,
  parseMrr,
  isMrrMissing,
  stageGroup,
  computeArr,
  dealSizeTag,
  isActivePipelineStatus,
  PSE_LIST,
  ACTIVE_PIPELINE_STATUSES,
  QUARTER_START,
  LARGE_DEAL_ARR_THRESHOLD,
  PENDING_ON_CLIENT_STATUS,
};
