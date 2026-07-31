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
  // Extra fields surfaced on the Jira Update Check tab (field-completeness view)
  'customfield_12210', // Shipment Type
  'customfield_11024', // Region of Use
  'customfield_10436', // Process Flow Documents (textarea / rich text)
  'customfield_10535', // Scope of Work
  'customfield_11123', // Solutioning Team Priority
  'customfield_10824', // Company Size
  'customfield_10825', // Project Complexity
  'customfield_10826', // Client Rank
  'customfield_11122', // SoW Sign-Off Date
  'customfield_11121', // Commercial Sign-Off Date (deal close date)
];

// Only "Project Card" is a real deal on the PSV Kanban board — Epics/Tasks/
// Stories/Sub-tasks live in the same Jira project but aren't deals and were
// previously (incorrectly) being counted in every total.
const ISSUE_TYPE = 'Project Card';

// The board displays Jira status "Internal Sign-off" under the Kanban column
// label "Solution Design". Per team request the friendlier column label is
// used everywhere on the dashboard, so we rename it at the data layer — every
// consumer (filters, tabs, activity log) then sees "Solution Design".
const STATUS_DISPLAY = { 'Internal Sign-off': 'Solution Design' };
function displayStatus(s) {
  return (s && STATUS_DISPLAY[s]) || s;
}

// The 6 statuses that count as "still open, not yet closed" for the Active
// Pipeline tab (post-rename names).
const ACTIVE_PIPELINE_STATUSES = [
  'Req. Gathering',
  'Solution Design',
  'Pending On Client',
  'Solutions Draft Shared',
  'COMMERCIALS',
  'Solutioning (Post closure)',
];

// TAT tab: only these statuses count toward active TAT (Q1 FY26-27). Everything
// else on the board (Commercial, GoLive, Churn, Won, Under Deployment, etc.) is
// excluded from TAT entirely. "Solutioning (Post closure)" is tracked, but in
// its own separate table — not in the active-TAT totals or health bands.
const TAT_ACTIVE_STATUSES = ['Req. Gathering', 'Solution Design', 'Pending On Client', 'Solutions Draft Shared'];
const TAT_POST_CLOSURE_STATUS = 'Solutioning (Post closure)';

// Post-solutioning / already-closed statuses the team doesn't track on the live
// dashboard — dropped globally at the data layer (like won/churn/In Progress).
const EXCLUDED_CLOSED_STATUSES = ['Partial Refrenceable', 'First Value', 'Under Deployment', 'First Phase Live'];

// Won/closed deals for the wins tab. NOTE: several PSV *board columns* are
// labelled differently from their underlying Jira status — verified against
// /rest/agile/1.0/board/76/configuration:
//   board "GoLive"                -> status "Completed"
//   board "Ongoing Implementation"-> status "In Progress"
//   board "Contract Won"          -> status "Closure/Contract Won"
//   board "Final GoLive"          -> status "Final Golive"  (lowercase L)
// These are the REAL status names; WON_STATUS_LABEL (app.js) maps them back
// to the friendlier board labels for display.
const WON_STATUSES = [
  'Closure/Contract Won',
  'Solutioning (Post closure)',
  'In Progress',
  'Completed',
  'Under Deployment',
  'First Phase Live',
  'First Value',
  'Final Refrenceable',
  'Partial Refrenceable',
  'Partial GoLive',
  'Final Golive',
];

// Statuses shown on the "Jira Update Check" field-completeness tab. This tab
// intentionally reaches beyond the live-dashboard exclusions (it includes won /
// churn / check-in cards) so process-sanity checks cover the full lifecycle.
// Names are post-rename (Internal Sign-off -> Solution Design).
const UPDATE_CHECK_STATUSES = [
  'Upcoming',
  'Req. Gathering',
  'Solution Design',
  'Pending On Client',
  'Solutions Draft Shared',
  'COMMERCIALS',
  'Closure/Contract Won',
  'Solutioning (Post closure)',
  'Check in 3 Months',
  'Churn/Check in 3 Months',
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

// Recursively pull plain text out of an Atlassian Document Format (ADF) node —
// used for rich-text custom fields (textarea), which the v3 API returns as ADF
// objects rather than strings.
function adfText(node) {
  if (!node || typeof node !== 'object') return '';
  let out = '';
  if (node.type === 'text' && node.text) out += node.text;
  if (Array.isArray(node.content)) out += node.content.map(adfText).join(node.type === 'paragraph' ? '' : ' ');
  return out;
}

// Collect any URLs from an ADF node (link marks + inline/block cards) and from
// plain text, so a Process-Flow / SoW field that contains a link is clickable.
function collectLinks(node, urls) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.marks)) node.marks.forEach((m) => { if (m.type === 'link' && m.attrs?.href) urls.add(m.attrs.href); });
  if ((node.type === 'inlineCard' || node.type === 'blockCard') && node.attrs?.url) urls.add(node.attrs.url);
  if (Array.isArray(node.content)) node.content.forEach((c) => collectLinks(c, urls));
}

