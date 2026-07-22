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

async function fetchAllIssuesBasic(cfg) {
  const issues = [];
  let nextPageToken;
  const maxResults = 100;

  for (;;) {
    const body = {
      jql: `project = ${cfg.projectKey} ORDER BY updated DESC`,
      maxResults,
      fields: FIELDS,
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
    issues.push(...data.issues);
    if (!data.nextPageToken || data.issues.length === 0) break;
    nextPageToken = data.nextPageToken;
  }

  return issues;
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

function computeTat(history) {
  const startEvent = history.find(
    (h) => h.field === 'status' && h.from === 'Upcoming' && h.to === 'Req. Gathering'
  );
  if (!startEvent) {
    return { tatStartDate: null, tatEndDate: null, tatDays: null, tatStatus: 'not_started' };
  }
  const startDate = new Date(startEvent.created);
  const endEvent = history.find(
    (h) => h.field === 'status' && h.to === 'Solutions Draft Shared' && new Date(h.created) >= startDate
  );
  if (!endEvent) {
    const days = Math.floor((Date.now() - startDate.getTime()) / 86400000);
    return { tatStartDate: startEvent.created, tatEndDate: null, tatDays: days, tatStatus: 'in_progress' };
  }
  const endDate = new Date(endEvent.created);
  const days = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000);
  return { tatStartDate: startEvent.created, tatEndDate: endEvent.created, tatDays: days, tatStatus: 'completed' };
}

function transformIssue(raw, history, domain) {
  const f = raw.fields;
  const tat = computeTat(history);
  return {
    key: raw.key,
    summary: f.summary,
    status: f.status?.name ?? null,
    statusCategory: f.status?.statusCategory?.name ?? null,
    issueType: f.issuetype?.name ?? null,
    priority: f.priority?.name ?? null,
    assignee: pickValue(f.assignee),
    reporter: pickValue(f.reporter),
    kam: pickValue(f.customfield_10330),
    modules: pickValue(f.customfield_11022) || [],
    shipmentVolume: f.customfield_11025 ?? null,
    expectedSalesClosure: f.customfield_11027 ?? null,
    requestCategory: pickValue(f.customfield_11056),
    expectedClosureWeeks: pickValue(f.customfield_13058),
    solutioningStartDate: f.customfield_10566 ?? null,
    sowConfirmationDate: f.customfield_11187 ?? null,
    sowSendDate: f.customfield_11303 ?? null,
    mrr: parseMrr(f.customfield_10443),
    stageGroup: stageGroup(f.status?.name ?? null),
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
      jql: `project = ${cfg.projectKey} ORDER BY updated DESC`,
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

  const issues = raw.map((r) => {
    const history = fullByKey[r.key] || flattenHistories(r.changelog ? r.changelog.histories : []);
    return transformIssue(r, history, cfg.domain);
  });
  issues.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  return { issues, total: raw.length, fullChangelogFetches: truncated.length };
}

module.exports = {
  getConfig,
  fetchLive,
  fetchAllIssuesBasic,
  fetchChangelog,
  flattenHistories,
  transformIssue,
  computeTat,
  parseMrr,
  isMrrMissing,
  stageGroup,
  PSE_LIST,
};