// Normalizes a rich/plain custom field into { text, links[] }, or null when empty.
function richField(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let text = '';
  const urls = new Set();
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    text = adfText(raw).trim();
    collectLinks(raw, urls);
  }
  (text.match(/https?:\/\/[^\s)"']+/g) || []).forEach((u) => urls.add(u));
  if (!text && urls.size === 0) return null;
  return { text: text || null, links: [...urls] };
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
  const rawStatus = f.status?.name ?? null;
  const status = displayStatus(rawStatus); // apply the Solution Design rename everywhere
  const solutioningStartDate = f.customfield_10566 ?? null;
  const sowSendDate = f.customfield_11303 ?? null;
  const mrr = parseMrr(f.customfield_10443);
  // Hold-time calc keys off the raw "Pending On Client" status (unaffected by
  // the rename), so run it on the original history before we relabel it.
  const tat = computeTat({ created: f.created, currentStatus: rawStatus, solutioningStartDate, sowSendDate }, history);
  const isActivePipeline = isActivePipelineStatus(status);
  // Relabel status transitions in the changelog for display (activity log,
  // card timeline) so they read "Solution Design" too.
  const displayHistory = history.map((h) =>
    h.field === 'status' ? { ...h, from: displayStatus(h.from), to: displayStatus(h.to) } : h
  );

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
    // Extra fields for the Jira Update Check tab (field-completeness view)
    shipmentType: pickValue(f.customfield_12210) || [],
    regionOfUse: pickValue(f.customfield_11024) || [],
    shipmentVolumePerMonth: f.customfield_11025 ?? null,
    processFlowDoc: richField(f.customfield_10436),
    scopeOfWork: richField(f.customfield_10535),
    solPriority: pickValue(f.customfield_11123),
    companySize: pickValue(f.customfield_10824),
    projectComplexity: pickValue(f.customfield_10825),
    clientRank: pickValue(f.customfield_10826),
    sowSignOffDate: f.customfield_11122 ?? null,
    commercialSignOffDate: f.customfield_11121 ?? null,
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
    history: displayHistory,
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
  // Closed-out deals (stageGroup 'won' — Completed / Closure/Contract Won)
  // are dropped the same way: the dashboard is meant to reflect live,
  // in-progress work, not a historical archive of already-closed deals.
  // "In Progress" is also excluded — per the team, that status is a legacy
  // holdover and doesn't represent real active work; the 6 real active
  // pipeline statuses are tracked via ACTIVE_PIPELINE_STATUSES instead.
  // Churned deals (stageGroup 'churn' — e.g. "Churn/Check in 3 Months") are
  // excluded too: like won deals, they're already closed out, just as a loss
  // instead of a win, so they don't belong on a live working dashboard.
  // EXCLUDED_CLOSED_STATUSES (Partial Refrenceable, First Value, Under
  // Deployment, First Phase Live) are dropped for the same reason.
  const byUpdated = (a, b) => new Date(b.updated) - new Date(a.updated);
  const transformed = raw.map((r) => {
    const history = fullByKey[r.key] || flattenHistories(r.changelog ? r.changelog.histories : []);
    return transformIssue(r, history, cfg.domain);
  });
  const assigned = transformed.filter((i) => i.assignee);
  // Main dashboard set: excludes closed/won/churn/In-Progress cards.
  const issues = assigned
    .filter((i) => i.stageGroup !== 'won' && i.stageGroup !== 'churn' && i.status !== 'In Progress' && !EXCLUDED_CLOSED_STATUSES.includes(i.status))
    .sort(byUpdated);
  // allCards keeps the full assigned set (incl. won/churn/check-in) for the
  // Jira Update Check tab, which filters it to UPDATE_CHECK_STATUSES.
  const allCards = assigned.slice().sort(byUpdated);
  // Cards with no PSE are excluded everywhere by the long-standing
  // no-unassigned policy, but the wins tab surfaces them under an
  // "Unassigned" group so a won deal is never invisible.
  const unassignedCards = transformed.filter((i) => !i.assignee).sort(byUpdated);
  return { issues, allCards, unassignedCards, total: raw.length, excluded: raw.length - issues.length, fullChangelogFetches: truncated.length };
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
  displayStatus,
  PSE_LIST,
  ACTIVE_PIPELINE_STATUSES,
  TAT_ACTIVE_STATUSES,
  TAT_POST_CLOSURE_STATUS,
  UPDATE_CHECK_STATUSES,
  WON_STATUSES,
  QUARTER_START,
  LARGE_DEAL_ARR_THRESHOLD,
  PENDING_ON_CLIENT_STATUS,
};
