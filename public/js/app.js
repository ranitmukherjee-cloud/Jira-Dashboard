// PSV Dashboard — vanilla JS SPA. All data comes live from /api/data (backed by Jira).
const QUARTER_START = '2026-05-01';
const TRACKER_PSE_ROWS = ['Ankith', 'Apoorv', 'Avani', 'Dhananjay', 'Karan', 'Ranit', 'Surabhi', 'Utkarsh'];

// A fresh universal-filter bucket. Each tab that uses the shared sidebar keeps
// its OWN bucket (see STATE.tabFilters), so a PSE/status/etc. selection on one
// tab never leaks into another — filters are per-tab, not global.
function makeUniversalFilters() {
  return {
    search: '',
    pse: new Set(),
    status: new Set(),
    modules: new Set(),
    kam: new Set(),
    salesRep: new Set(),
    requestCategory: new Set(),
    tat: '',
    dealSize: '',
    startFrom: '',
    startTo: '',
    currentQuarterOnly: false,
  };
}

// Tabs that share the universal filter sidebar; each gets an independent bucket.
const UNIVERSAL_FILTER_TABS = ['overview', 'pipeline', 'mrr', 'closing', 'c3m', 'team'];

const STATE = {
  data: { generatedAt: null, count: 0, issues: [] },
  history: [],
  options: { pse: [], status: [], modules: [], kam: [], salesRep: [], requestCategory: [] },
  tabFilters: {},
  activityFilters: { pse: new Set(), status: new Set(), dealName: '', dateFrom: '', dateTo: '' },
  trackerFilters: { pse: new Set(), status: new Set(), helpInSow: '', flagApoorv: '', dateFrom: '', dateTo: '', dealName: '' },
  trackerLeave: {},
  trackerHolidays: {},
  tatFilters: { pse: new Set(), status: new Set(), health: new Set(), kam: new Set(), salesRep: new Set(), dealSize: '', search: '' },
  tatBox: 'all',
  tatSort: {}, // per-table sort state: { fy2627:{key,dir}, fy2526:{...}, poc:{...} }
  overviewCards: [],
  ovFilters: { pse: new Set(), kam: new Set(), salesRep: new Set(), quarter: 'All', search: '' },
  ovSegment: 'all', // which segment the detail table shows
  ovDetailPse: 'All', // PSE filter local to the Deal Detail table only
  ovDetailSort: { key: 'mrr', dir: 'desc' }, // Deal Detail table's own column sort
  winCards: [],
  winFilters: { pse: new Set(), status: new Set(), search: '' },
  winStatFilter: { fy: 'All', q: 'All' }, // scoreboard toggles
  winTableQuarter: {}, // per-FY-table quarter chip, e.g. { 'FY 26-27': 'Q1' }
  updateCards: [],
  updateFilters: { pse: new Set(), status: new Set(), kam: new Set(), salesRep: new Set(), requestCategory: new Set(), completeness: 'all', sections: new Set(), missingField: '', search: '' },
  quickLinksSearch: '', // free-text filter, scoped to the Quick Links tab only
  updateCollapsed: new Set(), // PSE panels collapsed on the Jira Update Check tab
  ucSectionCollapsed: new Set(), // section columns (discovery/solutioning/details) collapsed
  ucStatsCollapsed: false, // the top stat-boxes section on Jira Update Check
  route: { name: 'overview', param: null },
  adhoc: null,
  charts: [],
};

UNIVERSAL_FILTER_TABS.forEach((t) => { STATE.tabFilters[t] = makeUniversalFilters(); });

// Drill-down views (status/segment/list) are launched from Overview, so they
// share Overview's bucket; anything else falls back to Overview too.
function filterKeyForRoute(name) {
  if (['status', 'segment', 'list'].includes(name)) return 'overview';
  return UNIVERSAL_FILTER_TABS.includes(name) ? name : 'overview';
}

// STATE.filters transparently resolves to the CURRENT tab's bucket, so every
// existing `STATE.filters.*` read/write is automatically scoped per tab.
Object.defineProperty(STATE, 'filters', {
  get() { return STATE.tabFilters[filterKeyForRoute(STATE.route.name)]; },
  configurable: true,
});

const CAT_COLOR = { Done: '#12B76A', 'In Progress': '#0054FC', 'To Do': '#94A3B8', New: '#94A3B8' };
const POLL_MS = 60 * 1000;
// Jira Update Check and Wins & Milestones each do their own fetch and rebuild
// a whole page of tables on every refresh — much heavier than the other tabs —
// so they run on their own slower cadence instead of riding the main 60s poll.
// Manual "Refresh now" still updates them immediately regardless of this timer.
// Per-route auto-refresh intervals. Overview is the heaviest read (one big
// pull feeding four segments) and is a standing exec view rather than
// something people edit, so it refreshes far less often.
const SLOW_POLL_ROUTES = {
  update: { ms: 3 * 60 * 1000, run: () => renderUpdateCheck() },
  team: { ms: 3 * 60 * 1000, run: () => renderTeam() },
  overview: { ms: 15 * 60 * 1000, run: () => renderOverview() },
};
const SLOW_POLL_TICK_MS = 30 * 1000; // how often we check whether one is due
const slowPollLastRun = {};
// Restart a tab's clock — on landing there, and on a manual refresh — so the
// interval always counts from the last time the user actually saw fresh data.
function markSlowPollFresh(routeName) {
  if (SLOW_POLL_ROUTES[routeName]) slowPollLastRun[routeName] = Date.now();
}

// ---------- data ----------
async function loadData() {
  const res = await fetch('/api/data', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  STATE.data = data;
  STATE.options = {
    pse: distinct(data.issues.map((i) => i.assignee)),
    status: distinct(data.issues.map((i) => i.status)),
    modules: distinct(data.issues.flatMap((i) => i.modules || [])),
    kam: distinct(data.issues.map((i) => i.kam)),
    salesRep: distinct(data.issues.map((i) => i.salesRep)),
    requestCategory: distinct(data.issues.map((i) => i.requestCategory)),
  };
  updateHeader(data);
  renderSidebar();

  try {
    const hRes = await fetch('/api/history', { cache: 'no-store' });
    if (hRes.ok) STATE.history = await hRes.json();
  } catch {
    // history is a nice-to-have; ignore failures
  }
}

function distinct(arr) {
  return [...new Set(arr.filter(Boolean))].sort();
}

function updateHeader(data) {
  const el = document.getElementById('lastRefreshed');
  const live = document.getElementById('liveIndicator');
  if (!data.generatedAt) {
    el.textContent = 'No data yet';
    return;
  }
  const dt = new Date(data.generatedAt);
  el.textContent = `${data.count} cards · refreshed ${fmtDdMmYyyyTime(dt)} IST`;
  const ageMin = (Date.now() - dt.getTime()) / 60000;
  if (ageMin > 20) {
    live.classList.add('stale');
    live.innerHTML = '<span class="ldot"></span>Stale';
  } else {
    live.classList.remove('stale');
    live.innerHTML = '<span class="ldot"></span>Live';
  }
}

// ---------- filtering ----------
function matchesTat(issue, bucket) {
  if (!bucket) return true;
  if (bucket === 'not_started') return issue.tatStatus === 'not_started';
  if (bucket === 'in_progress') return issue.tatStatus === 'in_progress';
  if (bucket === 'completed') return issue.tatStatus === 'completed';
  if (issue.tatDays == null) return false;
  if (bucket === '0-7') return issue.tatDays <= 7;
  if (bucket === '8-15') return issue.tatDays >= 8 && issue.tatDays <= 15;
  if (bucket === '16-30') return issue.tatDays >= 16 && issue.tatDays <= 30;
  if (bucket === '31+') return issue.tatDays >= 31;
  return true;
}

function applyFilters(issues, { skipStatus = false } = {}) {
  const f = STATE.filters;
  const search = f.search.trim().toLowerCase();
  return issues.filter((i) => {
    if (f.pse.size && !f.pse.has(i.assignee)) return false;
    if (!skipStatus && f.status.size && !f.status.has(i.status)) return false;
    if (f.modules.size && !(i.modules || []).some((m) => f.modules.has(m))) return false;
    if (f.kam.size && !f.kam.has(i.kam)) return false;
    if (f.salesRep.size && !f.salesRep.has(i.salesRep)) return false;
    if (f.requestCategory.size && !f.requestCategory.has(i.requestCategory)) return false;
    if (!matchesTat(i, f.tat)) return false;
    if (f.dealSize && i.dealSize !== f.dealSize) return false;
    if (f.startFrom && (!i.solutioningStartDate || i.solutioningStartDate < f.startFrom)) return false;
    if (f.startTo && (!i.solutioningStartDate || i.solutioningStartDate > f.startTo)) return false;
    if (f.currentQuarterOnly && (!i.solutioningStartDate || i.solutioningStartDate < QUARTER_START)) return false;
    if (search) {
      const hay = `${i.key} ${i.summary} ${i.assignee || ''} ${i.kam || ''} ${i.salesRep || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

// ---------- router ----------
function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, param] = hash.split('/');
  if (name === 'status' && param) return { name: 'status', param: decodeURIComponent(param) };
  if (name === 'segment' && param) return { name: 'segment', param: decodeURIComponent(param) };
  if (['activity', 'mrr', 'closing', 'tat', 'team', 'pipeline', 'c3m', 'tracker', 'list', 'links', 'update'].includes(name)) {
    return { name, param: null };
  }
  return { name: 'overview', param: null };
}

function navigate(hash) {
  location.hash = hash;
}

// The search box's value depends on which tab is active — like the other
// per-tab filters, each tab's search term persists in its own bucket, so
// switching tabs should show that tab's own term rather than the one just typed.
function currentTabSearchValue() {
  const route = STATE.route.name;
  if (SIDEBAR_SEARCH_ROUTES.includes(route)) return STATE.filters.search;
  if (route === 'overview' || ['status', 'segment', 'list'].includes(route)) return STATE.ovFilters.search;
  if (route === 'team') return STATE.winFilters.search;
  if (route === 'tat') return STATE.tatFilters.search;
  if (route === 'update') return STATE.updateFilters.search;
  if (route === 'tracker') return STATE.trackerFilters.dealName;
  if (route === 'links') return STATE.quickLinksSearch;
  if (route === 'activity') return STATE.activityFilters.dealName;
  return '';
}

window.addEventListener('hashchange', () => {
  STATE.route = parseRoute();
  markSlowPollFresh(STATE.route.name); // landing on a tab restarts its refresh clock
  const searchBox = document.getElementById('globalSearchInput');
  if (searchBox) searchBox.value = currentTabSearchValue();
  const hint = document.getElementById('globalSearchHint');
  if (hint) hint.classList.remove('show');
  render();
});

// ---------- shared render helpers ----------
function fbadge(status) {
  const cat = STATE.data.issues.find((i) => i.status === status)?.statusCategory;
  const cls = cat === 'Done' ? 'bg' : cat === 'In Progress' ? 'bb' : 'bgy';
  return `<span class="bd ${cls}">${status || '—'}</span>`;
}

// Great <=15d, Mid <=30d, Watch <=60d, Flagged >60d (2 months) — per PSE guidance.
function tatSeverity(days) {
  if (days == null) return null;
  if (days <= 15) return 'great';
  if (days <= 30) return 'mid';
  if (days <= 60) return 'watch';
  return 'flagged';
}

const TAT_SEVERITY_META = {
  great: { cls: 'bg', label: 'Great' },
  mid: { cls: 'bb', label: 'Mid' },
  watch: { cls: 'ba', label: 'Watch' },
  flagged: { cls: 'br', label: 'Flagged' },
};

function tatSeverityBadge(days) {
  if (days == null) return '—';
  const meta = TAT_SEVERITY_META[tatSeverity(days)];
  return `<span class="bd ${meta.cls}">${meta.label} · ${days}d</span>`;
}

// TAT tab health bands (active deals only): Good ≤30, Mid 31–60, Review ≥61.
const TAT_ACTIVE_STATUSES = ['Req. Gathering', 'Solution Design', 'Pending On Client', 'Solutions Draft Shared'];
const TAT_POST_CLOSURE_STATUS = 'Solutioning (Post closure)';
const PENDING_ON_CLIENT = 'Pending On Client';

function tatHealth(days) {
  if (days == null) return null;
  if (days <= 30) return 'good';
  if (days <= 60) return 'mid';
  return 'review';
}
const TAT_HEALTH_META = {
  good: { label: 'Good', cls: 'bg', color: '#12B76A' },
  mid: { label: 'Mid', cls: 'ba', color: '#D97706' },
  review: { label: 'Review', cls: 'br', color: '#DC2626' },
};
function tatHealthBadge(days) {
  const h = tatHealth(days);
  if (!h) return '<span class="bd bgy">—</span>';
  const m = TAT_HEALTH_META[h];
  return `<span class="bd ${m.cls}">${days}d · ${m.label}</span>`;
}

function avg(nums) {
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
}

function tatLabel(issue) {
  if (issue.tatStatus === 'not_started') return '<span class="bd bgy">Not started</span>';
  if (issue.tatStatus === 'in_progress') return `<span class="bd bb">${issue.tatDays}d (running)</span>`;
  if (issue.tatStatus === 'completed') return `<span class="bd bg">${issue.tatDays}d</span>`;
  return '—';
}

function modulePills(mods) {
  if (!mods || !mods.length) return '<span style="color:var(--t3);font-size:11px;font-style:italic">none</span>';
  return mods.map((m) => `<span class="mod-pill">${m}</span>`).join('');
}

function dealSizeBadge(size) {
  if (!size) return '—';
  return size === 'large' ? '<span class="bd bpu">Large</span>' : '<span class="bd bgy">Small</span>';
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function fmtUsd(n) {
  if (n == null) return '—';
  return '$' + Math.round(n).toLocaleString('en-US');
}

// Every plain date column across every tab renders through this — explicit
// 2-digit day/month + numeric year guarantees DD/MM/YYYY everywhere,
// regardless of the browser/OS locale (which a bare toLocaleDateString call
// would otherwise be at the mercy of). Accepts a bare "YYYY-MM-DD" string, a
// full ISO timestamp, or a Date.
function fmtDdMmYyyy(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T00:00:00' : d);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Same DD/MM/YYYY date part, plus a time-of-day — for timestamp fields
// (Created, Last Updated, activity log entries) that need the clock time
// alongside the date, still in the IST timezone the team works in.
function fmtDdMmYyyyTime(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return null;
  const datePart = date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const timePart = date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  return `${datePart}, ${timePart}`;
}

function isMrrMissing(mrr) {
  return mrr === null || mrr === 0 || mrr === 1;
}

function jiraLinkCell(issue) {
  return `<a class="jira-link" href="${issue.url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open →</a>`;
}

// ---------- CSV export ----------
function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.value(r))).join(',')).join('\n');
  return header + '\n' + body;
}

function downloadCsv(filename, csvString) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- chart-click-through to a deal list ----------
// raw:true (used by the global search bar) skips the universal filters, so a
// search always finds a match regardless of whatever filters are active on
// whichever tab the user started from.
function goToFilteredList(title, predicate, { raw = false } = {}) {
  STATE.adhoc = { title, predicate, raw };
  navigate('/list');
}

// ---------- sidebar (all filters live here, persistent across every tab) ----------
const FACC_GROUPS = ['pse', 'status', 'kam', 'salesRep', 'modules', 'requestCategory'];
const FACC_DEFAULT_OPEN = { pse: true, status: true, kam: false, salesRep: false, modules: false, requestCategory: false };

function loadSidebarPrefs() {
  STATE.sidebarCollapsed = localStorage.getItem('psv_sidebar_collapsed') === '1';
  STATE.facc = {};
  FACC_GROUPS.forEach((g) => {
    const stored = localStorage.getItem('psv_facc_' + g);
    STATE.facc[g] = stored === null ? FACC_DEFAULT_OPEN[g] : stored === '1';
  });
}

// `labelFn` is optional — lets a tab display a friendlier label than the raw
// stored value (e.g. Jira board labels on the wins tab) without changing what
// gets filtered on. Defaults to showing the value itself.
function checkboxListHtml(id, options, selected, labelFn) {
  if (!options.length) return '<div class="empty" style="padding:8px;font-size:11px;">No data</div>';
  return `<div class="sf-opts">${options
    .map(
      (o) => `
      <label class="sf-opt">
        <input type="checkbox" data-mgroup="${id}" value="${escapeAttr(o)}" ${selected.has(o) ? 'checked' : ''}/>
        <span>${labelFn ? labelFn(o) : o}</span>
      </label>`
    )
    .join('')}</div>`;
}

function faccGroup(id, label, bodyHtml, badgeCount) {
  const open = STATE.facc[id];
  return `
    <div class="facc ${open ? 'open' : ''}" data-facc="${id}">
      <div class="facc-head" data-facc-toggle="${id}">
        <span class="facc-head-label">${label}${badgeCount ? `<span class="facc-badge">${badgeCount}</span>` : ''}</span>
        <span class="facc-chev">▸</span>
      </div>
      <div class="facc-body"><div class="facc-body-inner">${bodyHtml}</div></div>
    </div>`;
}

function renderSidebar() {
  if (!STATE.facc) loadSidebarPrefs();
  const f = STATE.filters;
  const sb = document.getElementById('sidebar');
  const activeCount =
    f.pse.size + f.status.size + f.kam.size + f.salesRep.size + f.modules.size + f.requestCategory.size +
    (f.tat ? 1 : 0) + (f.dealSize ? 1 : 0) + (f.startFrom ? 1 : 0) + (f.startTo ? 1 : 0) +
    (f.currentQuarterOnly ? 1 : 0) + (f.search.trim() ? 1 : 0);

  sb.classList.toggle('collapsed', STATE.sidebarCollapsed);
  sb.innerHTML = `
    <div class="sb-header">
      <div class="sb-title">Filters${activeCount ? `<span class="facc-badge">${activeCount}</span>` : ''}</div>
      <button class="sb-toggle" id="sidebarToggleBtn" title="${STATE.sidebarCollapsed ? 'Expand filters' : 'Collapse filters'}">${STATE.sidebarCollapsed ? '»' : '«'}</button>
    </div>
    <div class="sb-content" id="sidebarContent" style="display:${STATE.sidebarCollapsed ? 'none' : ''}">
      <div class="search-wrap">
        <span class="search-icon">⌕</span>
        <input class="fi search-input" id="searchInput" type="text" placeholder="Search client, PSV key, KAM…" value="${escapeAttr(f.search)}"/>
      </div>

      <div class="sfgroup-row">
        <div class="sfgroup-half">
          <label>TAT</label>
          <select class="fs" id="tatSelect">
            <option value="">All</option>
            <option value="not_started" ${f.tat === 'not_started' ? 'selected' : ''}>Not started</option>
            <option value="in_progress" ${f.tat === 'in_progress' ? 'selected' : ''}>In progress</option>
            <option value="completed" ${f.tat === 'completed' ? 'selected' : ''}>Completed</option>
            <option value="0-7" ${f.tat === '0-7' ? 'selected' : ''}>0–7 days</option>
            <option value="8-15" ${f.tat === '8-15' ? 'selected' : ''}>8–15 days</option>
            <option value="16-30" ${f.tat === '16-30' ? 'selected' : ''}>16–30 days</option>
            <option value="31+" ${f.tat === '31+' ? 'selected' : ''}>31+ days</option>
          </select>
        </div>
        <div class="sfgroup-half">
          <label>Deal Size</label>
          <select class="fs" id="dealSizeSelect">
            <option value="">All</option>
            <option value="large" ${f.dealSize === 'large' ? 'selected' : ''}>Large (&gt;$100k ARR)</option>
            <option value="small" ${f.dealSize === 'small' ? 'selected' : ''}>Small (&le;$100k ARR)</option>
          </select>
        </div>
      </div>

      ${faccGroup('pse', 'PSE', checkboxListHtml('pse', STATE.options.pse, f.pse), f.pse.size)}
      ${faccGroup('status', 'Status', checkboxListHtml('status', STATE.options.status, f.status), f.status.size)}
      ${faccGroup('kam', 'KAM', checkboxListHtml('kam', STATE.options.kam, f.kam), f.kam.size)}
      ${faccGroup('salesRep', 'Sales Representative', checkboxListHtml('salesRep', STATE.options.salesRep, f.salesRep), f.salesRep.size)}
      ${faccGroup('modules', 'List of Modules', checkboxListHtml('modules', STATE.options.modules, f.modules), f.modules.size)}
      ${faccGroup('requestCategory', 'Request Category', checkboxListHtml('requestCategory', STATE.options.requestCategory, f.requestCategory), f.requestCategory.size)}

      <div class="sfgroup">
        <label>Solutioning Start Date</label>
        <div class="sf-daterow">
          <input type="date" class="fi" id="startFromInput" value="${f.startFrom}"/>
          <input type="date" class="fi" id="startToInput" value="${f.startTo}"/>
        </div>
        <label class="sf-toggle"><input type="checkbox" id="quarterToggle" ${f.currentQuarterOnly ? 'checked' : ''}/> Current quarter only (from 1 May 2026)</label>
      </div>

      <button class="clear-btn-full" id="clearFiltersBtn">Clear all filters</button>
    </div>
  `;
  bindSidebarEvents();
}

function bindSidebarEvents() {
  document.getElementById('sidebarToggleBtn').addEventListener('click', () => {
    STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
    localStorage.setItem('psv_sidebar_collapsed', STATE.sidebarCollapsed ? '1' : '0');
    renderSidebar();
  });

  if (STATE.sidebarCollapsed) return; // nothing else is visible/interactive while collapsed

  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', () => {
    STATE.filters.search = searchInput.value;
    render();
  });

  document.getElementById('tatSelect').addEventListener('change', (e) => {
    STATE.filters.tat = e.target.value;
    render();
  });

  document.getElementById('dealSizeSelect').addEventListener('change', (e) => {
    STATE.filters.dealSize = e.target.value;
    render();
  });

  document.getElementById('startFromInput').addEventListener('change', (e) => {
    STATE.filters.startFrom = e.target.value;
    render();
  });

  document.getElementById('startToInput').addEventListener('change', (e) => {
    STATE.filters.startTo = e.target.value;
    render();
  });

  document.getElementById('quarterToggle').addEventListener('change', (e) => {
    STATE.filters.currentQuarterOnly = e.target.checked;
    render();
  });

  document.querySelectorAll('[data-facc-toggle]').forEach((head) => {
    head.addEventListener('click', () => {
      const id = head.dataset.faccToggle;
      STATE.facc[id] = !STATE.facc[id];
      localStorage.setItem('psv_facc_' + id, STATE.facc[id] ? '1' : '0');
      head.closest('.facc').classList.toggle('open', STATE.facc[id]);
    });
  });

  document.querySelectorAll('#sidebar [data-mgroup]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const group = cb.dataset.mgroup;
      const set = STATE.filters[group];
      if (cb.checked) set.add(cb.value);
      else set.delete(cb.value);
      render();
      // Re-render the sidebar so the "N selected" badges stay accurate.
      // STATE.facc already holds each accordion's open/closed state, so
      // faccGroup() re-applies it correctly rather than resetting anything.
      renderSidebar();
    });
  });

  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    // Reset only the current tab's bucket (STATE.filters is a read-only getter).
    STATE.tabFilters[filterKeyForRoute(STATE.route.name)] = makeUniversalFilters();
    renderSidebar();
    render();
  });
}

// ---------- charts ----------
function destroyCharts() {
  STATE.charts.forEach((c) => c.destroy());
  STATE.charts = [];
}

// Horizontal bar charts get a fixed pixel height regardless of category count,
// which makes Chart.js auto-skip labels ("Module Interest" with 12 modules
// only showed 6). Give the container's div height proportional to the
// category count, and force every label to render.
function hBarHeight(count) {
  return Math.max(180, count * 34) + 'px';
}

function addChart(canvasId, type, labels, datasets, extraOptions = {}, onBarClick) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    ...extraOptions,
  };
  if (extraOptions.indexAxis === 'y') {
    options.scales = { ...options.scales, y: { ...options.scales?.y, ticks: { autoSkip: false } } };
  }
  if (onBarClick) {
    options.onClick = (evt, elements) => {
      if (!elements.length) return;
      onBarClick(labels[elements[0].index], elements[0].datasetIndex);
    };
    options.onHover = (evt, elements) => {
      evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
    };
  }
  const chart = new Chart(el, { type, data: { labels, datasets }, options });
  STATE.charts.push(chart);
}

// ---------- overview (consolidated exec view) ----------
// One live pull covering four segments the CEO cares about: Active Pipeline,
// Won FY 26-27, Check in 3 Months and Churn. Built from its own endpoint
// because /api/data deliberately hides won and churn cards.
const OV_ACTIVE_STATUSES = ['Req. Gathering', 'Solution Design', 'Pending On Client', 'Solutions Draft Shared', 'COMMERCIALS', 'Solutioning (Post closure)'];
const OV_WON_STATUSES = ['Closure/Contract Won', 'Solutioning (Post closure)', 'In Progress', 'Completed', 'Under Deployment', 'First Phase Live', 'First Value', 'Final Refrenceable', 'Partial Refrenceable', 'Partial GoLive', 'Final Golive'];
const OV_CHURN_STATUSES = ['Churn', 'Churn/Check in 3 Months'];
const OV_CHECK_IN = 'Check in 3 Months';
const OV_FY = 'FY 26-27';

const OV_SEGMENTS = [
  { key: 'active', label: 'Active Pipeline', short: 'Active', color: '#3B5BFF', sub: 'Open & in motion' },
  { key: 'won', label: `Won ${OV_FY}`, short: 'Won', color: '#12B76A', sub: 'Closed / won this FY' },
  { key: 'c3m', label: 'Check in 3 Months', short: 'Check-in', color: '#D97706', sub: 'Parked, revisit later' },
  { key: 'churn', label: 'Churn', short: 'Churn', color: '#E11D48', sub: 'Lost deals' },
];
const OV_SEG_BY_KEY = Object.fromEntries(OV_SEGMENTS.map((s) => [s.key, s]));

// "Solutioning (Post closure)" is listed under BOTH active and won. Won is
// checked first, so a card that closed this FY counts once as Won and never
// double-counts into Active.
function ovSegmentOf(c) {
  if (OV_CHURN_STATUSES.includes(c.status)) return 'churn';
  if (c.status === OV_CHECK_IN) return 'c3m';
  if (OV_WON_STATUSES.includes(c.status) && c.commercialSignOffDate && fyOf(c.commercialSignOffDate) === OV_FY) return 'won';
  if (OV_ACTIVE_STATUSES.includes(c.status)) return 'active';
  return null; // won in an earlier FY — lives on the Wins tab, not here
}

function applyOvFilters(cards) {
  const f = STATE.ovFilters;
  const search = f.search.trim().toLowerCase();
  return cards.filter((c) => {
    if (f.pse.size && !f.pse.has(winPse(c))) return false;
    if (f.kam.size && !f.kam.has(c.kam || '—')) return false;
    if (f.salesRep.size && !f.salesRep.has(c.salesRep || '—')) return false;
    if (f.quarter !== 'All') {
      const d = c.commercialSignOffDate;
      if (!d || quarterOf(d) !== f.quarter) return false;
    }
    if (search) {
      const hay = `${c.key} ${c.summary || ''} ${winPse(c)} ${c.kam || ''} ${c.salesRep || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

async function renderOverview() {
  document.getElementById('app').innerHTML = '<div class="page"><div class="loading">Loading consolidated overview…</div></div>';
  try {
    const res = await fetch('/api/update-check?set=overview', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    STATE.overviewCards = (await res.json()).cards || [];
  } catch (err) {
    document.getElementById('app').innerHTML = `<div class="page"><div class="empty">Could not load overview: ${err.message}</div></div>`;
    return;
  }
  renderOverviewView();
}

// Colour the status by segment rather than Jira's statusCategory — won and
// churn cards aren't in STATE.data.issues, so fbadge() would grey them out.
function ovStatusBadge(c) {
  const meta = OV_SEG_BY_KEY[ovSegmentOf(c)];
  return meta
    ? `<span class="ov-badge" style="--ovc:${meta.color}">${wonLabel(c.status)}</span>`
    : `<span class="bd bgy">${wonLabel(c.status)}</span>`;
}

// Column model for the Deal Detail table — sortable per-column, exactly like
// the TAT tab's tables (same sort state shape, same click-a-header behavior),
// but scoped to this one Overview table only (STATE.ovDetailSort).
const OV_DETAIL_COLUMNS = [
  { key: 'key', label: 'Key', type: 'text', val: (c) => c.key, cell: (c) => `<a class="jira-key-link" href="${c.url}" target="_blank" rel="noopener" title="Open ${c.key} in Jira">${c.key} ↗</a>` },
  { key: 'summary', label: 'Client', type: 'text', val: (c) => c.summary || '', cell: (c) => { const meta = OV_SEG_BY_KEY[ovSegmentOf(c)]; const dot = meta ? `<span class="ov-dot" style="background:${meta.color}"></span>` : ''; return `${dot}${c.summary || '—'}`; } },
  { key: 'status', label: 'Status', type: 'text', val: (c) => c.status || '', cell: (c) => ovStatusBadge(c) },
  { key: 'pse', label: 'PSE', type: 'text', val: (c) => winPse(c), cell: (c) => winPse(c) },
  { key: 'kam', label: 'KAM', type: 'text', val: (c) => c.kam || '', cell: (c) => c.kam || '<span class="tat-blank">—</span>' },
  { key: 'salesRep', label: 'Sales Rep', type: 'text', val: (c) => c.salesRep || '', cell: (c) => c.salesRep || '<span class="tat-blank">—</span>' },
  { key: 'mrr', label: 'MRR', type: 'num', val: (c) => c.mrr || 0, cell: (c) => (c.mrr ? fmtUsd(c.mrr) : '<span class="tat-blank">—</span>') },
  { key: 'arr', label: 'ARR', type: 'num', val: (c) => (c.mrr ? c.mrr * 12 : 0), cell: (c) => (c.mrr ? fmtUsd(c.mrr * 12) : '<span class="tat-blank">—</span>') },
  { key: 'solutioningStartDate', label: 'Sol. Start', type: 'date', val: (c) => c.solutioningStartDate || '', cell: (c) => fmtDdMmYyyy(c.solutioningStartDate) || '<span class="tat-blank">—</span>' },
  { key: 'expectedSalesClosure', label: 'Exp. Closure', type: 'date', val: (c) => c.expectedSalesClosure || '', cell: (c) => fmtDdMmYyyy(c.expectedSalesClosure) || '<span class="tat-blank">—</span>' },
  { key: 'commercialSignOffDate', label: 'Commercial Sign-Off', type: 'date', val: (c) => c.commercialSignOffDate || '', cell: (c) => fmtDdMmYyyy(c.commercialSignOffDate) || '<span class="tat-blank">—</span>' },
];

function sortOvDetailRows(rows) {
  const s = STATE.ovDetailSort;
  const col = OV_DETAIL_COLUMNS.find((c) => c.key === s.key) || OV_DETAIL_COLUMNS[0];
  const dir = s.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const va = col.val(a), vb = col.val(b);
    if (col.type === 'num') return (va - vb) * dir;
    const sa = String(va), sb = String(vb);
    if (!sa && sb) return 1; // blanks always sort last
    if (sa && !sb) return -1;
    return sa.localeCompare(sb) * dir;
  });
}

function ovDealRow(c) {
  return `<tr data-key="${c.key}">${OV_DETAIL_COLUMNS.map((col) => `<td${col.type === 'num' ? ' class="win-num"' : col.key === 'summary' ? ' class="ov-client"' : ''}>${col.cell(c)}</td>`).join('')}</tr>`;
}

function renderOverviewView() {
  renderOverviewSidebar();
  const all = applyOvFilters(STATE.overviewCards || []);

  // Bucket once, reuse everywhere.
  const seg = { active: [], won: [], c3m: [], churn: [] };
  all.forEach((c) => { const s = ovSegmentOf(c); if (s) seg[s].push(c); });
  const mrrOf = (list) => list.reduce((s, c) => s + (c.mrr || 0), 0);
  const inScope = [...seg.active, ...seg.won, ...seg.c3m, ...seg.churn];

  // Per-PSE scorecard: Active vs Won side by side, plus check-in / churn.
  const pseSet = [...new Set(inScope.map(winPse))].sort();
  const rows = pseSet.map((p) => {
    const a = seg.active.filter((c) => winPse(c) === p);
    const w = seg.won.filter((c) => winPse(c) === p);
    const k = seg.c3m.filter((c) => winPse(c) === p);
    const ch = seg.churn.filter((c) => winPse(c) === p);
    return { p, a, w, k, ch, aMrr: mrrOf(a), wMrr: mrrOf(w) };
  }).sort((x, y) => y.wMrr - x.wMrr || y.aMrr - x.aMrr);

  const tot = {
    a: seg.active.length, w: seg.won.length, k: seg.c3m.length, ch: seg.churn.length,
    aMrr: mrrOf(seg.active), wMrr: mrrOf(seg.won),
  };
  const maxBar = Math.max(1, ...rows.map((r) => Math.max(r.a.length, r.w.length)));

  const detailSeg = STATE.ovSegment;
  const detailSegList = detailSeg === 'all' ? inScope : seg[detailSeg] || [];
  // Local-only PSE narrowing for this table — deliberately separate from the
  // header's PSE chips (STATE.ovFilters.pse), so picking a PSE here doesn't
  // move the scorecard/hero numbers above; it only narrows this table.
  const detailPsePool = [...new Set(detailSegList.map(winPse))].sort();
  if (STATE.ovDetailPse !== 'All' && !detailPsePool.includes(STATE.ovDetailPse)) STATE.ovDetailPse = 'All';
  const detailList = sortOvDetailRows(
    detailSegList.filter((c) => STATE.ovDetailPse === 'All' || winPse(c) === STATE.ovDetailPse)
  );
  const detailLabel = (detailSeg === 'all' ? 'All Deals' : OV_SEG_BY_KEY[detailSeg].label) + (STATE.ovDetailPse !== 'All' ? ` — ${STATE.ovDetailPse}` : '');

  const f = STATE.ovFilters;
  const pseChips = [...new Set((STATE.overviewCards || []).map(winPse))].sort();

  document.getElementById('app').innerHTML = `
    <div class="page tk-page">
      <div class="ph"><div class="ph-text">
        <div class="pht">Overview</div>
        <div class="phs">Consolidated live view from Jira · Active Pipeline · Won ${OV_FY} · Check in 3 Months · Churn · ARR = MRR × 12</div>
      </div></div>

      <div class="ov-bar">
        <div class="ov-bar-head">
          <span class="ov-bar-title">Executive Snapshot</span>
          <div class="win-toggles">
            <span class="win-tg-label">Quarter</span>
            ${['All', 'Q1', 'Q2', 'Q3', 'Q4'].map((q) => `<button class="win-chip ${f.quarter === q ? 'active' : ''}" data-ov-q="${q}">${q}</button>`).join('')}
          </div>
        </div>
        ${pseChips.length > 1 ? `
        <div class="ov-pse-chips">
          <span class="win-tg-label">PSE</span>
          <button class="win-chip ${!f.pse.size ? 'active' : ''}" data-ov-pse="__all">All</button>
          ${pseChips.map((p) => `<button class="win-chip ${f.pse.has(p) ? 'active' : ''}" data-ov-pse="${escapeAttr(p)}">${p}</button>`).join('')}
        </div>` : ''}
        <div class="ov-hero">
          ${OV_SEGMENTS.map((s) => {
            const list = seg[s.key];
            const m = mrrOf(list);
            return `
            <div class="ov-card ${detailSeg === s.key ? 'sel' : ''}" data-ov-seg="${s.key}" style="--ovc:${s.color}">
              <div class="ov-card-top"><span class="ov-card-dot"></span><span class="ov-card-label">${s.label}</span></div>
              <div class="ov-card-n">${list.length}</div>
              <div class="ov-card-mrr">${fmtUsd(m)} MRR</div>
              <div class="ov-card-arr">${fmtUsd(m * 12)} ARR · ${s.sub}</div>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="sh"><div class="sht">Active vs Won ${OV_FY}</div><div class="shl"></div><div class="shb">Per PSE</div></div>
      <div class="tc">
        <div class="tw">
          <table class="ov-score">
            <thead><tr>
              <th>PSE</th><th class="ov-cmp-th">Active vs Won</th>
              <th class="win-num">Active</th><th class="win-num">Active MRR</th>
              <th class="win-num">Won</th><th class="win-num">Won MRR</th>
              <th class="win-num">Check-in 3M</th><th class="win-num">Churn</th>
            </tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td class="ov-pse-name">${r.p}</td>
                  <td class="ov-cmp">
                    <span class="ov-mini"><i class="ov-mini-a" style="width:${(r.a.length / maxBar) * 100}%"></i></span>
                    <span class="ov-mini"><i class="ov-mini-w" style="width:${(r.w.length / maxBar) * 100}%"></i></span>
                  </td>
                  <td class="win-num ov-b">${r.a.length}</td>
                  <td class="win-num">${fmtUsd(r.aMrr)}</td>
                  <td class="win-num ov-g">${r.w.length}</td>
                  <td class="win-num">${fmtUsd(r.wMrr)}</td>
                  <td class="win-num ov-a">${r.k.length}</td>
                  <td class="win-num ov-r">${r.ch.length}</td>
                </tr>`).join('') || '<tr><td colspan="8" class="empty">No deals match the current filters</td></tr>'}
            </tbody>
            <tfoot><tr class="win-foot">
              <td>TOTAL</td><td></td>
              <td class="win-num">${tot.a}</td><td class="win-num">${fmtUsd(tot.aMrr)}</td>
              <td class="win-num">${tot.w}</td><td class="win-num">${fmtUsd(tot.wMrr)}</td>
              <td class="win-num">${tot.k}</td><td class="win-num">${tot.ch}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>

      <div class="card" style="margin:18px 0"><div class="ct">Active vs Won by PSE</div><div class="cs">Deal counts side by side · click a bar to filter that PSE</div><div style="height:${hBarHeight(rows.length)}"><canvas id="ovCmpChart"></canvas></div></div>

      <div class="sh"><div class="sht">Deal Detail</div><div class="shl"></div></div>
      <div class="win-qchips">
        <button class="win-chip ${detailSeg === 'all' ? 'active' : ''}" data-ov-seg2="all">All <span class="win-chip-n">${inScope.length}</span></button>
        ${OV_SEGMENTS.map((s) => `<button class="win-chip ${detailSeg === s.key ? 'active' : ''}" data-ov-seg2="${s.key}">${s.short} <span class="win-chip-n">${seg[s.key].length}</span></button>`).join('')}
      </div>
      <div class="tc">
        <div class="th ov-detail-head">
          <div class="ov-detail-title"><span class="tht">${detailLabel}</span><span class="ths">${detailList.length} deal(s) · ${fmtUsd(mrrOf(detailList))} MRR</span></div>
          <div class="ov-detail-pse-chips">
            <button class="win-chip win-chip-sm ${STATE.ovDetailPse === 'All' ? 'active' : ''}" data-ov-detail-pse="All">All PSEs</button>
            ${detailPsePool.map((p) => `<button class="win-chip win-chip-sm ${STATE.ovDetailPse === p ? 'active' : ''}" data-ov-detail-pse="${escapeAttr(p)}">${p}</button>`).join('')}
          </div>
          ${detailList.length ? '<button class="clear-btn" id="ovExportBtn">Export CSV</button>' : ''}
        </div>
        <div class="tw">
          <table class="tat-table ov-detail-table">
            <thead><tr>${OV_DETAIL_COLUMNS.map((c) => {
              const active = STATE.ovDetailSort.key === c.key;
              const arrow = active ? (STATE.ovDetailSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
              return `<th class="tat-th ${active ? 'sorted' : ''}" data-ov-sort-key="${c.key}" title="Sort by ${c.label}">${c.label}${arrow}</th>`;
            }).join('')}</tr></thead>
            <tbody>${detailList.map((c) => ovDealRow(c)).join('') || `<tr><td colspan="${OV_DETAIL_COLUMNS.length}" class="empty">No deals in this view</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  // --- interactions ---
  document.querySelectorAll('[data-ov-q]').forEach((b) =>
    b.addEventListener('click', () => { STATE.ovFilters.quarter = b.dataset.ovQ; renderOverviewView(); }));
  document.querySelectorAll('[data-ov-pse]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = b.dataset.ovPse;
      if (p === '__all') STATE.ovFilters.pse = new Set();
      else if (STATE.ovFilters.pse.has(p)) STATE.ovFilters.pse.delete(p);
      else STATE.ovFilters.pse.add(p);
      renderOverviewView();
    }));
  document.querySelectorAll('[data-ov-seg]').forEach((el) =>
    el.addEventListener('click', () => { STATE.ovSegment = el.dataset.ovSeg; renderOverviewView(); }));
  document.querySelectorAll('[data-ov-seg2]').forEach((b) =>
    b.addEventListener('click', () => { STATE.ovSegment = b.dataset.ovSeg2; renderOverviewView(); }));
  document.querySelectorAll('[data-ov-detail-pse]').forEach((b) =>
    b.addEventListener('click', () => { STATE.ovDetailPse = b.dataset.ovDetailPse; renderOverviewView(); }));
  // Deal Detail column sort — same click-a-header-to-sort behavior as the TAT
  // tab; scoped to this one table only via STATE.ovDetailSort.
  document.querySelectorAll('.ov-detail-table .tat-th').forEach((th) =>
    th.addEventListener('click', () => {
      const key = th.dataset.ovSortKey;
      const cur = STATE.ovDetailSort;
      const numeric = OV_DETAIL_COLUMNS.find((c) => c.key === key).type !== 'text';
      let dir;
      if (cur.key === key) dir = cur.dir === 'asc' ? 'desc' : 'asc';
      else dir = numeric ? 'desc' : 'asc';
      STATE.ovDetailSort = { key, dir };
      renderOverviewView();
    }));
  document.querySelectorAll('.ov-detail-table tbody tr[data-key]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.jira-key-link')) return;
      openWinDetail(tr.dataset.key, STATE.overviewCards);
    }));
  const exp = document.getElementById('ovExportBtn');
  if (exp) exp.addEventListener('click', () => {
    downloadCsv('psv-overview.csv', toCsv(detailList, [
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'Segment', value: (r) => (OV_SEG_BY_KEY[ovSegmentOf(r)] || {}).label || '' },
      { label: 'Status', value: (r) => wonLabel(r.status) },
      { label: 'PSE', value: (r) => winPse(r) },
      { label: 'KAM', value: (r) => r.kam },
      { label: 'Sales Rep', value: (r) => r.salesRep },
      { label: 'MRR', value: (r) => r.mrr },
      { label: 'ARR', value: (r) => (r.mrr ? r.mrr * 12 : '') },
      { label: 'Solutioning Start', value: (r) => r.solutioningStartDate },
      { label: 'Expected Closure', value: (r) => r.expectedSalesClosure },
      { label: 'Commercial Sign-Off', value: (r) => r.commercialSignOffDate },
      { label: 'Jira URL', value: (r) => r.url },
    ]));
  });

  destroyCharts();
  addChart(
    'ovCmpChart', 'bar', rows.map((r) => r.p),
    [
      { label: 'Active Pipeline', data: rows.map((r) => r.a.length), backgroundColor: '#3B5BFF' },
      { label: `Won ${OV_FY}`, data: rows.map((r) => r.w.length), backgroundColor: '#12B76A' },
    ],
    { indexAxis: 'y', plugins: { legend: { display: true, position: 'bottom' } }, scales: { y: { ticks: { autoSkip: false } } } },
    (pse) => { STATE.ovFilters.pse = new Set([pse]); renderOverviewView(); }
  );
}

// Exclusive sidebar for Overview: KAM / Sales Rep (PSE + quarter live in the header).
function renderOverviewSidebar() {
  if (!STATE.facc) loadSidebarPrefs();
  const f = STATE.ovFilters;
  const cards = STATE.overviewCards || [];
  const kams = distinct(cards.map((c) => c.kam || '—'));
  const reps = distinct(cards.map((c) => c.salesRep || '—'));
  const activeCount = f.kam.size + f.salesRep.size + f.pse.size + (f.quarter !== 'All' ? 1 : 0) + (f.search.trim() ? 1 : 0);
  const sb = document.getElementById('sidebar');
  sb.style.display = '';
  sb.classList.toggle('collapsed', STATE.sidebarCollapsed);
  sb.innerHTML = `
    <div class="sb-header">
      <div class="sb-title">Filters${activeCount ? `<span class="facc-badge">${activeCount}</span>` : ''}</div>
      <button class="sb-toggle" id="sidebarToggleBtn" title="${STATE.sidebarCollapsed ? 'Expand filters' : 'Collapse filters'}">${STATE.sidebarCollapsed ? '»' : '«'}</button>
    </div>
    <div class="sb-content" style="display:${STATE.sidebarCollapsed ? 'none' : ''}">
      ${faccGroup('kam', 'KAM', checkboxListHtml('kam', kams, f.kam), f.kam.size)}
      ${faccGroup('salesRep', 'Sales Representative', checkboxListHtml('salesRep', reps, f.salesRep), f.salesRep.size)}
      <button class="clear-btn-full" id="clearOvFiltersBtn">Clear all filters</button>
    </div>`;

  document.getElementById('sidebarToggleBtn').addEventListener('click', () => {
    STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
    localStorage.setItem('psv_sidebar_collapsed', STATE.sidebarCollapsed ? '1' : '0');
    renderOverviewSidebar();
  });
  if (STATE.sidebarCollapsed) return;

  document.querySelectorAll('[data-facc-toggle]').forEach((head) => {
    head.addEventListener('click', () => {
      const id = head.dataset.faccToggle;
      STATE.facc[id] = !STATE.facc[id];
      localStorage.setItem('psv_facc_' + id, STATE.facc[id] ? '1' : '0');
      head.closest('.facc').classList.toggle('open', STATE.facc[id]);
    });
  });
  document.querySelectorAll('#sidebar [data-mgroup]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const set = STATE.ovFilters[cb.dataset.mgroup];
      if (cb.checked) set.add(cb.value);
      else set.delete(cb.value);
      renderOverviewView();
    });
  });
  document.getElementById('clearOvFiltersBtn').addEventListener('click', () => {
    STATE.ovFilters = { pse: new Set(), kam: new Set(), salesRep: new Set(), quarter: 'All' };
    renderOverviewView();
  });
}

// ---------- status drilldown ----------
function renderStatusDrilldown(status) {
  const rows = applyFilters(STATE.data.issues).filter((i) => i.status === status);

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph">
        <div>
          <div class="back-link" id="backLink">← Back to Overview</div>
          <div class="pht" style="margin-top:6px">${status}</div>
          <div class="phs">${rows.length} card(s) in this status · live from Jira</div>
        </div>
        <button class="clear-btn" id="exportBtn">Export CSV</button>
      </div>
      <div class="tc">
        <div class="th"><span class="tht">Cards</span><span class="ths">Click a row for full detail</span></div>
        <div class="tw">
          <table>
            <thead><tr><th>Key</th><th>Client / Card</th><th>PSE</th><th>KAM</th><th>Sales Rep</th><th>Priority</th><th>Modules</th><th>TAT</th><th>Updated</th></tr></thead>
            <tbody>
              ${
                rows
                  .map(
                    (i) => `
                <tr data-key="${i.key}">
                  <td style="color:var(--b);font-weight:700">${i.key}</td>
                  <td>${i.summary || ''}</td>
                  <td>${i.assignee}</td>
                  <td>${i.kam || '—'}</td>
                  <td>${i.salesRep || '—'}</td>
                  <td>${i.priority || '—'}</td>
                  <td>${modulePills(i.modules)}</td>
                  <td>${tatLabel(i)}</td>
                  <td>${fmtDdMmYyyy(i.updated)}</td>
                </tr>`
                  )
                  .join('') || '<tr><td colspan="9" class="empty">No cards match the current filters</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  document.getElementById('backLink').addEventListener('click', () => navigate('/'));
  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
  document.getElementById('exportBtn').addEventListener('click', () => {
    downloadCsv(`psv-status-${status}.csv`, toCsv(rows, [
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'PSE', value: (r) => r.assignee },
      { label: 'KAM', value: (r) => r.kam },
      { label: 'Sales Rep', value: (r) => r.salesRep },
      { label: 'Priority', value: (r) => r.priority },
      { label: 'TAT Days', value: (r) => r.tatDays },
      { label: 'Updated', value: (r) => r.updated },
    ]));
  });
}

// ---------- segment drilldown (Active/Cold/Stuck KPI clicks) ----------
const SEGMENT_META = {
  active: { title: 'Active Deals', desc: 'All in-pipeline statuses' },
  cold: { title: 'Cold / Check in 3 Months', desc: '' },
  stuck: { title: 'Stuck Deals (14+ days idle)', desc: 'Active deals not updated recently' },
};

function renderSegment(segment) {
  const meta = SEGMENT_META[segment] || { title: segment, desc: '' };
  let rows = applyFilters(STATE.data.issues);
  rows = segment === 'stuck'
    ? rows.filter((i) => i.stageGroup === 'active' && daysSince(i.updated) >= 14)
    : rows.filter((i) => i.stageGroup === segment);

  renderGenericDealTable({
    title: meta.title,
    subtitle: `${rows.length} card(s) · ${meta.desc}`,
    rows,
    backTo: '/',
    csvName: `psv-${segment}.csv`,
  });
}

// ---------- generic ad-hoc list (chart click-through target) ----------
function renderAdhocList() {
  const ad = STATE.adhoc;
  if (!ad) {
    document.getElementById('app').innerHTML = '<div class="page"><div class="empty">Nothing to show — go back and click a chart bar or status block.</div></div>';
    return;
  }
  const base = ad.raw ? STATE.data.issues : applyFilters(STATE.data.issues);
  const rows = base.filter(ad.predicate);
  renderGenericDealTable({
    title: ad.title,
    subtitle: `${rows.length} card(s) matching this selection`,
    rows,
    backTo: '/',
    csvName: 'psv-selection.csv',
  });
}

function renderGenericDealTable({ title, subtitle, rows, backTo, csvName }) {
  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph">
        <div>
          <div class="back-link" id="backLink">← Back</div>
          <div class="pht" style="margin-top:6px">${title}</div>
          <div class="phs">${subtitle}</div>
        </div>
        <button class="clear-btn" id="exportBtn">Export CSV</button>
      </div>
      <div class="tc">
        <div class="th"><span class="tht">Cards</span><span class="ths">Click a row for full detail</span></div>
        <div class="tw">
          <table>
            <thead><tr><th>Key</th><th>Client / Card</th><th>Status</th><th>PSE</th><th>KAM</th><th>MRR</th><th>TAT</th><th>Updated</th></tr></thead>
            <tbody>
              ${
                rows
                  .map(
                    (i) => `
                <tr data-key="${i.key}">
                  <td style="color:var(--b);font-weight:700">${i.key}</td>
                  <td>${i.summary || ''}</td>
                  <td>${fbadge(i.status)}</td>
                  <td>${i.assignee}</td>
                  <td>${i.kam || '—'}</td>
                  <td>${fmtUsd(i.mrr)}</td>
                  <td>${tatLabel(i)}</td>
                  <td>${fmtDdMmYyyy(i.updated)}</td>
                </tr>`
                  )
                  .join('') || '<tr><td colspan="8" class="empty">No cards match</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  document.getElementById('backLink').addEventListener('click', () => navigate(backTo));
  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
  document.getElementById('exportBtn').addEventListener('click', () => {
    downloadCsv(csvName, toCsv(rows, [
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'Status', value: (r) => r.status },
      { label: 'PSE', value: (r) => r.assignee },
      { label: 'KAM', value: (r) => r.kam },
      { label: 'MRR', value: (r) => r.mrr },
      { label: 'TAT Days', value: (r) => r.tatDays },
      { label: 'Updated', value: (r) => r.updated },
    ]));
  });
}

// ---------- Active Pipeline tab ----------
function renderPipeline() {
  const rows = applyFilters(STATE.data.issues).filter((i) => i.isActivePipeline);
  const valid = rows.filter((i) => !isMrrMissing(i.mrr));
  const totalMrr = valid.reduce((s, i) => s + i.mrr, 0);
  const holdovers = rows.filter((i) => i.isPreQuarterHoldover);

  const byPse = {};
  rows.forEach((i) => {
    if (!byPse[i.assignee]) byPse[i.assignee] = [];
    byPse[i.assignee].push(i);
  });
  const pseNames = Object.keys(byPse).sort();
  const mrrByPse = pseNames
    .map((p) => [p, byPse[p].filter((i) => !isMrrMissing(i.mrr)).reduce((s, i) => s + i.mrr, 0)])
    .sort((a, b) => b[1] - a[1]);

  const dealRow = (i) => `
    <tr data-key="${i.key}" class="${i.isPreQuarterHoldover ? 'row-flagged' : ''}">
      <td style="color:var(--b);font-weight:700">${i.key}</td>
      <td>${i.summary || ''}</td>
      <td>${fbadge(i.status)}</td>
      <td>${i.kam || '—'}</td>
      <td>${i.salesRep || '—'}</td>
      <td>${fmtUsd(i.mrr)}</td>
      <td>${fmtUsd(i.arr)}</td>
      <td>${dealSizeBadge(i.dealSize)}</td>
      <td>${fmtDdMmYyyy(i.solutioningStartDate) || '—'}</td>
      <td>${fmtDdMmYyyy(i.expectedSalesClosure) || '<span style="color:var(--t3)">—</span>'}</td>
      <td>${i.isPreQuarterHoldover ? '<span class="flag-badge">🔴 Red Flag</span>' : '—'}</td>
      <td>${jiraLinkCell(i)}</td>
    </tr>`;

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">Active Pipeline</div><div class="phs">Req. Gathering · Solution Design · Pending On Client · Solutions Draft Shared · COMMERCIALS · Solutioning (Post closure) — not yet closed. Use "Current quarter only" in the sidebar to hide pre-quarter holdovers.</div></div>
      <div class="krow">
        <div class="kpi"><div class="kb"></div><div class="kl">Active Pipeline Deals</div><div class="kv">${rows.length}</div><div class="ks">Matching current filters</div></div>
        <div class="kpi"><div class="kb" style="background:var(--g)"></div><div class="kl">Total MRR</div><div class="kv" style="font-size:22px">${fmtUsd(totalMrr)}</div><div class="ks">Across ${valid.length} deals with MRR set</div></div>
        <div class="kpi"><div class="kb" style="background:var(--r)"></div><div class="kl">Pre-Quarter Red Flags</div><div class="kv">${holdovers.length}</div><div class="ks">Started before 1 May 2026, still open</div></div>
      </div>

      <div class="sh"><div class="sht">Pipeline by PSE</div><div class="shl"></div></div>
      <div class="krow">
        ${pseNames
          .map((p) => {
            const list = byPse[p];
            const pseMrr = list.filter((i) => !isMrrMissing(i.mrr)).reduce((s, i) => s + i.mrr, 0);
            return `<div class="kpi kpi-tint" style="--kc:var(--b)"><div class="kb" style="background:var(--b)"></div><div class="kl">${p}</div><div class="kv" style="font-size:24px">${list.length}</div><div class="ks">${fmtUsd(pseMrr)} MRR</div></div>`;
          })
          .join('')}
      </div>

      <div class="card" style="margin-bottom:16px"><div class="ct">Active Pipeline MRR by PSE</div><div class="cs">Click a bar to see that PSE's active pipeline deals</div><div style="height:240px"><canvas id="pipelinePseChart"></canvas></div></div>

      <div class="sh"><div class="sht">Deals by PSE</div><div class="shl"></div><div class="shb">🔴 red rows = started before the current quarter</div></div>
      ${
        pseNames
          .map((p) => {
            const list = byPse[p].slice().sort((a, b) => (b.mrr || 0) - (a.mrr || 0));
            const pseMrr = list.filter((i) => !isMrrMissing(i.mrr)).reduce((s, i) => s + i.mrr, 0);
            return `
        <div class="tc">
          <div class="th"><span class="tht">${p}</span><span class="ths">${list.length} deal(s) · ${fmtUsd(pseMrr)} MRR</span></div>
          <div class="tw">
            <table>
              <thead><tr><th>Key</th><th>Client</th><th>Status</th><th>KAM</th><th>Sales Rep</th><th>MRR</th><th>ARR</th><th>Size</th><th>Sol. Start</th><th>Expected Closure Date</th><th>Flag</th><th></th></tr></thead>
              <tbody>${list.map(dealRow).join('')}</tbody>
            </table>
          </div>
        </div>`;
          })
          .join('') || '<div class="empty">No active pipeline deals match the current filters</div>'
      }
    </div>`;

  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
  destroyCharts();
  addChart(
    'pipelinePseChart', 'bar', mrrByPse.map((e) => e[0]),
    [{ label: 'MRR (USD)', data: mrrByPse.map((e) => e[1]), backgroundColor: '#0054FC' }],
    { indexAxis: 'y' },
    (pse) => goToFilteredList(`Active Pipeline — ${pse}`, (i) => i.isActivePipeline && i.assignee === pse)
  );
}

// ---------- Check-in-3-Months tab ----------
function renderC3m() {
  const rows = applyFilters(STATE.data.issues).filter((i) => i.status === 'Check in 3 Months');
  const byPse = {};
  rows.forEach((i) => {
    if (!byPse[i.assignee]) byPse[i.assignee] = [];
    byPse[i.assignee].push(i);
  });
  const pseNames = Object.keys(byPse).sort((a, b) => byPse[b].length - byPse[a].length);

  const dealRow = (i) => `
    <tr data-key="${i.key}">
      <td style="color:var(--b);font-weight:700">${i.key}</td>
      <td>${i.summary || ''}</td>
      <td>${i.kam || '—'}</td>
      <td>${i.salesRep || '—'}</td>
      <td>${fmtUsd(i.mrr)}</td>
      <td>${fmtDdMmYyyy(i.updated)}</td>
      <td>${jiraLinkCell(i)}</td>
    </tr>`;

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">Check-in-3-Months</div><div class="phs">${rows.length} deal(s) currently parked in "Check in 3 Months", grouped by PSE</div></div>
      ${
        pseNames
          .map(
            (p) => `
        <div class="tc">
          <div class="th"><span class="tht">${p}</span><span class="ths">${byPse[p].length} deal(s)</span></div>
          <div class="tw">
            <table>
              <thead><tr><th>Key</th><th>Client</th><th>KAM</th><th>Sales Rep</th><th>MRR</th><th>Last Updated</th><th></th></tr></thead>
              <tbody>${byPse[p].map(dealRow).join('')}</tbody>
            </table>
          </div>
        </div>`
          )
          .join('') || '<div class="empty">No deals currently in Check in 3 Months</div>'
      }
    </div>`;
  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
}

// ---------- MRR tab ----------
function renderMrr() {
  const rows = applyFilters(STATE.data.issues);
  const valid = rows.filter((i) => !isMrrMissing(i.mrr));
  const missing = rows.filter((i) => isMrrMissing(i.mrr));
  const totalMrr = valid.reduce((s, i) => s + i.mrr, 0);
  const largeDeals = rows.filter((i) => i.dealSize === 'large').sort((a, b) => b.mrr - a.mrr);
  const smallDeals = rows.filter((i) => i.dealSize === 'small').sort((a, b) => b.mrr - a.mrr);
  const largeArr = largeDeals.reduce((s, i) => s + i.arr, 0);
  const smallArr = smallDeals.reduce((s, i) => s + i.arr, 0);

  const byPse = {};
  rows.forEach((i) => {
    if (!byPse[i.assignee]) byPse[i.assignee] = { valid: [], missing: [] };
    (isMrrMissing(i.mrr) ? byPse[i.assignee].missing : byPse[i.assignee].valid).push(i);
  });
  const pseNames = Object.keys(byPse).sort();
  const mrrByPseEntries = pseNames.map((p) => [p, byPse[p].valid.reduce((s, i) => s + i.mrr, 0)]).sort((a, b) => b[1] - a[1]);

  const dealSizeRow = (i) => `
    <tr data-key="${i.key}">
      <td style="color:var(--b);font-weight:700">${i.key}</td>
      <td>${i.summary || ''}</td>
      <td>${i.assignee}</td>
      <td>${fbadge(i.status)}</td>
      <td>${fmtUsd(i.mrr)}</td>
      <td>${fmtUsd(i.arr)}</td>
      <td>${fmtDdMmYyyy(i.expectedSalesClosure) || '<span style="color:var(--t3)">—</span>'}</td>
      <td>${jiraLinkCell(i)}</td>
    </tr>`;

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">MRR</div><div class="phs">Live from Jira "MRR (USD)" field · zero/one values are treated as not filled in</div></div>
      <div class="krow">
        <div class="kpi"><div class="kb" style="background:var(--g)"></div><div class="kl">Total MRR</div><div class="kv" style="font-size:24px">${fmtUsd(totalMrr)}</div><div class="ks">Across ${valid.length} deals with a real value</div></div>
        <div class="kpi"><div class="kb" style="background:var(--b)"></div><div class="kl">Deals w/ MRR set</div><div class="kv">${valid.length}</div><div class="ks">of ${rows.length} matching filters</div></div>
        <div class="kpi"><div class="kb" style="background:var(--a)"></div><div class="kl">Missing / 0 / 1</div><div class="kv">${missing.length}</div><div class="ks">Needs an update in Jira</div></div>
        <div class="kpi"><div class="kb" style="background:#7C3AED"></div><div class="kl">Large Deals — Total ARR</div><div class="kv" style="font-size:22px">${fmtUsd(largeArr)}</div><div class="ks">${largeDeals.length} deals &gt; $100k ARR</div></div>
        <div class="kpi"><div class="kb"></div><div class="kl">Small Deals — Total ARR</div><div class="kv" style="font-size:22px">${fmtUsd(smallArr)}</div><div class="ks">${smallDeals.length} deals ≤ $100k ARR</div></div>
      </div>

      <div class="card" style="margin-bottom:16px"><div class="ct">MRR by PSE</div><div class="cs">Sum of valid MRR per PSE (USD) · click a bar</div><div style="height:240px"><canvas id="mrrPseChart"></canvas></div></div>

      <div class="sh"><div class="sht">Large Deals (ARR &gt; $100k)</div><div class="shl"></div><div class="shb">${largeDeals.length}</div></div>
      <div class="tc">
        <div class="tw">
          <table>
            <thead><tr><th>Key</th><th>Client</th><th>PSE</th><th>Status</th><th>MRR</th><th>ARR</th><th>Expected Closure Date</th><th></th></tr></thead>
            <tbody>${largeDeals.map(dealSizeRow).join('') || '<tr><td colspan="8" class="empty">No large deals match the current filters</td></tr>'}</tbody>
          </table>
        </div>
      </div>

      <div class="ph"><div class="pht" style="font-size:14px">Deals Missing MRR — by PSE</div><button class="clear-btn" id="exportMissingBtn">Export CSV</button></div>
      ${
        pseNames
          .map((p) => {
            const list = byPse[p].missing;
            if (!list.length) return '';
            return `
          <div class="tc">
            <div class="th"><span class="tht">${p}</span><span class="ths">${list.length} deal(s) missing MRR</span></div>
            <div class="tw">
              <table>
                <thead><tr><th>Key</th><th>Client</th><th>Status</th><th>MRR value</th><th>Expected Closure Date</th><th>Updated</th></tr></thead>
                <tbody>
                  ${list
                    .map(
                      (i) => `
                    <tr data-key="${i.key}">
                      <td style="color:var(--b);font-weight:700">${i.key}</td>
                      <td>${i.summary || ''}</td>
                      <td>${fbadge(i.status)}</td>
                      <td>${i.mrr === null ? '<span class="bd bgy">blank</span>' : `<span class="bd ba">${i.mrr}</span>`}</td>
                      <td>${fmtDdMmYyyy(i.expectedSalesClosure) || '<span style="color:var(--t3)">—</span>'}</td>
                      <td>${fmtDdMmYyyy(i.updated)}</td>
                    </tr>`
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>`;
          })
          .join('') || '<div class="empty">No deals are missing an MRR value 🎉</div>'
      }
    </div>`;

  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
  document.getElementById('exportMissingBtn').addEventListener('click', () => {
    downloadCsv('psv-missing-mrr.csv', toCsv(missing, [
      { label: 'PSE', value: (r) => r.assignee },
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'Status', value: (r) => r.status },
      { label: 'MRR value', value: (r) => r.mrr },
      { label: 'Updated', value: (r) => r.updated },
    ]));
  });

  destroyCharts();
  addChart(
    'mrrPseChart', 'bar', mrrByPseEntries.map((e) => e[0]),
    [{ label: 'MRR (USD)', data: mrrByPseEntries.map((e) => e[1]), backgroundColor: '#12B76A' }],
    { indexAxis: 'y' },
    (pse) => goToFilteredList(`MRR — ${pse}`, (i) => i.assignee === pse && !isMrrMissing(i.mrr))
  );
}

// ---------- Closing Soon tab ----------
function renderClosingSoon() {
  const rows = applyFilters(STATE.data.issues)
    .filter((i) => i.status !== 'Check in 3 Months' && i.expectedSalesClosure)
    .map((i) => ({ ...i, daysUntil: daysUntil(i.expectedSalesClosure) }))
    .filter((i) => i.daysUntil >= 0 && i.daysUntil <= 30)
    .sort((a, b) => a.daysUntil - b.daysUntil);

  const totalMrr = rows.filter((i) => !isMrrMissing(i.mrr)).reduce((s, i) => s + i.mrr, 0);

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph">
        <div><div class="pht">Closing Soon</div><div class="phs">Deals with an Expected Sales Closure date in the next 30 days</div></div>
        <button class="clear-btn" id="exportBtn">Export CSV</button>
      </div>
      <div class="krow">
        <div class="kpi"><div class="kb"></div><div class="kl">Closing in 30 Days</div><div class="kv">${rows.length}</div><div class="ks">Matching current filters</div></div>
        <div class="kpi"><div class="kb" style="background:var(--g)"></div><div class="kl">MRR at Stake</div><div class="kv" style="font-size:22px">${fmtUsd(totalMrr)}</div><div class="ks">Sum of valid MRR</div></div>
      </div>
      <div class="tc">
        <div class="th"><span class="tht">Cards</span><span class="ths">Sorted by soonest closure date</span></div>
        <div class="tw">
          <table>
            <thead><tr><th>Key</th><th>Client / Card</th><th>Status</th><th>PSE</th><th>KAM</th><th>Sales Rep</th><th>MRR</th><th>Closure Date</th><th>SOW Sign-Off</th><th>Days Left</th></tr></thead>
            <tbody>
              ${
                rows
                  .map(
                    (i) => `
                <tr data-key="${i.key}">
                  <td style="color:var(--b);font-weight:700">${i.key}</td>
                  <td>${i.summary || ''}</td>
                  <td>${fbadge(i.status)}</td>
                  <td>${i.assignee}</td>
                  <td>${i.kam || '—'}</td>
                  <td>${i.salesRep || '—'}</td>
                  <td>${fmtUsd(i.mrr)}</td>
                  <td>${fmtDdMmYyyy(i.expectedSalesClosure)}</td>
                  <td>${fmtDdMmYyyy(i.sowSignOffDate) || '—'}</td>
                  <td><span class="bd ${i.daysUntil <= 7 ? 'br' : i.daysUntil <= 15 ? 'ba' : 'bb'}">${i.daysUntil}d</span></td>
                </tr>`
                  )
                  .join('') || '<tr><td colspan="10" class="empty">No deals closing in the next 30 days</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
  document.getElementById('exportBtn').addEventListener('click', () => {
    downloadCsv('psv-closing-soon.csv', toCsv(rows, [
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'Status', value: (r) => r.status },
      { label: 'PSE', value: (r) => r.assignee },
      { label: 'KAM', value: (r) => r.kam },
      { label: 'Sales Rep', value: (r) => r.salesRep },
      { label: 'MRR', value: (r) => r.mrr },
      { label: 'Closure Date', value: (r) => r.expectedSalesClosure },
      { label: 'SOW Sign-Off', value: (r) => r.sowSignOffDate },
      { label: 'Days Left', value: (r) => r.daysUntil },
    ]));
  });
}

// ---------- TAT tab ----------
// Active-TAT statuses shown in the FY tables (Pending On Client is separate).
const TAT_FY_STATUSES = ['Req. Gathering', 'Solution Design', 'Solutions Draft Shared'];

// The TAT tab's exclusive filters. `status` is skipped for the Pending-On-Client
// table (its status is fixed), so those filters still narrow it by PSE/KAM/etc.
function applyTatFilters(list, { useStatus = true } = {}) {
  const f = STATE.tatFilters;
  const search = f.search.trim().toLowerCase();
  return list.filter((i) => {
    if (f.pse.size && !f.pse.has(i.assignee)) return false;
    if (useStatus && f.status.size && !f.status.has(i.status)) return false;
    if (f.kam.size && !f.kam.has(i.kam)) return false;
    if (f.salesRep.size && !f.salesRep.has(i.salesRep)) return false;
    if (f.dealSize && i.dealSize !== f.dealSize) return false;
    if (f.health.size && !f.health.has(tatHealth(i.tatDays))) return false;
    if (search) {
      const hay = `${i.key} ${i.summary || ''} ${i.assignee || ''} ${i.kam || ''} ${i.salesRep || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function fmtTatDate(d) {
  return fmtDdMmYyyy(d) || '<span class="tat-blank">—</span>';
}

// Column model shared by all three TAT tables; each column is independently
// sortable per-table (sort state kept in STATE.tatSort[tableId]).
const TAT_COLUMNS = [
  { key: 'key', label: 'Key', type: 'text', val: (i) => i.key, cell: (i) => `<a class="jira-key-link" href="${i.url}" target="_blank" rel="noopener" title="Open ${i.key} in Jira">${i.key} ↗</a>` },
  { key: 'summary', label: 'Client', type: 'text', val: (i) => i.summary || '', cell: (i) => i.summary || '<span class="tat-blank">—</span>' },
  { key: 'assignee', label: 'PSE', type: 'text', val: (i) => i.assignee || '', cell: (i) => i.assignee || '<span class="tat-blank">—</span>' },
  { key: 'status', label: 'Status', type: 'text', val: (i) => i.status || '', cell: (i) => fbadge(i.status) },
  { key: 'solutioningStartDate', label: 'Sol. Start', type: 'date', val: (i) => i.solutioningStartDate || '', cell: (i) => fmtTatDate(i.solutioningStartDate) },
  { key: 'kam', label: 'KAM', type: 'text', val: (i) => i.kam || '', cell: (i) => i.kam || '<span class="tat-blank">—</span>' },
  { key: 'salesRep', label: 'Sales Rep', type: 'text', val: (i) => i.salesRep || '', cell: (i) => i.salesRep || '<span class="tat-blank">—</span>' },
  { key: 'expectedSalesClosure', label: 'Exp. Closure', type: 'date', val: (i) => i.expectedSalesClosure || '', cell: (i) => fmtTatDate(i.expectedSalesClosure) },
  { key: 'mrr', label: 'MRR', type: 'num', val: (i) => i.mrr || 0, cell: (i) => (i.mrr ? fmtUsd(i.mrr) : '<span class="tat-blank">—</span>') },
  { key: 'tatHoldDays', label: 'Client Hold', type: 'num', val: (i) => i.tatHoldDays || 0, cell: (i) => (i.tatHoldDays ? `<span class="bd ba">${i.tatHoldDays}d</span>` : '<span class="tat-blank">—</span>') },
  { key: 'tatDays', label: 'Active TAT', type: 'num', val: (i) => (i.tatDays == null ? -1 : i.tatDays), cell: (i) => (i.tatDays != null ? i.tatDays + 'd' : '<span class="tat-blank">—</span>') },
  { key: 'health', label: 'Health', type: 'num', val: (i) => (i.tatDays == null ? -1 : i.tatDays), cell: (i) => tatHealthBadge(i.tatDays) },
];

function sortTatRows(rows, tableId, defaultSort) {
  const s = STATE.tatSort[tableId] || defaultSort;
  const col = TAT_COLUMNS.find((c) => c.key === s.key) || TAT_COLUMNS[0];
  const dir = s.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const va = col.val(a), vb = col.val(b);
    if (col.type === 'num') return (va - vb) * dir;
    const sa = String(va), sb = String(vb);
    if (!sa && sb) return 1; // blanks always sort last
    if (sa && !sb) return -1;
    return sa.localeCompare(sb) * dir;
  });
}

// Sortable TAT table — clicking a header sorts THIS table only; it never
// affects the other tables or the tab-level filters.
function renderTatTable(tableId, rows, defaultSort) {
  const s = STATE.tatSort[tableId] || defaultSort;
  const head = TAT_COLUMNS.map((c) => {
    const active = s.key === c.key;
    const arrow = active ? (s.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="tat-th ${active ? 'sorted' : ''}" data-sort-table="${tableId}" data-sort-key="${c.key}" title="Sort by ${c.label}">${c.label}${arrow}</th>`;
  }).join('');
  const body = sortTatRows(rows, tableId, defaultSort)
    .map((i) => `<tr data-key="${i.key}">${TAT_COLUMNS.map((c) => `<td>${c.cell(i)}</td>`).join('')}</tr>`)
    .join('') || `<tr><td colspan="${TAT_COLUMNS.length}" class="empty">No deals</td></tr>`;
  return `<div class="tc tat-tc"><div class="tw"><table class="tat-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function renderTat() {
  renderTatSidebar();

  const issues = STATE.data.issues;
  const isActive = (i) => TAT_FY_STATUSES.includes(i.status);

  // FY26-27 (current): active-status deals starting on/after 1 May 2026, plus
  // any active deal still awaiting a start date. FY25-26: active-status deals
  // that started before 1 May 2026. Pending On Client: kept entirely separate.
  const fy2627 = applyTatFilters(issues.filter((i) => isActive(i) && (!i.solutioningStartDate || i.solutioningStartDate >= QUARTER_START)));
  const fy2526 = applyTatFilters(issues.filter((i) => isActive(i) && i.solutioningStartDate && i.solutioningStartDate < QUARTER_START));
  const pending = applyTatFilters(issues.filter((i) => i.status === PENDING_ON_CLIENT), { useStatus: false });

  // Health boxes + per-PSE chart are driven by the current FY26-27 active set.
  const good = fy2627.filter((i) => tatHealth(i.tatDays) === 'good');
  const mid = fy2627.filter((i) => tatHealth(i.tatDays) === 'mid');
  const review = fy2627.filter((i) => tatHealth(i.tatDays) === 'review');
  const avgActive = avg(fy2627.map((i) => i.tatDays).filter((d) => d != null));
  const avgHold = avg(fy2627.map((i) => i.tatHoldDays || 0));

  const boxes = [
    { id: 'all', label: 'Active Deals', value: fy2627.length, sub: 'FY26-27 · from 1 May 2026', color: 'var(--b)' },
    { id: 'good', label: 'Good', value: good.length, sub: '≤ 30 days', color: '#12B76A' },
    { id: 'mid', label: 'Mid', value: mid.length, sub: '31 – 60 days', color: '#D97706' },
    { id: 'review', label: 'Review', value: review.length, sub: '≥ 61 days', color: '#DC2626' },
    { id: 'poc', label: 'Pending On Client', value: pending.length, sub: 'client hold · separate', color: 'var(--pu)' },
  ];

  // A selected health box narrows the FY26-27 table only.
  const fy2627View = ({ good, mid, review }[STATE.tatBox]) || fy2627;

  // Per-PSE averages for the (larger, decluttered) chart.
  const byPse = {};
  fy2627.forEach((i) => { if (i.tatDays != null) (byPse[i.assignee] = byPse[i.assignee] || []).push(i.tatDays); });
  const avgByPse = Object.keys(byPse).map((p) => [p, avg(byPse[p])]).sort((a, b) => a[1] - b[1]);

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="ph-text"><div class="pht">TAT — Turnaround Time</div><div class="phs">Solutioning Start → SoW Send, excluding "Pending On Client" hold · live from Jira · Good ≤30d · Mid 31–60d · Review ≥61d</div></div></div>

      <div class="krow tat-boxes">
        ${boxes.map((b) => `
          <div class="kpi tat-box ${b.id === 'poc' ? 'tat-box-static' : STATE.tatBox === b.id ? 'active' : ''}" ${b.id !== 'poc' ? `data-box="${b.id}"` : ''}>
            <div class="kb" style="background:${b.color}"></div>
            <div class="kl">${b.label}</div>
            <div class="kv">${b.value}</div>
            <div class="ks">${b.sub}</div>
          </div>`).join('')}
      </div>

      <div class="krow tat-avg-row">
        <div class="kpi"><div class="kb" style="background:var(--b)"></div><div class="kl">Avg Active TAT</div><div class="kv">${avgActive ?? '—'}${avgActive != null ? 'd' : ''}</div><div class="ks">Across ${fy2627.length} active deals</div></div>
        <div class="kpi"><div class="kb" style="background:var(--a)"></div><div class="kl">Avg Client Hold Excluded</div><div class="kv">${avgHold ?? '—'}${avgHold != null ? 'd' : ''}</div><div class="ks">Pending On Client time removed</div></div>
      </div>

      <div class="card tat-chart-card">
        <div class="ct">Average Active TAT by PSE</div>
        <div class="cs">Lower is better (days) · colored by health band · click a bar to filter that PSE</div>
        <div class="tat-chart-wrap" style="height:${Math.max(240, avgByPse.length * 48 + 64)}px">${avgByPse.length ? '<canvas id="tatPseChart"></canvas>' : '<div class="empty">No active deals to chart</div>'}</div>
      </div>

      <div class="sh tat-section"><div class="sht">FY 26-27 · Current Active Deals${STATE.tatBox !== 'all' ? ` · ${STATE.tatBox.charAt(0).toUpperCase() + STATE.tatBox.slice(1)} only` : ''}</div><div class="shl"></div></div>
      <div class="phs tat-sub">Solutioning Start on/after 1 May 2026 · ${fy2627View.length} deal(s) · click any column header to sort this table only</div>
      ${renderTatTable('fy2627', fy2627View, { key: 'solutioningStartDate', dir: 'desc' })}

      <div class="sh tat-section"><div class="sht">FY 25-26 · Carried-Over Deals</div><div class="shl"></div></div>
      <div class="phs tat-sub">Solutioning Start before 1 May 2026 · ${fy2526.length} deal(s) · full overview, blanks left blank</div>
      ${renderTatTable('fy2526', fy2526, { key: 'solutioningStartDate', dir: 'desc' })}

      <div class="sh tat-section"><div class="sht">Pending On Client</div><div class="shl"></div></div>
      <div class="phs tat-sub">All cards currently on client hold — kept separate from active TAT · ${pending.length} deal(s)</div>
      ${renderTatTable('poc', pending, { key: 'solutioningStartDate', dir: 'desc' })}
    </div>`;

  document.querySelectorAll('tbody tr[data-key]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.jira-key-link')) return;
      openCardModal(tr.dataset.key);
    })
  );

  // Per-table header sort — local to each table, never affects the others.
  document.querySelectorAll('.tat-th').forEach((th) => {
    th.addEventListener('click', () => {
      const tableId = th.dataset.sortTable, key = th.dataset.sortKey;
      const cur = STATE.tatSort[tableId];
      const numeric = TAT_COLUMNS.find((c) => c.key === key).type === 'num';
      let dir;
      if (cur && cur.key === key) dir = cur.dir === 'asc' ? 'desc' : 'asc';
      else dir = numeric ? 'desc' : 'asc';
      STATE.tatSort[tableId] = { key, dir };
      renderTat();
    });
  });

  document.querySelectorAll('.tat-box[data-box]').forEach((box) => {
    box.addEventListener('click', () => {
      const b = box.dataset.box;
      STATE.tatBox = b !== 'all' && STATE.tatBox === b ? 'all' : b;
      renderTat();
    });
  });

  destroyCharts();
  if (avgByPse.length) {
    addChart(
      'tatPseChart', 'bar', avgByPse.map((e) => e[0]),
      [{ label: 'Avg Active TAT (days)', data: avgByPse.map((e) => e[1]), backgroundColor: avgByPse.map((e) => TAT_HEALTH_META[tatHealth(e[1])].color), borderRadius: 6, barThickness: 24 }],
      { indexAxis: 'y', scales: { y: { ticks: { autoSkip: false, font: { size: 13 } } }, x: { title: { display: true, text: 'Days (lower is better)' } } } },
      (pse) => { STATE.tatFilters.pse = new Set([pse]); STATE.tatBox = 'all'; renderTat(); }
    );
  }
}

// Exclusive TAT sidebar: PSE, Status (the 4 active), Health band.
function renderTatSidebar() {
  if (!STATE.facc) loadSidebarPrefs();
  const f = STATE.tatFilters;
  const activeCount = f.pse.size + f.status.size + f.health.size + f.kam.size + f.salesRep.size + (f.dealSize ? 1 : 0) + (f.search.trim() ? 1 : 0);
  const sb = document.getElementById('sidebar');
  sb.style.display = '';
  sb.classList.toggle('collapsed', STATE.sidebarCollapsed);
  const healthOpts = [['good', 'Good (≤30d)'], ['mid', 'Mid (31–60d)'], ['review', 'Review (≥61d)']];
  sb.innerHTML = `
    <div class="sb-header">
      <div class="sb-title">Filters${activeCount ? `<span class="facc-badge">${activeCount}</span>` : ''}</div>
      <button class="sb-toggle" id="sidebarToggleBtn" title="${STATE.sidebarCollapsed ? 'Expand filters' : 'Collapse filters'}">${STATE.sidebarCollapsed ? '»' : '«'}</button>
    </div>
    <div class="sb-content" id="sidebarContent" style="display:${STATE.sidebarCollapsed ? 'none' : ''}">
      <div class="sfgroup">
        <label>Deal Size</label>
        <select class="fs" id="tatDealSize">
          <option value="">All</option>
          <option value="large" ${f.dealSize === 'large' ? 'selected' : ''}>Large (&gt;$100k ARR)</option>
          <option value="small" ${f.dealSize === 'small' ? 'selected' : ''}>Small (&le;$100k ARR)</option>
        </select>
      </div>
      ${faccGroup('pse', 'PSE', checkboxListHtml('pse', STATE.options.pse, f.pse), f.pse.size)}
      ${faccGroup('status', 'Status', checkboxListHtml('status', TAT_FY_STATUSES, f.status), f.status.size)}
      ${faccGroup('kam', 'KAM', checkboxListHtml('kam', STATE.options.kam, f.kam), f.kam.size)}
      ${faccGroup('salesRep', 'Sales Representative', checkboxListHtml('salesRep', STATE.options.salesRep, f.salesRep), f.salesRep.size)}
      <div class="sfgroup">
        <label>Health</label>
        <div class="sf-opts">
          ${healthOpts.map(([v, lbl]) => `
            <label class="sf-opt">
              <input type="checkbox" data-tathealth="${v}" ${f.health.has(v) ? 'checked' : ''}/>
              <span>${lbl}</span>
            </label>`).join('')}
        </div>
      </div>
      <button class="clear-btn-full" id="clearTatFiltersBtn">Clear all filters</button>
    </div>`;

  document.getElementById('sidebarToggleBtn').addEventListener('click', () => {
    STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
    localStorage.setItem('psv_sidebar_collapsed', STATE.sidebarCollapsed ? '1' : '0');
    renderTatSidebar();
  });
  if (STATE.sidebarCollapsed) return;

  document.getElementById('tatDealSize').addEventListener('change', (e) => {
    STATE.tatFilters.dealSize = e.target.value;
    renderTat();
  });

  document.querySelectorAll('[data-facc-toggle]').forEach((head) => {
    head.addEventListener('click', () => {
      const id = head.dataset.faccToggle;
      STATE.facc[id] = !STATE.facc[id];
      localStorage.setItem('psv_facc_' + id, STATE.facc[id] ? '1' : '0');
      head.closest('.facc').classList.toggle('open', STATE.facc[id]);
    });
  });

  document.querySelectorAll('#sidebar [data-mgroup]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const set = STATE.tatFilters[cb.dataset.mgroup];
      if (cb.checked) set.add(cb.value);
      else set.delete(cb.value);
      renderTat();
    });
  });

  document.querySelectorAll('#sidebar [data-tathealth]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) STATE.tatFilters.health.add(cb.dataset.tathealth);
      else STATE.tatFilters.health.delete(cb.dataset.tathealth);
      renderTat();
    });
  });

  document.getElementById('clearTatFiltersBtn').addEventListener('click', () => {
    STATE.tatFilters = { pse: new Set(), status: new Set(), health: new Set(), kam: new Set(), salesRep: new Set(), dealSize: '', search: '' };
    STATE.tatBox = 'all';
    STATE.tatSort = {};
    renderTat();
  });
}

// ---------- Wins & Milestones tab (won/closed deals) ----------
// Board columns are labelled differently from their underlying Jira statuses
// (verified against the PSV board config) — map them back for display.
const WON_STATUS_LABEL = {
  'Closure/Contract Won': 'Contract Won',
  'In Progress': 'Ongoing Implementation',
  Completed: 'GoLive',
  'Final Golive': 'Final GoLive',
};
const wonLabel = (s) => WON_STATUS_LABEL[s] || s;
// This tab (only) surfaces cards with no PSE, grouped as "Unassigned", so a
// won deal is never invisible just because nobody's assigned to it yet.
const UNASSIGNED = 'Unassigned';
const winPse = (c) => c.assignee || UNASSIGNED;

// Financial-year quarters: Q1 May–Jul, Q2 Aug–Oct, Q3 Nov–Jan, Q4 Feb–Apr.
// FY 26-27 therefore runs 1 May 2026 → 30 Apr 2027.
function fyOf(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const startYear = m >= 5 ? y : y - 1;
  return `FY ${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
}
function quarterOf(dateStr) {
  const m = Number(dateStr.split('-')[1]);
  if (m >= 5 && m <= 7) return 'Q1';
  if (m >= 8 && m <= 10) return 'Q2';
  if (m === 11 || m === 12 || m === 1) return 'Q3';
  return 'Q4';
}
const QUARTER_RANGE = { Q1: '1 May – 31 Jul', Q2: '1 Aug – 31 Oct', Q3: '1 Nov – 31 Jan', Q4: '1 Feb – 30 Apr' };
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
// Deal close date = Commercial Sign-Off Date (primary). Deals without one are
// still shown, grouped separately, so nothing won is ever hidden.
const closeDateOf = (c) => c.commercialSignOffDate || null;

function applyWinFilters(cards) {
  const f = STATE.winFilters;
  const search = f.search.trim().toLowerCase();
  return cards.filter((c) => {
    if (f.pse.size && !f.pse.has(winPse(c))) return false;
    if (f.status.size && !f.status.has(c.status)) return false;
    if (search) {
      const hay = `${c.key} ${c.summary || ''} ${winPse(c)} ${c.kam || ''} ${c.salesRep || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

async function renderTeam() {
  document.getElementById('app').innerHTML = '<div class="page"><div class="loading">Loading won deals…</div></div>';
  try {
    const res = await fetch('/api/update-check?set=won', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    STATE.winCards = (await res.json()).cards || [];
  } catch (err) {
    document.getElementById('app').innerHTML = `<div class="page"><div class="empty">Could not load won deals: ${err.message}</div></div>`;
    return;
  }
  renderTeamView();
}

function winRow(c) {
  const arr = c.mrr ? c.mrr * 12 : null;
  return `
    <tr data-key="${c.key}">
      <td class="win-client">${c.summary || '<span class="tat-blank">—</span>'}</td>
      <td><a class="jira-key-link" href="${c.url}" target="_blank" rel="noopener" title="Open ${c.key} in Jira">${c.key} ↗</a></td>
      <td>${wonLabel(c.status)}</td>
      <td class="win-num">${c.mrr ? fmtUsd(c.mrr) : '<span class="tat-blank">—</span>'}</td>
      <td class="win-num">${arr ? fmtUsd(arr) : '<span class="tat-blank">—</span>'}</td>
      <td>${fmtDdMmYyyy(c.commercialSignOffDate) || '<span class="tat-blank">— not set —</span>'}</td>
      <td>${fmtDdMmYyyy(c.sowSignOffDate) || '<span class="tat-blank">—</span>'}</td>
    </tr>`;
}

// One PSE block: their deals plus a totals footer (count, MRR, ARR).
function winPseBlock(pse, list) {
  const totalMrr = list.reduce((s, c) => s + (c.mrr || 0), 0);
  const isUnassigned = pse === UNASSIGNED;
  return `
    <div class="tc win-pse ${isUnassigned ? 'win-pse-unassigned' : ''}">
      <div class="th">
        <span class="tht">${isUnassigned ? '⚠️ ' + pse : pse}</span>
        <span class="ths">${list.length} deal(s)${isUnassigned ? ' · no PSE set in Jira' : ''}</span>
        <span class="win-total-pill">Total MRR ${fmtUsd(totalMrr)} · ARR ${fmtUsd(totalMrr * 12)}</span>
      </div>
      <div class="tw">
        <table class="win-table">
          <thead><tr><th style="width:26%">Client Name</th><th>Project Card</th><th>Status</th><th>MRR</th><th>ARR</th><th>Commercial Sign-Off</th><th>SoW Sign-Off</th></tr></thead>
          <tbody>${list.map(winRow).join('')}</tbody>
          <tfoot><tr class="win-foot"><td colspan="3">Total — ${pse}</td><td class="win-num">${fmtUsd(totalMrr)}</td><td class="win-num">${fmtUsd(totalMrr * 12)}</td><td colspan="2"></td></tr></tfoot>
        </table>
      </div>
    </div>`;
}

// A full FY section: quarter chips + per-quarter, per-PSE tables.
function winFySection(fy, cards, noDateCards) {
  const sel = STATE.winTableQuarter[fy] || 'All';
  const inQ = (q) => cards.filter((c) => quarterOf(closeDateOf(c)) === q);
  const shownQuarters = sel === 'All' ? QUARTERS : [sel];
  const totalMrr = cards.reduce((s, c) => s + (c.mrr || 0), 0);

  const quarterBlocks = shownQuarters
    .map((q) => {
      const qCards = inQ(q);
      if (!qCards.length) return '';
      const qMrr = qCards.reduce((s, c) => s + (c.mrr || 0), 0);
      const byPse = {};
      qCards.forEach((c) => { (byPse[winPse(c)] = byPse[winPse(c)] || []).push(c); });
      const pses = Object.keys(byPse).sort();
      return `
        <div class="win-q">
          <div class="win-q-head">
            <span class="win-q-name">${q}</span>
            <span class="win-q-range">${QUARTER_RANGE[q]}</span>
            <span class="win-q-stats">${qCards.length} deal(s) · ${fmtUsd(qMrr)} MRR · ${fmtUsd(qMrr * 12)} ARR</span>
          </div>
          ${pses.map((p) => winPseBlock(p, byPse[p].slice().sort((a, b) => (b.mrr || 0) - (a.mrr || 0)))).join('')}
        </div>`;
    })
    .join('');

  // Deals won by status but with no Commercial Sign-Off Date yet — surfaced
  // under the current FY so they're never silently dropped.
  const noDateBlock = noDateCards && noDateCards.length
    ? (() => {
        const byPse = {};
        noDateCards.forEach((c) => { (byPse[winPse(c)] = byPse[winPse(c)] || []).push(c); });
        const nMrr = noDateCards.reduce((s, c) => s + (c.mrr || 0), 0);
        return `
        <div class="win-q win-q-nodate">
          <div class="win-q-head">
            <span class="win-q-name">—</span>
            <span class="win-q-range">Commercial Sign-Off Date not set</span>
            <span class="win-q-stats">${noDateCards.length} deal(s) · ${fmtUsd(nMrr)} MRR · ${fmtUsd(nMrr * 12)} ARR</span>
          </div>
          ${Object.keys(byPse).sort().map((p) => winPseBlock(p, byPse[p])).join('')}
        </div>`;
      })()
    : '';

  return `
    <div class="sh win-fy-head"><div class="sht">${fy} — Won &amp; Closed Deals</div><div class="shl"></div><div class="shb">${cards.length} deal(s) · ${fmtUsd(totalMrr)} MRR</div></div>
    <div class="win-qchips">
      ${['All', ...QUARTERS].map((q) => `<button class="win-chip ${sel === q ? 'active' : ''}" data-win-q="${fy}|${q}">${q}${q !== 'All' ? ` <span class="win-chip-n">${inQ(q).length}</span>` : ` <span class="win-chip-n">${cards.length}</span>`}</button>`).join('')}
    </div>
    ${quarterBlocks || (sel === 'All' ? '' : '<div class="empty">No deals closed in this quarter</div>')}
    ${sel === 'All' ? noDateBlock : ''}
    ${!quarterBlocks && !(sel === 'All' && noDateBlock) ? '<div class="empty">No won deals in this financial year yet</div>' : ''}`;
}

function renderTeamView() {
  renderTeamSidebar();
  const all = applyWinFilters(STATE.winCards || []);
  const dated = all.filter((c) => closeDateOf(c));
  const undated = all.filter((c) => !closeDateOf(c));

  // ---- stat section (own FY + Quarter toggles, independent of the tables) ----
  const fyList = [...new Set(dated.map((c) => fyOf(closeDateOf(c))))].sort().reverse();
  const sf = STATE.winStatFilter;
  if (sf.fy !== 'All' && !fyList.includes(sf.fy)) sf.fy = 'All';
  let statCards = dated;
  if (sf.fy !== 'All') statCards = statCards.filter((c) => fyOf(closeDateOf(c)) === sf.fy);
  if (sf.q !== 'All') statCards = statCards.filter((c) => quarterOf(closeDateOf(c)) === sf.q);
  // "All / All" includes undated deals so the headline count matches reality.
  if (sf.fy === 'All' && sf.q === 'All') statCards = statCards.concat(undated);

  const statMrr = statCards.reduce((s, c) => s + (c.mrr || 0), 0);
  const statByPse = {};
  statCards.forEach((c) => {
    const p = winPse(c);
    statByPse[p] = statByPse[p] || { n: 0, mrr: 0 };
    statByPse[p].n++;
    statByPse[p].mrr += c.mrr || 0;
  });
  const statPses = Object.keys(statByPse).sort((a, b) => statByPse[b].mrr - statByPse[a].mrr);

  const fy2627 = dated.filter((c) => fyOf(closeDateOf(c)) === 'FY 26-27');
  const fy2526 = dated.filter((c) => fyOf(closeDateOf(c)) === 'FY 25-26');
  // Any other financial year with wins (e.g. an older FY 24-25 deal) still gets
  // its own section, so no won deal is ever silently dropped from this tab.
  const olderFys = fyList.filter((f) => f !== 'FY 26-27' && f !== 'FY 25-26');

  document.getElementById('app').innerHTML = `
    <div class="page tk-page">
      <div class="ph"><div class="ph-text">
        <div class="pht">🏆 Wins &amp; Milestones</div>
        <div class="phs">Every won / closed deal, live from Jira · close date = Commercial Sign-Off Date · ARR auto-calculated as MRR × 12 · Q1 May–Jul · Q2 Aug–Oct · Q3 Nov–Jan · Q4 Feb–Apr</div>
      </div></div>

      <div class="win-stats">
        <div class="win-stats-head">
          <span class="win-stats-title">Team Scoreboard</span>
          <div class="win-toggles">
            <span class="win-tg-label">FY</span>
            ${['All', ...fyList].map((f) => `<button class="win-chip ${sf.fy === f ? 'active' : ''}" data-win-sfy="${f}">${f}</button>`).join('')}
            <span class="win-tg-sep"></span>
            <span class="win-tg-label">Quarter</span>
            ${['All', ...QUARTERS].map((q) => `<button class="win-chip ${sf.q === q ? 'active' : ''}" data-win-sq="${q}">${q}</button>`).join('')}
          </div>
        </div>
        <div class="krow win-krow">
          <div class="kpi win-kpi-hero"><div class="kb" style="background:#12B76A"></div><div class="kl">Deals Won</div><div class="kv">${statCards.length}</div><div class="ks">${sf.fy === 'All' ? 'All time' : sf.fy}${sf.q !== 'All' ? ' · ' + sf.q : ''}</div></div>
          <div class="kpi"><div class="kb" style="background:var(--b)"></div><div class="kl">Total MRR</div><div class="kv" style="font-size:22px">${fmtUsd(statMrr)}</div><div class="ks">Sum of won-deal MRR</div></div>
          <div class="kpi"><div class="kb" style="background:var(--pu)"></div><div class="kl">Total ARR</div><div class="kv" style="font-size:22px">${fmtUsd(statMrr * 12)}</div><div class="ks">MRR × 12</div></div>
          <div class="kpi"><div class="kb" style="background:var(--a)"></div><div class="kl">Contributing PSEs</div><div class="kv">${statPses.length}</div><div class="ks">With at least one win</div></div>
        </div>
        <div class="win-pse-grid">
          ${statPses.map((p) => `
            <div class="win-pse-card">
              <div class="win-pse-name">${p}</div>
              <div class="win-pse-n">${statByPse[p].n}<span class="win-pse-n-l">deals</span></div>
              <div class="win-pse-mrr">${fmtUsd(statByPse[p].mrr)} MRR</div>
              <div class="win-pse-arr">${fmtUsd(statByPse[p].mrr * 12)} ARR</div>
            </div>`).join('') || '<div class="empty">No wins match the current filters</div>'}
        </div>
      </div>

      ${winFySection('FY 26-27', fy2627, undated)}
      ${winFySection('FY 25-26', fy2526, null)}
      ${olderFys.map((f) => winFySection(f, dated.filter((c) => fyOf(closeDateOf(c)) === f), null)).join('')}
    </div>`;

  document.querySelectorAll('tbody tr[data-key]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.jira-key-link')) return;
      openWinDetail(tr.dataset.key);
    })
  );
  document.querySelectorAll('[data-win-sfy]').forEach((b) =>
    b.addEventListener('click', () => { STATE.winStatFilter.fy = b.dataset.winSfy; renderTeamView(); })
  );
  document.querySelectorAll('[data-win-sq]').forEach((b) =>
    b.addEventListener('click', () => { STATE.winStatFilter.q = b.dataset.winSq; renderTeamView(); })
  );
  document.querySelectorAll('[data-win-q]').forEach((b) =>
    b.addEventListener('click', () => {
      const [fy, q] = b.dataset.winQ.split('|');
      STATE.winTableQuarter[fy] = q;
      renderTeamView();
    })
  );
  destroyCharts();
}

// Reuses the shared card modal for a won deal's full detail.
function openWinDetail(key, source) {
  const c = (source || STATE.winCards || []).find((x) => x.key === key);
  if (!c) return;
  const field = (l, v) => `<div><div class="mf-l">${l}</div><div class="mf-v">${v ?? '—'}</div></div>`;
  const d = (x) => fmtDdMmYyyy(x) || '—';
  document.getElementById('modalContent').innerHTML = `
    <div class="modal-head">
      <div><div class="modal-key">${c.key}</div><div class="modal-title">${c.summary || ''}</div></div>
      <button class="modal-close" id="modalCloseBtn">✕</button>
    </div>
    <div class="modal-body">
      <div class="mfields">
        ${field('Status', wonLabel(c.status))}
        ${field('PSE', winPse(c))}
        ${field('KAM', c.kam)}
        ${field('Sales Representative', c.salesRep)}
        ${field('MRR (USD)', c.mrr ? fmtUsd(c.mrr) : '—')}
        ${field('ARR (USD)', c.mrr ? fmtUsd(c.mrr * 12) : '—')}
        ${field('Commercial Sign-Off Date', d(c.commercialSignOffDate))}
        ${field('SoW Sign-Off Date', d(c.sowSignOffDate))}
        ${field('Financial Year', c.commercialSignOffDate ? fyOf(c.commercialSignOffDate) : '—')}
        ${field('Quarter', c.commercialSignOffDate ? quarterOf(c.commercialSignOffDate) : '—')}
      </div>
      <a class="jira-link" href="${c.url}" target="_blank" rel="noopener">Open in Jira →</a>
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
}

// Exclusive sidebar for this tab: PSE + won-status.
function renderTeamSidebar() {
  if (!STATE.facc) loadSidebarPrefs();
  const f = STATE.winFilters;
  const cards = STATE.winCards || [];
  const pses = distinct(cards.map(winPse));
  const statuses = distinct(cards.map((c) => c.status));
  const activeCount = f.pse.size + f.status.size + (f.search.trim() ? 1 : 0);
  const sb = document.getElementById('sidebar');
  sb.style.display = '';
  sb.classList.toggle('collapsed', STATE.sidebarCollapsed);
  sb.innerHTML = `
    <div class="sb-header">
      <div class="sb-title">Filters${activeCount ? `<span class="facc-badge">${activeCount}</span>` : ''}</div>
      <button class="sb-toggle" id="sidebarToggleBtn" title="${STATE.sidebarCollapsed ? 'Expand filters' : 'Collapse filters'}">${STATE.sidebarCollapsed ? '»' : '«'}</button>
    </div>
    <div class="sb-content" style="display:${STATE.sidebarCollapsed ? 'none' : ''}">
      ${faccGroup('pse', 'PSE', checkboxListHtml('pse', pses, f.pse), f.pse.size)}
      ${faccGroup('status', 'Won Status', checkboxListHtml('status', statuses, f.status, wonLabel), f.status.size)}
      <button class="clear-btn-full" id="clearWinFiltersBtn">Clear all filters</button>
    </div>`;

  document.getElementById('sidebarToggleBtn').addEventListener('click', () => {
    STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
    localStorage.setItem('psv_sidebar_collapsed', STATE.sidebarCollapsed ? '1' : '0');
    renderTeamSidebar();
  });
  if (STATE.sidebarCollapsed) return;

  document.querySelectorAll('[data-facc-toggle]').forEach((head) => {
    head.addEventListener('click', () => {
      const id = head.dataset.faccToggle;
      STATE.facc[id] = !STATE.facc[id];
      localStorage.setItem('psv_facc_' + id, STATE.facc[id] ? '1' : '0');
      head.closest('.facc').classList.toggle('open', STATE.facc[id]);
    });
  });
  document.querySelectorAll('#sidebar [data-mgroup]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const set = STATE.winFilters[cb.dataset.mgroup];
      if (cb.checked) set.add(cb.value);
      else set.delete(cb.value);
      renderTeamView();
    });
  });
  document.getElementById('clearWinFiltersBtn').addEventListener('click', () => {
    STATE.winFilters = { pse: new Set(), status: new Set(), search: '' };
    renderTeamView();
  });
}

// ---------- activity log ----------
// This tab has its own left-sidebar filter set (PSE, Status, Deal Name,
// From–To date range) instead of the universal Jira filters — the universal
// set doesn't apply well to a per-change activity feed, so it's swapped out
// the same way Quick Links swaps in its own group filter.
function istDateOf(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(timestamp));
}

function applyActivityFilters(allActivity) {
  const f = STATE.activityFilters;
  const dealName = f.dealName.trim().toLowerCase();
  return allActivity.filter((a) => {
    if (f.pse.size && !f.pse.has(a.assignee)) return false;
    if (f.status.size && !f.status.has(a.status)) return false;
    if (dealName && !`${a.summary || ''}`.toLowerCase().includes(dealName)) return false;
    const day = istDateOf(a.created);
    if (f.dateFrom && day < f.dateFrom) return false;
    if (f.dateTo && day > f.dateTo) return false;
    return true;
  });
}

function renderActivity() {
  const allActivity = STATE.data.issues
    .flatMap((i) => (i.history || []).map((h) => ({ ...h, key: i.key, summary: i.summary, assignee: i.assignee, status: i.status })))
    .sort((a, b) => new Date(b.created) - new Date(a.created));

  const feed = applyActivityFilters(allActivity).slice(0, 400);

  renderActivitySidebar();

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">Jira Activity Log</div><div class="phs">Every field change across all PSV cards, most recent first · showing ${feed.length} of ${allActivity.length} · use the sidebar filters</div></div>
      <div class="tc">
        <div class="th"><span class="tht">Activity Feed</span><span class="ths">Board-wide</span></div>
        <div class="tw" style="padding:14px 18px">
          ${
            feed
              .map(
                (a) => `
            <div class="tl-item">
              <div class="tl-dot"></div>
              <div class="tl-body">
                <div class="tl-desc">${describeActivity(a)} — <span class="tl-key" data-key="${a.key}">${a.key}</span> <span style="color:var(--t3)">${a.summary || ''}</span></div>
                <div class="tl-meta">${a.author || 'Unknown'} · ${fmtDdMmYyyyTime(a.created)} IST</div>
              </div>
            </div>`
              )
              .join('') || '<div class="empty">No activity found</div>'
          }
        </div>
      </div>
    </div>`;

  document.querySelectorAll('.tl-key').forEach((el) => el.addEventListener('click', () => openCardModal(el.dataset.key)));
}

function renderActivitySidebar() {
  if (!STATE.facc) loadSidebarPrefs(); // reuses the same collapsed-state flag/localStorage keys as the universal sidebar
  const f = STATE.activityFilters;
  const activeCount = f.pse.size + f.status.size + (f.dealName.trim() ? 1 : 0) + (f.dateFrom ? 1 : 0) + (f.dateTo ? 1 : 0);
  const sb = document.getElementById('sidebar');
  sb.style.display = '';
  sb.classList.toggle('collapsed', STATE.sidebarCollapsed);
  sb.innerHTML = `
    <div class="sb-header">
      <div class="sb-title">Filters${activeCount ? `<span class="facc-badge">${activeCount}</span>` : ''}</div>
      <button class="sb-toggle" id="sidebarToggleBtn" title="${STATE.sidebarCollapsed ? 'Expand filters' : 'Collapse filters'}">${STATE.sidebarCollapsed ? '»' : '«'}</button>
    </div>
    <div class="sb-content" id="sidebarContent" style="display:${STATE.sidebarCollapsed ? 'none' : ''}">
      <div class="sfgroup">
        <label>Deal Name</label>
        <input class="fi" id="actDealNameInput" type="text" placeholder="Search deal name…" value="${escapeAttr(f.dealName)}"/>
      </div>

      ${faccGroup('pse', 'PSE', checkboxListHtml('pse', STATE.options.pse, f.pse), f.pse.size)}
      ${faccGroup('status', 'Status', checkboxListHtml('status', STATE.options.status, f.status), f.status.size)}

      <div class="sfgroup">
        <label>Date Range (From – To)</label>
        <div class="sf-daterow">
          <input type="date" class="fi" id="actDateFromInput" value="${f.dateFrom}"/>
          <input type="date" class="fi" id="actDateToInput" value="${f.dateTo}"/>
        </div>
      </div>

      <button class="clear-btn-full" id="clearActivityFiltersBtn">Clear all filters</button>
    </div>`;

  bindActivitySidebarEvents();
}

function bindActivitySidebarEvents() {
  document.getElementById('sidebarToggleBtn').addEventListener('click', () => {
    STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
    localStorage.setItem('psv_sidebar_collapsed', STATE.sidebarCollapsed ? '1' : '0');
    renderActivitySidebar();
  });

  if (STATE.sidebarCollapsed) return;

  document.getElementById('actDealNameInput').addEventListener('input', (e) => {
    STATE.activityFilters.dealName = e.target.value;
    renderActivity();
  });

  document.getElementById('actDateFromInput').addEventListener('change', (e) => {
    STATE.activityFilters.dateFrom = e.target.value;
    renderActivity();
  });

  document.getElementById('actDateToInput').addEventListener('change', (e) => {
    STATE.activityFilters.dateTo = e.target.value;
    renderActivity();
  });

  document.querySelectorAll('[data-facc-toggle]').forEach((head) => {
    head.addEventListener('click', () => {
      const id = head.dataset.faccToggle;
      STATE.facc[id] = !STATE.facc[id];
      localStorage.setItem('psv_facc_' + id, STATE.facc[id] ? '1' : '0');
      head.closest('.facc').classList.toggle('open', STATE.facc[id]);
    });
  });

  document.querySelectorAll('#sidebar [data-mgroup]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const group = cb.dataset.mgroup;
      const set = STATE.activityFilters[group];
      if (cb.checked) set.add(cb.value);
      else set.delete(cb.value);
      renderActivity();
    });
  });

  document.getElementById('clearActivityFiltersBtn').addEventListener('click', () => {
    STATE.activityFilters = { pse: new Set(), status: new Set(), dealName: '', dateFrom: '', dateTo: '' };
    renderActivity();
  });
}

function describeActivity(h) {
  if (h.field === 'status') return `Status moved from <b>${h.from || '—'}</b> to <b>${h.to || '—'}</b>`;
  if (h.field === 'assignee') return `PSE changed from <b>${h.from || 'Unassigned'}</b> to <b>${h.to || 'Unassigned'}</b>`;
  if (h.field === 'priority') return `Priority changed from <b>${h.from || '—'}</b> to <b>${h.to || '—'}</b>`;
  if (h.field === 'Comment') return `Comment added`;
  return `<b>${h.field}</b> updated${h.to ? ` to <b>${h.to}</b>` : ''}`;
}

// ---------- Daily Task Tracker tab (manually entered, own persistent storage) ----------
function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

// Pure calendar-date arithmetic in UTC, so it's immune to the browser's local timezone/DST.
function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// 0=Sun … 6=Sat, computed in UTC on the bare date so it matches lib/tracker.js.
function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}
function isWeekendDay(dateStr) {
  const d = dayOfWeek(dateStr);
  return d === 0 || d === 6;
}
// A globally-marked official holiday (persisted, shared across all PSEs).
function isHolidayDay(dateStr) {
  return !!(STATE.trackerHolidays && STATE.trackerHolidays[dateStr]);
}
// Neither a working day for reports nor counted in delay: weekend OR holiday.
function isNonWorkingDay(dateStr) {
  return isWeekendDay(dateStr) || isHolidayDay(dateStr);
}
// PSEs don't work weekends, so Prev/Next step over Sat/Sun entirely.
function stepWorkingDay(dateStr, dir) {
  let d = addDays(dateStr, dir);
  while (isWeekendDay(d)) d = addDays(d, dir);
  return d;
}
// If today is a weekend, the tracker opens on the most recent working day.
function lastWorkingDayOnOrBefore(dateStr) {
  let d = dateStr;
  while (isWeekendDay(d)) d = addDays(d, -1);
  return d;
}
function mondayOfWeek(dateStr) {
  const dow = dayOfWeek(dateStr); // 0..6, Mon=1
  const back = dow === 0 ? 6 : dow - 1; // Sunday counts as end of the prior week
  return addDays(dateStr, -back);
}
function firstMondayOfMonth(year, monthIndex) {
  for (let day = 1; day <= 7; day++) {
    const ds = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (dayOfWeek(ds) === 1) return ds;
  }
  return null;
}
// The monthly report period runs first-Monday-of-month → day before the next
// month's first Monday. Given any day, find which period it belongs to.
function monthlyPeriodFor(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  let startY = y;
  let startM = m - 1; // 0-based
  let start = firstMondayOfMonth(startY, startM);
  if (dateStr < start) {
    startM -= 1;
    if (startM < 0) { startM = 11; startY -= 1; }
    start = firstMondayOfMonth(startY, startM);
  }
  let nextY = startY;
  let nextM = startM + 1;
  if (nextM > 11) { nextM = 0; nextY += 1; }
  const end = addDays(firstMondayOfMonth(nextY, nextM), -1);
  return { start, end, year: startY, monthIndex: startM };
}
// Inclusive list of working-day date strings between from and to — excludes
// weekends AND official holidays, so reports never count an off-day as expected work.
function workingDaysBetween(from, to) {
  const days = [];
  let d = from;
  while (d <= to) {
    if (!isNonWorkingDay(d)) days.push(d);
    d = addDays(d, 1);
  }
  return days;
}

// Report windows start fresh on these dates (per spec); anything earlier just
// shows a "not started yet" note rather than partial data.
const WEEKLY_REPORT_START = '2026-07-27'; // Monday
const MONTHLY_REPORT_START = '2026-08-03'; // first Monday of Aug 2026

// Aggregate one PSE's stats over a window of working days. A task counts if it
// is ACTIVE on the sheet on any day in the window (start date reached; carried
// forward until Done) — matching exactly what shows on the day's sheet.
// Completed is a subset of that total; delayed = finished after / still open
// past its (flexible) due date.
function pseStats(tasks, leave, pse, days, referenceDay = istToday()) {
  let total = 0, doneCount = 0, delayed = 0, unmarked = 0, leaveDays = 0, extraDaysTotal = 0;
  const delayedList = [];
  for (const d of days) if (leave[`${pse}|${d}`]) leaveDays++;
  for (const t of tasks) {
    if (t.pse !== pse) continue;
    const active = days.some((d) => taskVisibleOnDay(t, d));
    if (!active) continue;
    total++;
    if (t.status === 'Done') doneCount++;
    else unmarked++;
    const late = taskDelayDays(t, referenceDay);
    if (late > 0) {
      delayed++;
      extraDaysTotal += late;
      delayedList.push({ name: t.dealName || '(unnamed task)', d: late });
    }
  }
  const rate = total ? Math.round((doneCount / total) * 100) : null;
  return { due: total, doneCount, delayed, unmarked, leaveDays, extraDaysTotal, delayedList, rate };
}

// Mirrors lib/tracker.js. Visibility is anchored on the editable Task Start
// Date (fallback: creation date). A task recurs on every day from its start
// date onward; changing the start date shifts it onto that day's page. Once
// Done it's pinned to its start, completion, and due days.
function taskStart(task) {
  return task.taskStartDate || task.createdDate;
}
function taskVisibleOnDay(task, day) {
  const start = taskStart(task);
  const planned = task.createdDate || start;
  // Carry forward from the EARLIER of Planned On / Start Date, so a
  // future-dated task stays on every day's sheet from the day it was planned
  // (no invisible gap before its Start Date arrives) until it's marked Done.
  const first = planned < start ? planned : start;
  if (day < first) return false;
  if (task.status === 'Done') {
    // Exactly 2 fixed pages once Done: the Task Start Date, and the Due Date
    // (which doubles as the "marked done" record regardless of which day it
    // was actually marked done on) -- the actual completion day is used for
    // lateness math elsewhere, but does NOT get its own page.
    return day === start || day === task.dueDate;
  }
  return true;
}

// A task raised by any OTHER PSE with Flag Apoorv = Yes surfaces as a fixed
// notification inside Apoorv's own table — a shared record, not a copy: its
// status stays live-synced with the owning PSE's table (same task id), and
// Apoorv can also change the status directly from his flagged view.
function isFlaggedForApoorv(task) {
  return !!task.flagApoorv && task.pse !== 'Apoorv';
}
// Driven entirely by the "seen" checkbox: recurs every day from its Task
// Start Date onward until Apoorv marks it seen, so it can't be missed. Once
// checked, it becomes a "hard-surfaced fixed record" shown ONLY on its Task
// Start Date.
function flaggedVisibleOnDay(task, day) {
  if (!task.apoorvSeen) return taskStart(task) <= day;
  return day === taskStart(task);
}

function daysBetween(fromStr, toStr) {
  return Math.round((Date.parse(toStr + 'T00:00:00Z') - Date.parse(fromStr + 'T00:00:00Z')) / 86400000);
}
// Working days strictly after `from`, up to and including `to`. Weekends and
// official holidays don't count — so a Friday→Monday slip is 1 day late, not 3.
function workingDaysAfter(from, to) {
  if (!from || !to || to <= from) return 0;
  let count = 0;
  let d = addDays(from, 1);
  while (d <= to) {
    if (!isNonWorkingDay(d)) count++;
    d = addDays(d, 1);
  }
  return count;
}

// Working days late against the CURRENT (flexible) due date — 0 if on time or
// no due date. For a Done task, measured to its completion; for an open task,
// to the reference day.
// "Delayed" means only one thing: still open and past its CURRENT due date.
//   - Finishing late is not a delay — once a task is Done it's never counted,
//     no matter when it was actually completed.
//   - Moving a due date is not a delay — the count always measures against the
//     current due date, so pushing it out clears the flag immediately.
// Every delay signal on this tab (red row, summary tile, report tables) comes
// from this one function, so they all stay consistent.
function taskDelayDays(task, referenceDay = istToday()) {
  if (task.status === 'Done') return 0;
  const due = task.dueDate;
  if (!due) return 0;
  return workingDaysAfter(due, referenceDay);
}
function taskOverdue(task, referenceDay = istToday()) {
  return taskDelayDays(task, referenceDay) > 0;
}

const trackerSaveTimers = {};

async function renderTracker() {
  document.getElementById('app').innerHTML = '<div class="page"><div class="loading">Loading tracker…</div></div>';
  if (!STATE.trackerDay) STATE.trackerDay = lastWorkingDayOnOrBefore(istToday());
  try {
    const [tasks, leave, holidays] = await Promise.all([
      fetch('/api/tracker', { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
      fetch('/api/tracker?resource=leave', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})),
      fetch('/api/tracker?resource=holidays', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})),
    ]);
    STATE.trackerTasks = tasks;
    STATE.trackerLeave = leave || {};
    STATE.trackerHolidays = holidays || {};
  } catch (err) {
    document.getElementById('app').innerHTML = `<div class="page"><div class="empty">Could not load the task tracker: ${err.message}</div></div>`;
    return;
  }
  renderTrackerView();
}

// A native <input type="date"> renders its closed-state text in whatever
// locale the BROWSER is set to, not the page's — the `lang` attribute is
// honored by Firefox but ignored by Chrome/Edge, so on a US-locale browser
// it shows MM/DD/YYYY no matter what we put in the HTML. To guarantee
// DD/MM/YYYY everywhere regardless of the viewer's browser, the native input
// is kept (so the calendar picker + underlying ISO value/save logic are
// unchanged) but visually hidden behind a readonly text field that always
// displays the date via fmtDdMmYyyy; clicking the text opens the native
// picker via showPicker().
function trackerDateFieldHtml(field, isoValue, title) {
  return `<div class="tk-date-wrap">
    <input type="text" class="tk-input tk-date-text" readonly value="${fmtDdMmYyyy(isoValue) || ''}" placeholder="DD/MM/YYYY" title="${title}"/>
    <input type="date" class="tk-input tk-date-native" data-field="${field}" value="${isoValue || ''}" tabindex="-1" aria-hidden="true"/>
  </div>`;
}

function trackerRow(t, day, { hideFlagCol = false } = {}) {
  const overdue = taskOverdue(t, day);
  const rowCls = overdue ? 'row-flagged' : '';
  // "Open" -> "Planned" (kept in sync with any not-yet-migrated legacy data).
  const statusVal = t.status === 'Open' ? 'Planned' : t.status || 'Planned';
  const statusCls = 'tk-status-' + statusVal.toLowerCase().replace(/\s+/g, '-');
  // Armed, 2-click delete confirmation — same pattern as the Flagged-for-Apoorv
  // panel, so nobody can delete a task with a single accidental click.
  const armed = STATE.taskDeleteId === t.id;

  return `
    <tr data-id="${t.id}" class="${rowCls}">
      <td class="tk-cell tk-cell-name"><textarea class="tk-input tk-textarea" data-field="dealName" rows="1" placeholder="Task name…">${escapeHtml(t.dealName || '')}</textarea></td>
      <td class="tk-cell tk-cell-date tk-cell-planned" title="Planned On — the day this task was actually added, fixed forever">${fmtDdMmYyyy(t.createdDate) || '—'}</td>
      <td class="tk-cell tk-cell-date">${trackerDateFieldHtml('taskStartDate', taskStart(t), 'Task Start Date — the task appears from this day onward; change it to move the task to another day')}</td>
      <td class="tk-cell">
        <select class="tk-select tk-select-status ${statusCls}" data-field="status">
          ${['Planned', 'In Progress', 'Done'].map((s) => `<option value="${s}" ${statusVal === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="tk-cell tk-cell-date">${trackerDateFieldHtml('dueDate', t.dueDate, 'Due date (editable)')}</td>
      ${hideFlagCol ? '' : `<td class="tk-cell">
        <select class="tk-select tk-select-yn ${t.flagApoorv ? 'yn-yes' : 'yn-no'}" data-field="flagApoorv">
          <option value="false" ${!t.flagApoorv ? 'selected' : ''}>No</option>
          <option value="true" ${t.flagApoorv ? 'selected' : ''}>Yes</option>
        </select>
      </td>`}
      <td class="tk-cell">
        <select class="tk-select tk-select-yn ${t.helpInSow ? 'yn-yes' : 'yn-no'}" data-field="helpInSow">
          <option value="false" ${!t.helpInSow ? 'selected' : ''}>No</option>
          <option value="true" ${t.helpInSow ? 'selected' : ''}>Yes</option>
        </select>
      </td>
      <td class="tk-cell"><textarea class="tk-input tk-textarea" data-field="blocker" rows="1" placeholder="Blocker…">${escapeHtml(t.blocker || '')}</textarea></td>
      <td class="tk-cell"><textarea class="tk-input tk-textarea" data-field="remarks" rows="1" placeholder="Remarks…">${escapeHtml(t.remarks || '')}</textarea></td>
      <td class="tk-cell"><button class="tk-del ${armed ? 'armed' : ''}" data-del-id="${t.id}" title="${armed ? 'Click again to confirm delete' : 'Delete this task'}">${armed ? 'Confirm ✕' : '✕'}</button></td>
    </tr>`;
}

// A row in Apoorv's "Flagged for Apoorv" notification table. Status is the
// SAME field on the SAME task record (data-id + data-field="status" reuse the
// existing generic save binding), so editing it here writes straight back to
// the owning PSE's table too — it's one shared record, not a duplicate.
function flaggedRow(t) {
  // Same armed, 2-click confirmation pattern used elsewhere in the app (e.g.
  // Quick Links) but scoped with its own state key so the two don't collide.
  const armed = STATE.flagDeleteId === t.id;
  // Only color rule: unseen = red, seen = light green.
  const rowStateCls = t.apoorvSeen ? 'tk-flag-row-seen' : '';
  return `
    <tr data-id="${t.id}" class="tk-flag-row ${rowStateCls}">
      <td class="tk-cell tk-cell-name"><span class="tk-flag-taskname">${escapeHtml(t.dealName || '(unnamed task)')}</span></td>
      <td class="tk-cell"><span class="tk-flag-raiser">${t.pse}</span></td>
      <td class="tk-cell"><span class="tk-flag-startdate">${fmtDdMmYyyy(taskStart(t))}</span></td>
      <td class="tk-cell"><textarea class="tk-input tk-textarea" data-field="remarks" rows="1" placeholder="Remarks…">${escapeHtml(t.remarks || '')}</textarea></td>
      <td class="tk-cell tk-cell-seen">
        <label class="tk-seen-toggle ${t.apoorvSeen ? 'checked' : ''}" title="Mark as seen by Apoorv">
          <input type="checkbox" class="tk-input tk-seen-cb" data-field="apoorvSeen" ${t.apoorvSeen ? 'checked' : ''}/>
          <span class="tk-seen-box"></span>
          <span class="tk-seen-text">${t.apoorvSeen ? '✓ Seen' : 'Mark Seen'}</span>
        </label>
      </td>
      <td class="tk-cell">
        <button class="tk-flag-del ${armed ? 'armed' : ''}" data-del-flag-id="${t.id}" title="${armed ? 'Click again to confirm delete' : 'Delete this task'}">${armed ? 'Confirm ✕' : '✕'}</button>
      </td>
    </tr>`;
}

// Which PSE sheets are visible given the tracker's own PSE filter.
function trackerVisiblePses() {
  const f = STATE.trackerFilters.pse;
  return f.size ? TRACKER_PSE_ROWS.filter((p) => f.has(p)) : TRACKER_PSE_ROWS;
}

// Row-level filters (status / help-in-SOW / flag) applied within a PSE sheet.
function trackerRowMatchesFilters(t) {
  const f = STATE.trackerFilters;
  const status = t.status === 'Open' ? 'Planned' : t.status; // legacy-data fallback
  if (f.status.size && !f.status.has(status)) return false;
  if (f.helpInSow && String(!!t.helpInSow) !== f.helpInSow) return false;
  if (f.flagApoorv && String(!!t.flagApoorv) !== f.flagApoorv) return false;
  const search = f.dealName.trim().toLowerCase();
  if (search) {
    const hay = `${t.dealName || ''} ${t.remarks || ''} ${t.blocker || ''}`.toLowerCase();
    if (!hay.includes(search)) return false;
  }
  return true;
}

function reportTable(title, subtitle, tasks, leave, days, pses) {
  const refDay = STATE.trackerDay || istToday();
  const rows = pses.map((pse) => {
    const s = pseStats(tasks, leave, pse, days, refDay);
    const rateCls = s.rate == null ? '' : s.rate >= 80 ? 'rate-good' : s.rate >= 50 ? 'rate-mid' : 'rate-bad';
    const delayedTip = s.delayedList.length ? escapeAttr(s.delayedList.map((x) => `${x.name} (${x.d}d late)`).join(', ')) : '';
    const delayedCell = s.delayed
      ? `<span class="delay-chip" title="Delayed tasks — ${delayedTip}">${s.delayed} · ${s.extraDaysTotal}d</span>`
      : '0';
    return `
      <tr class="${s.delayed ? 'report-row-delayed' : ''}">
        <td class="tk-cell"><b>${pse}</b></td>
        <td class="tk-cell">${s.due}</td>
        <td class="tk-cell">${s.doneCount}</td>
        <td class="tk-cell ${s.delayed ? 'cell-warn' : ''}">${delayedCell}</td>
        <td class="tk-cell ${s.unmarked ? 'cell-warn' : ''}">${s.unmarked}</td>
        <td class="tk-cell">${s.leaveDays}</td>
        <td class="tk-cell"><span class="rate-pill ${rateCls}">${s.rate == null ? '—' : s.rate + '%'}</span></td>
      </tr>`;
  }).join('');
  return `
    <div class="tc tk-report">
      <div class="th"><span class="tht">${title}</span><span class="ths">${subtitle}</span></div>
      <div class="tw">
        <table>
          <thead><tr><th>PSE</th><th title="All tasks on the sheet in this period">Total Tasks</th><th>Completed</th><th title="Finished after the due date, or still open past it — hover to see which">Delayed</th><th>Unmarked</th><th>On Leave</th><th>Completion</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function renderTrackerReports(tasks, leave, pses, day) {
  // Daily — the single working day being viewed.
  const daily = reportTable(
    'Daily Completion Result',
    new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' }),
    tasks, leave, [day], pses
  );

  // Weekly — Mon–Fri of the viewed week, not before the report start date.
  const weekStart = mondayOfWeek(day);
  let weekly;
  if (weekStart < WEEKLY_REPORT_START) {
    weekly = `<div class="tc tk-report"><div class="th"><span class="tht">Weekly Report</span></div><div class="tw"><div class="empty">Weekly reporting starts the week of Mon 27 Jul 2026</div></div></div>`;
  } else {
    const weekEnd = addDays(weekStart, 4);
    const days = workingDaysBetween(weekStart, weekEnd);
    const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    weekly = reportTable('Weekly Report', `Mon–Fri · ${fmt(weekStart)} – ${fmt(weekEnd)}`, tasks, leave, days, pses);
  }

  // Monthly — first-Monday-of-month period, not before the report start date.
  const period = monthlyPeriodFor(day);
  let monthly;
  if (period.start < MONTHLY_REPORT_START) {
    monthly = `<div class="tc tk-report"><div class="th"><span class="tht">Monthly Report</span></div><div class="tw"><div class="empty">Monthly reporting starts Mon 3 Aug 2026 (first Monday of the month)</div></div></div>`;
  } else {
    const days = workingDaysBetween(period.start, period.end);
    const monthName = new Date(period.start + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    monthly = reportTable('Monthly Report', `${monthName} · ${fmt(period.start)} – ${fmt(period.end)} (from first Monday)`, tasks, leave, days, pses);
  }

  // Optional custom-range report driven by the Date Bracket filter.
  const { dateFrom, dateTo } = STATE.trackerFilters;
  let custom = '';
  if (dateFrom && dateTo && dateFrom <= dateTo) {
    const days = workingDaysBetween(dateFrom, dateTo);
    const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    custom = reportTable('Custom Range Report', `${fmt(dateFrom)} – ${fmt(dateTo)} (working days only)`, tasks, leave, days, pses);
  }

  return `
    <div class="ph" style="margin-top:26px"><div class="pht" style="font-size:15px">Completion Tracker Reports</div><div class="phs">Auto-calculated · "Total Tasks" = every task on the sheet in the period · "Completed" is a subset · "Unmarked" = not yet Done · "Delayed" = past its due date · weekends & holidays excluded · leave days discounted</div></div>
    ${daily}
    ${custom}
    ${weekly}
    ${monthly}`;
}

function renderTrackerView() {
  const day = STATE.trackerDay;
  const allTasks = STATE.trackerTasks || [];
  const leave = STATE.trackerLeave || {};
  const isToday = day === istToday();
  const weekend = isWeekendDay(day);
  const holiday = isHolidayDay(day);
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  renderTrackerSidebar();

  // "Flagged For Apoorv" quick-filter: a dedicated results view showing ONLY
  // this table (every currently-flagged task, board-wide, regardless of day)
  // — nothing else on the page, per spec.
  if (STATE.trackerFilters.flagApoorv === 'true') {
    const flagged = allTasks
      .filter(isFlaggedForApoorv)
      .sort((a, b) => (a.apoorvSeen === b.apoorvSeen ? taskStart(a).localeCompare(taskStart(b)) : a.apoorvSeen ? 1 : -1));
    document.getElementById('app').innerHTML = `
      <div class="page tk-page">
        <div class="ph"><div class="ph-text"><div class="pht">Daily Task Tracker</div><div class="phs">Filtered to Flagged For Apoorv · ${flagged.length} task(s) board-wide, across all days</div></div></div>
        <div class="tc tk-flag-panel">
          <div class="th tk-flag-head">
            <span class="tht">🚩 Flagged for Apoorv</span>
            <span class="ths">${flagged.length} task(s) raised by other PSEs · red = unseen, light green = seen</span>
          </div>
          <div class="tw">
            <table class="tk-table tk-flag-table">
              <thead><tr><th style="width:24%">Task Name</th><th style="width:14%">Raised By</th><th style="width:14%">Task Start Date</th><th style="width:26%">Remarks</th><th style="width:14%">Seen</th><th style="width:8%"></th></tr></thead>
              <tbody>${flagged.map(flaggedRow).join('') || '<tr><td colspan="6" class="empty">No flagged tasks right now</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    bindFlaggedOnlyView();
    return;
  }

  const pses = trackerVisiblePses();
  const tasksForPse = allTasks.filter((t) => pses.includes(t.pse));

  // Prominent action to mark/unmark the viewed day as an official holiday.
  // Hidden on weekends (already non-working). A holiday still shows the sheets
  // so a PSE who worked can log tasks — it's only dropped from report math.
  const holidayBtn = weekend
    ? ''
    : `<button class="tk-holiday-btn ${holiday ? 'active' : ''}" id="holidayBtn">${holiday ? '★ Official Holiday — click to unmark' : '＋ Mark Official Holiday'}</button>`;

  const daynav = `
    <div class="tk-daynav">
      <button id="prevDayBtn">← Prev working day</button>
      <div class="tk-daydate">${dayLabel}${isToday ? ' (Today)' : weekend ? ' · Weekend' : ''}${holiday ? ' · Holiday' : ''}</div>
      <button id="nextDayBtn">Next working day →</button>
      ${!isToday ? '<button id="todayBtn">Jump to Today</button>' : ''}
      ${holidayBtn}
    </div>`;

  if (weekend) {
    document.getElementById('app').innerHTML = `
      <div class="page">
        <div class="ph"><div class="pht">Daily Task Tracker</div><div class="phs">PSEs don't work Saturdays or Sundays — no tracking on this day</div></div>
        ${daynav}
        <div class="empty" style="margin-top:20px">🌤️ Weekend — the Product Solutions team is off. Use "Prev/Next working day" to jump to a weekday.</div>
      </div>`;
    bindTrackerEvents();
    return;
  }

  // Status summary for the prominent top-right panel: counts across the day's
  // visible tasks (respecting filters, skipping on-leave sheets).
  const visibleToday = tasksForPse.filter(
    (t) => taskVisibleOnDay(t, day) && trackerRowMatchesFilters(t) && !leave[`${t.pse}|${day}`]
  );
  const sc = { Planned: 0, 'In Progress': 0, Done: 0 };
  visibleToday.forEach((t) => {
    const s = t.status === 'Open' ? 'Planned' : t.status; // legacy-data fallback
    sc[s] = (sc[s] || 0) + 1;
  });
  const delayedToday = visibleToday.filter((t) => taskDelayDays(t, day) > 0).length;
  const overdueTotal = tasksForPse.filter((t) => taskOverdue(t, day)).length;

  const summaryPanel = `
    <div class="tk-summary">
      <div class="tk-sum-cell tk-sum-open"><span class="tk-sum-n">${sc.Planned}</span><span class="tk-sum-l">Planned</span></div>
      <div class="tk-sum-cell tk-sum-prog"><span class="tk-sum-n">${sc['In Progress']}</span><span class="tk-sum-l">In Progress</span></div>
      <div class="tk-sum-cell tk-sum-done"><span class="tk-sum-n">${sc.Done}</span><span class="tk-sum-l">Done</span></div>
      <div class="tk-sum-cell tk-sum-delayed"><span class="tk-sum-n">${delayedToday}</span><span class="tk-sum-l">Delayed</span></div>
    </div>`;

  const pseSections = pses.map((pse) => {
    const onLeave = !!leave[`${pse}|${day}`];
    const isApoorv = pse === 'Apoorv';
    const rows = tasksForPse
      .filter((t) => t.pse === pse && taskVisibleOnDay(t, day) && trackerRowMatchesFilters(t))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // Flagged-for-Apoorv notifications bypass the PSE/status filters and the
    // sidebar's PSE selection entirely (a fixed personal inbox for Apoorv),
    // and are sourced from ALL tasks, not just this filtered/visible set.
    const flaggedPanel = isApoorv
      ? (() => {
          const flagged = allTasks
            .filter((t) => isFlaggedForApoorv(t) && flaggedVisibleOnDay(t, day))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          if (!flagged.length) return '';
          return `
      <div class="tc tk-flag-panel">
        <div class="th tk-flag-head">
          <span class="tht">🚩 Flagged for Apoorv</span>
          <span class="ths">${flagged.length} task(s) raised by other PSEs · shown daily until marked Seen, then pinned to its Task Start Date only · red = unseen, light green = seen</span>
        </div>
        <div class="tw">
          <table class="tk-table tk-flag-table">
            <thead><tr><th style="width:24%">Task Name</th><th style="width:14%">Raised By</th><th style="width:14%">Task Start Date</th><th style="width:26%">Remarks</th><th style="width:14%">Seen</th><th style="width:8%"></th></tr></thead>
            <tbody>${flagged.map(flaggedRow).join('')}</tbody>
          </table>
        </div>
      </div>`;
        })()
      : '';

    return `
    ${flaggedPanel}
    <div class="tc ${onLeave ? 'tk-onleave' : ''}">
      <div class="th">
        <span class="tht">${pse}</span>
        <span class="ths">${onLeave ? 'On Leave today' : rows.length + ' task(s)'}</span>
        <button class="tk-leave-btn ${onLeave ? 'active' : ''}" data-leave-pse="${pse}" title="Toggle on-leave for this day">${onLeave ? '✓ On Leave' : 'Mark On Leave'}</button>
      </div>
      ${
        onLeave
          ? '<div class="tw"><div class="empty">Marked on leave for this working day</div></div>'
          : `<div class="tw">
        <table class="tk-table">
          <thead><tr><th style="width:24%">Task Name</th><th title="The day this task was actually added — fixed forever, never changes">Planned On</th><th title="The task appears from this day onward; change it to move the task to another day's page">Task Start Date</th><th>Status</th><th>Due Date</th>${isApoorv ? '' : '<th>Flag Apoorv</th>'}<th>Help in SOW</th><th style="width:15%">Blocker</th><th style="width:15%">Remarks</th><th></th></tr></thead>
          <tbody>${rows.map((t) => trackerRow(t, day, { hideFlagCol: isApoorv })).join('') || `<tr><td colspan="${isApoorv ? 9 : 10}" class="empty">No tasks</td></tr>`}</tbody>
        </table>
      </div>
      <div style="padding:10px 16px"><button class="tk-add" data-add-pse="${pse}">+ Add Task</button></div>`
      }
    </div>`;
  }).join('');

  document.getElementById('app').innerHTML = `
    <div class="page tk-page">
      <div class="ph">
        <div class="ph-text">
          <div class="pht">Daily Task Tracker</div>
          <div class="phs">One sheet per PSE · in-progress tasks carry forward automatically until marked Done · rows in red are past their due date (${overdueTotal})</div>
        </div>
        ${summaryPanel}
      </div>
      ${daynav}
      ${holiday ? '<div class="tk-holiday-banner">★ Official Holiday — this day is excluded from working-day and report calculations. Any tasks logged below still count.</div>' : ''}
      ${pseSections || '<div class="empty">No PSE matches the current filter</div>'}
      ${renderTrackerReports(tasksForPse, leave, pses, day)}
    </div>`;

  bindTrackerEvents();
}

// Minimal bindings for the "Flagged For Apoorv"-only results view — just the
// editable fields (remarks, seen) and the armed delete, since none of the
// day-nav/holiday/leave/add-task controls exist on this page.
function bindFlaggedOnlyView() {
  document.querySelectorAll('.tk-input[data-field], .tk-select[data-field]').forEach((el) => {
    const row = el.closest('tr');
    const id = row.dataset.id;
    const field = el.dataset.field;
    const isCheckbox = el.type === 'checkbox';
    const immediate = el.tagName === 'SELECT' || el.type === 'date' || isCheckbox;
    el.addEventListener(immediate ? 'change' : 'input', () => {
      const value = isCheckbox ? el.checked : el.value;
      saveTrackerField(id, field, value, immediate);
    });
  });

  document.querySelectorAll('[data-del-flag-id]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = btn.dataset.delFlagId;
      if (STATE.flagDeleteId !== id) {
        clearTimeout(STATE.flagDeleteTimer);
        STATE.flagDeleteId = id;
        renderTrackerView();
        STATE.flagDeleteTimer = setTimeout(() => {
          if (STATE.flagDeleteId === id) {
            STATE.flagDeleteId = null;
            renderTrackerView();
          }
        }, 3500);
        return;
      }
      clearTimeout(STATE.flagDeleteTimer);
      STATE.flagDeleteId = null;
      await fetch(`/api/tracker/${id}`, { method: 'DELETE' });
      STATE.trackerTasks = STATE.trackerTasks.filter((t) => t.id !== id);
      renderTrackerView();
    });
  });
}

function bindTrackerEvents() {
  document.getElementById('prevDayBtn').addEventListener('click', () => {
    STATE.trackerDay = stepWorkingDay(STATE.trackerDay, -1);
    renderTrackerView();
  });
  document.getElementById('nextDayBtn').addEventListener('click', () => {
    STATE.trackerDay = stepWorkingDay(STATE.trackerDay, 1);
    renderTrackerView();
  });
  const todayBtn = document.getElementById('todayBtn');
  if (todayBtn) todayBtn.addEventListener('click', () => {
    STATE.trackerDay = lastWorkingDayOnOrBefore(istToday());
    renderTrackerView();
  });

  const holidayBtn = document.getElementById('holidayBtn');
  if (holidayBtn) holidayBtn.addEventListener('click', async () => {
    const date = STATE.trackerDay;
    const nextIsHoliday = !isHolidayDay(date);
    // optimistic update
    if (nextIsHoliday) STATE.trackerHolidays[date] = true;
    else delete STATE.trackerHolidays[date];
    renderTrackerView();
    try {
      await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: 'holidays', date, isHoliday: nextIsHoliday }),
      });
    } catch (err) {
      console.error('Holiday toggle failed', err);
    }
  });

  document.querySelectorAll('[data-leave-pse]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pse = btn.dataset.leavePse;
      const key = `${pse}|${STATE.trackerDay}`;
      const nextOnLeave = !STATE.trackerLeave[key];
      // optimistic update
      if (nextOnLeave) STATE.trackerLeave[key] = true;
      else delete STATE.trackerLeave[key];
      renderTrackerView();
      try {
        await fetch('/api/tracker', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resource: 'leave', pse, date: STATE.trackerDay, onLeave: nextOnLeave }),
        });
      } catch (err) {
        console.error('Leave toggle failed', err);
      }
    });
  });

  document.querySelectorAll('[data-add-pse]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pse = btn.dataset.addPse;
      const res = await fetch('/api/tracker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pse }) });
      const task = await res.json();
      STATE.trackerTasks.push(task);
      renderTrackerView();
    });
  });

  // Armed, 2-click confirmation for every PSE's own task table (mirrors the
  // Flagged-for-Apoorv panel) instead of a native confirm() popup — first
  // click arms the button ("Confirm ✕", auto-disarms after ~3.5s), the SAME
  // button must be clicked again to actually delete.
  document.querySelectorAll('.tk-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = btn.dataset.delId;
      if (STATE.taskDeleteId !== id) {
        clearTimeout(STATE.taskDeleteTimer);
        STATE.taskDeleteId = id;
        renderTrackerView();
        STATE.taskDeleteTimer = setTimeout(() => {
          if (STATE.taskDeleteId === id) {
            STATE.taskDeleteId = null;
            renderTrackerView();
          }
        }, 3500);
        return;
      }
      clearTimeout(STATE.taskDeleteTimer);
      STATE.taskDeleteId = null;
      await fetch(`/api/tracker/${id}`, { method: 'DELETE' });
      STATE.trackerTasks = STATE.trackerTasks.filter((t) => t.id !== id);
      renderTrackerView();
    });
  });

  // Flagged-for-Apoorv delete: armed, 2-click confirmation (first click arms
  // the button and shows "Confirm ✕" for a few seconds; the SAME button must
  // be clicked again to actually delete) instead of a native confirm() popup.
  document.querySelectorAll('[data-del-flag-id]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = btn.dataset.delFlagId;
      if (STATE.flagDeleteId !== id) {
        clearTimeout(STATE.flagDeleteTimer);
        STATE.flagDeleteId = id;
        renderTrackerView();
        STATE.flagDeleteTimer = setTimeout(() => {
          if (STATE.flagDeleteId === id) {
            STATE.flagDeleteId = null;
            renderTrackerView();
          }
        }, 3500);
        return;
      }
      clearTimeout(STATE.flagDeleteTimer);
      STATE.flagDeleteId = null;
      await fetch(`/api/tracker/${id}`, { method: 'DELETE' });
      STATE.trackerTasks = STATE.trackerTasks.filter((t) => t.id !== id);
      renderTrackerView();
    });
  });

  document.querySelectorAll('.tk-input[data-field], .tk-select[data-field]').forEach((el) => {
    const row = el.closest('tr');
    const id = row.dataset.id;
    const field = el.dataset.field;
    const isCheckbox = el.type === 'checkbox';
    const immediate = el.tagName === 'SELECT' || el.type === 'date' || isCheckbox;
    el.addEventListener(immediate ? 'change' : 'input', () => {
      let value = isCheckbox ? el.checked : el.value;
      if (field === 'flagApoorv' || field === 'helpInSow') value = value === 'true';
      saveTrackerField(id, field, value, immediate);
    });
  });

  bindTrackerDateFields();
}

// The DD/MM/YYYY text is a readonly display sitting over a hidden native
// date input (see trackerDateFieldHtml) — clicking it opens that input's own
// calendar picker rather than letting the browser's locale-dependent text
// rendering show through.
function bindTrackerDateFields() {
  document.querySelectorAll('.tk-date-text').forEach((txt) => {
    txt.addEventListener('click', () => {
      const native = txt.nextElementSibling;
      if (!native) return;
      if (native.showPicker) native.showPicker();
      else native.focus();
    });
  });
}

// Exclusive left-sidebar filters for the Daily Tracker tab: PSE, Status,
// Date bracket, Help in SOW, Flag Apoorv (per spec — the universal Jira
// filters don't apply here).
function renderTrackerSidebar() {
  if (!STATE.facc) loadSidebarPrefs();
  const f = STATE.trackerFilters;
  const activeCount = f.pse.size + f.status.size + (f.helpInSow ? 1 : 0) + (f.flagApoorv ? 1 : 0) + (f.dateFrom ? 1 : 0) + (f.dateTo ? 1 : 0) + (f.dealName.trim() ? 1 : 0);
  const sb = document.getElementById('sidebar');
  sb.style.display = '';
  sb.classList.toggle('collapsed', STATE.sidebarCollapsed);
  sb.innerHTML = `
    <div class="sb-header">
      <div class="sb-title">Filters${activeCount ? `<span class="facc-badge">${activeCount}</span>` : ''}</div>
      <button class="sb-toggle" id="sidebarToggleBtn" title="${STATE.sidebarCollapsed ? 'Expand filters' : 'Collapse filters'}">${STATE.sidebarCollapsed ? '»' : '«'}</button>
    </div>
    <div class="sb-content" id="sidebarContent" style="display:${STATE.sidebarCollapsed ? 'none' : ''}">
      <div class="sfgroup">
        <label class="tk-flagfilter-toggle ${f.flagApoorv === 'true' ? 'active' : ''}">
          <input type="checkbox" id="tkFlaggedOnlyToggle" ${f.flagApoorv === 'true' ? 'checked' : ''}/>
          <span>🚩 Flagged For Apoorv</span>
        </label>
      </div>
      ${faccGroup('pse', 'PSE', checkboxListHtml('pse', TRACKER_PSE_ROWS, f.pse), f.pse.size)}
      ${faccGroup('status', 'Status', checkboxListHtml('status', ['Planned', 'In Progress', 'Done'], f.status), f.status.size)}

      <div class="sfgroup-row">
        <div class="sfgroup-half">
          <label>Help in SOW</label>
          <select class="fs" id="tkHelpSelect">
            <option value="">All</option>
            <option value="true" ${f.helpInSow === 'true' ? 'selected' : ''}>Yes</option>
            <option value="false" ${f.helpInSow === 'false' ? 'selected' : ''}>No</option>
          </select>
        </div>
        <div class="sfgroup-half">
          <label>Flag Apoorv</label>
          <select class="fs" id="tkFlagSelect">
            <option value="">All</option>
            <option value="true" ${f.flagApoorv === 'true' ? 'selected' : ''}>Yes</option>
            <option value="false" ${f.flagApoorv === 'false' ? 'selected' : ''}>No</option>
          </select>
        </div>
      </div>

      <div class="sfgroup">
        <label>Date Bracket (From – To)</label>
        <div class="sf-daterow">
          <input type="date" class="fi" lang="en-GB" id="tkDateFrom" value="${f.dateFrom}"/>
          <input type="date" class="fi" lang="en-GB" id="tkDateTo" value="${f.dateTo}"/>
        </div>
        <div style="font-size:10px;color:var(--t3)">Adds a "Custom Range" report below</div>
      </div>

      <button class="clear-btn-full" id="clearTrackerFiltersBtn">Clear all filters</button>
    </div>`;

  document.getElementById('sidebarToggleBtn').addEventListener('click', () => {
    STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
    localStorage.setItem('psv_sidebar_collapsed', STATE.sidebarCollapsed ? '1' : '0');
    renderTrackerSidebar();
  });

  if (STATE.sidebarCollapsed) return;

  document.getElementById('tkFlaggedOnlyToggle').addEventListener('change', (e) => { STATE.trackerFilters.flagApoorv = e.target.checked ? 'true' : ''; renderTrackerView(); });
  document.getElementById('tkHelpSelect').addEventListener('change', (e) => { STATE.trackerFilters.helpInSow = e.target.value; renderTrackerView(); });
  document.getElementById('tkFlagSelect').addEventListener('change', (e) => { STATE.trackerFilters.flagApoorv = e.target.value; renderTrackerView(); });
  document.getElementById('tkDateFrom').addEventListener('change', (e) => { STATE.trackerFilters.dateFrom = e.target.value; renderTrackerView(); });
  document.getElementById('tkDateTo').addEventListener('change', (e) => { STATE.trackerFilters.dateTo = e.target.value; renderTrackerView(); });

  document.querySelectorAll('[data-facc-toggle]').forEach((head) => {
    head.addEventListener('click', () => {
      const id = head.dataset.faccToggle;
      STATE.facc[id] = !STATE.facc[id];
      localStorage.setItem('psv_facc_' + id, STATE.facc[id] ? '1' : '0');
      head.closest('.facc').classList.toggle('open', STATE.facc[id]);
    });
  });

  document.querySelectorAll('#sidebar [data-mgroup]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const group = cb.dataset.mgroup;
      const set = STATE.trackerFilters[group];
      if (cb.checked) set.add(cb.value);
      else set.delete(cb.value);
      renderTrackerView();
    });
  });

  document.getElementById('clearTrackerFiltersBtn').addEventListener('click', () => {
    STATE.trackerFilters = { pse: new Set(), status: new Set(), helpInSow: '', flagApoorv: '', dateFrom: '', dateTo: '', dealName: '' };
    renderTrackerView();
  });
}

async function saveTrackerField(id, field, value, rerenderAfterSave) {
  const task = STATE.trackerTasks.find((t) => t.id === id);
  if (task) task[field] = value; // optimistic local update, so the UI never feels laggy

  clearTimeout(trackerSaveTimers[id + field]);
  const doSave = async () => {
    try {
      const res = await fetch(`/api/tracker/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      const updated = await res.json();
      const idx = STATE.trackerTasks.findIndex((t) => t.id === id);
      if (idx !== -1) STATE.trackerTasks[idx] = updated;
      if (rerenderAfterSave) renderTrackerView();
    } catch (err) {
      console.error('Tracker save failed', err);
    }
  };

  if (rerenderAfterSave) await doSave();
  else trackerSaveTimers[id + field] = setTimeout(doSave, 500);
}

// ---------- Quick Links tab ----------
// Shared, persistent, user-addable reference list (own storage — see
// lib/quickLinks.js — since this is curated-by-humans data, not from Jira).
async function renderQuickLinks() {
  document.getElementById('app').innerHTML = '<div class="page"><div class="loading">Loading quick links…</div></div>';
  try {
    const [links, groups] = await Promise.all([
      fetch('/api/quicklinks', { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
      fetch('/api/quicklinks/groups', { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
    ]);
    STATE.quickLinks = links;
    STATE.quickLinksGroups = groups;
  } catch (err) {
    document.getElementById('app').innerHTML = `<div class="page"><div class="empty">Could not load Quick Links: ${err.message}</div></div>`;
    return;
  }
  renderQuickLinksView();
}

let dragLinkCtx = null; // ephemeral drag state, not persisted — { id, group }

// The Quick Links filter lives in the shared left sidebar (collapsible, same
// as the main dashboard's) rather than a page-level bar, scoped to this tab.
function renderQuickLinksSidebar(groupNames) {
  if (!STATE.facc) loadSidebarPrefs(); // reuses the same collapsed-state flag/localStorage key
  const sb = document.getElementById('sidebar');
  sb.style.display = '';
  sb.classList.toggle('collapsed', STATE.sidebarCollapsed);
  sb.innerHTML = `
    <div class="sb-header">
      <div class="sb-title">Filters</div>
      <button class="sb-toggle" id="sidebarToggleBtn" title="${STATE.sidebarCollapsed ? 'Expand filters' : 'Collapse filters'}">${STATE.sidebarCollapsed ? '»' : '«'}</button>
    </div>
    <div class="sb-content" id="sidebarContent" style="display:${STATE.sidebarCollapsed ? 'none' : ''}">
      <div class="sfgroup">
        <label>Filter by Group</label>
        <div class="ql-filter-list">
          <button class="ql-filter-item ${STATE.quickLinksFilter === 'all' ? 'active' : ''}" data-qlf="all">All</button>
          ${groupNames.map((g) => `<button class="ql-filter-item ${STATE.quickLinksFilter === g ? 'active' : ''}" data-qlf="${escapeAttr(g)}">${g}</button>`).join('')}
        </div>
      </div>
    </div>`;

  document.getElementById('sidebarToggleBtn').addEventListener('click', () => {
    STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
    localStorage.setItem('psv_sidebar_collapsed', STATE.sidebarCollapsed ? '1' : '0');
    renderQuickLinksSidebar(groupNames);
  });
  if (STATE.sidebarCollapsed) return;
  document.querySelectorAll('#sidebar [data-qlf]').forEach((btn) => {
    btn.addEventListener('click', () => {
      STATE.quickLinksFilter = btn.dataset.qlf;
      renderQuickLinksView();
    });
  });
}

function createGroupFormHtml() {
  return `
  <div class="link-add-form link-add-form-group">
    <input class="fi" id="newGroupName" type="text" placeholder="New group name…"/>
    <button class="tk-add" id="saveGroupBtn">Save</button>
  </div>`;
}

function bindCreateGroupHandlers() {
  const createBtn = document.getElementById('createGroupBtn');
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      STATE.quickLinksCreatingGroup = !STATE.quickLinksCreatingGroup;
      renderQuickLinksView();
    });
  }
  const saveBtn = document.getElementById('saveGroupBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const input = document.getElementById('newGroupName');
      const name = input.value.trim();
      if (!name) return;
      saveBtn.disabled = true;
      try {
        const res = await fetch('/api/quicklinks/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not create group');
        STATE.quickLinksGroups = data;
        STATE.quickLinksCreatingGroup = false;
        STATE.quickLinksFilter = name;
        renderQuickLinksView();
      } catch (err) {
        alert(err.message);
        saveBtn.disabled = false;
      }
    });
  }
}

function renderQuickLinksView() {
  const links = STATE.quickLinks || [];
  const storedGroups = STATE.quickLinksGroups || [];

  const groups = {};
  const groupNames = storedGroups.slice();
  groupNames.forEach((g) => (groups[g] = []));
  links
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .forEach((l) => {
      const g = l.group || 'Links';
      if (!groups[g]) {
        groups[g] = [];
        groupNames.push(g); // defensive: a link references a group missing from the stored list
      }
      groups[g].push(l);
    });

  if (!groupNames.length) {
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('app').innerHTML = `
      <div class="page">
        <div class="ph">
          <div class="ph-text">
            <div class="pht">Quick Links</div>
            <div class="phs">A quick-reference repository of important worksheets for the Product Solutions team</div>
          </div>
          <button class="create-group-btn" id="createGroupBtn">${STATE.quickLinksCreatingGroup ? '✕ Cancel' : '+ Create New Group'}</button>
        </div>
        ${STATE.quickLinksCreatingGroup ? createGroupFormHtml() : ''}
        ${STATE.quickLinksCreatingGroup ? '' : '<div class="empty">No groups yet — use "+ Create New Group" to make the first one, then add links into it.</div>'}
      </div>`;
    bindCreateGroupHandlers();
    return;
  }

  if (!STATE.quickLinksFilter || !['all', ...groupNames].includes(STATE.quickLinksFilter)) {
    STATE.quickLinksFilter = 'all';
  }
  const visibleGroups = STATE.quickLinksFilter === 'all' ? groupNames : [STATE.quickLinksFilter];

  renderQuickLinksSidebar(groupNames);

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph">
        <div class="ph-text">
          <div class="pht">Quick Links</div>
          <div class="phs">A quick-reference repository of important worksheets for the Product Solutions team · drag a card to reorder it within its group, or drag a link/tab from your browser onto a group to add it</div>
        </div>
        <button class="create-group-btn" id="createGroupBtn">${STATE.quickLinksCreatingGroup ? '✕ Cancel' : '+ Create New Group'}</button>
      </div>
      ${STATE.quickLinksCreatingGroup ? createGroupFormHtml() : ''}
      ${visibleGroups
        .map((group) => {
          const search = STATE.quickLinksSearch.trim().toLowerCase();
          const groupLinks = search
            ? groups[group].filter((l) => `${l.name} ${l.url}`.toLowerCase().includes(search))
            : groups[group];
          if (search && !groupLinks.length) return '';
          const highlighted = group !== 'Links'; // named groups (e.g. "Solutions Team Decks") stand out
          const adding = STATE.quickLinksAddingGroup === group;
          return `
        <div class="link-group ${highlighted ? 'highlight' : ''}" data-drop-group="${escapeAttr(group)}">
          <div class="link-group-head">
            ${
              STATE.quickLinksRenamingGroup === group
                ? `
            <input class="fi link-group-rename-input" id="renameGroupInput" type="text" value="${escapeAttr(group)}"/>
            <button class="link-group-mini-btn" data-save-rename="${escapeAttr(group)}" title="Save name">✓</button>
            <button class="link-group-mini-btn" data-cancel-rename title="Cancel">✕</button>
            `
                : `
            <span class="link-group-title">${group}</span>
            <span class="link-group-count">${groupLinks.length}</span>
            ${
              group === 'Links'
                ? ''
                : `<button class="link-group-mini-btn" data-rename-group="${escapeAttr(group)}" title="Rename group">✎</button>
            <button class="link-group-mini-btn link-group-del-btn ${STATE.confirmDeleteGroupId === group ? 'armed' : ''}" data-del-group="${escapeAttr(group)}" title="${STATE.confirmDeleteGroupId === group ? 'Click again to confirm — this also deletes its links' : 'Delete group'}">${STATE.confirmDeleteGroupId === group ? 'Confirm ✕' : '🗑'}</button>`
            }
            `
            }
            <button class="link-add-btn" data-add-group="${escapeAttr(group)}">${adding ? 'Cancel' : '+ Add Link'}</button>
          </div>
          ${
            adding
              ? `
          <div class="link-add-form">
            <input class="fi" id="newLinkName" type="text" placeholder="Link name…"/>
            <input class="fi" id="newLinkUrl" type="text" placeholder="https://…"/>
            <button class="tk-add" data-save-group="${escapeAttr(group)}">Save</button>
          </div>`
              : ''
          }
          <div class="link-grid">
            ${groupLinks
              .map((l) => {
                const armed = STATE.confirmDeleteId === l.id;
                return `
              <div class="link-card-wrap" draggable="true" data-link-id="${l.id}" data-group="${escapeAttr(group)}">
                <a class="link-card" href="${l.url}" target="_blank" rel="noopener" title="${escapeAttr(l.name)}">
                  <span class="link-card-name">${l.name}</span>
                  <span class="link-card-foot">Open <span class="link-card-arrow">↗</span></span>
                </a>
                <button class="link-del-btn ${armed ? 'armed' : ''}" data-del-link="${l.id}" title="${armed ? 'Click again to confirm' : 'Remove link'}">${armed ? 'Confirm ✕' : '✕'}</button>
              </div>`;
              })
              .join('')}
          </div>
        </div>`;
        })
        .join('') || `<div class="empty">No links match "${escapeAttr(STATE.quickLinksSearch.trim())}"</div>`}
    </div>`;

  bindCreateGroupHandlers();

  document.querySelectorAll('[data-add-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.addGroup;
      STATE.quickLinksAddingGroup = STATE.quickLinksAddingGroup === group ? null : group;
      renderQuickLinksView();
    });
  });

  document.querySelectorAll('[data-save-group]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const group = btn.dataset.saveGroup;
      const name = document.getElementById('newLinkName').value.trim();
      const url = document.getElementById('newLinkUrl').value.trim();
      if (!name || !url) return;
      const res = await fetch('/api/quicklinks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url, group }),
      });
      const link = await res.json();
      STATE.quickLinks.push(link);
      STATE.quickLinksAddingGroup = null;
      renderQuickLinksView();
    });
  });

  // One-level confirmation: first click arms the button (shows "Confirm ✕",
  // stays visible, auto-disarms after a few seconds); the SAME button must be
  // clicked again to actually delete.
  document.querySelectorAll('[data-del-link]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = btn.dataset.delLink;
      if (STATE.confirmDeleteId !== id) {
        clearTimeout(STATE.confirmDeleteTimer);
        STATE.confirmDeleteId = id;
        renderQuickLinksView();
        STATE.confirmDeleteTimer = setTimeout(() => {
          if (STATE.confirmDeleteId === id) {
            STATE.confirmDeleteId = null;
            renderQuickLinksView();
          }
        }, 3500);
        return;
      }
      clearTimeout(STATE.confirmDeleteTimer);
      STATE.confirmDeleteId = null;
      await fetch(`/api/quicklinks/${id}`, { method: 'DELETE' });
      STATE.quickLinks = STATE.quickLinks.filter((l) => l.id !== id);
      renderQuickLinksView();
    });
  });

  document.querySelectorAll('[data-rename-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      STATE.quickLinksRenamingGroup = btn.dataset.renameGroup;
      renderQuickLinksView();
    });
  });

  document.querySelectorAll('[data-cancel-rename]').forEach((btn) => {
    btn.addEventListener('click', () => {
      STATE.quickLinksRenamingGroup = null;
      renderQuickLinksView();
    });
  });

  document.querySelectorAll('[data-save-rename]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const oldName = btn.dataset.saveRename;
      const newName = document.getElementById('renameGroupInput').value.trim();
      if (!newName || newName === oldName) {
        STATE.quickLinksRenamingGroup = null;
        renderQuickLinksView();
        return;
      }
      try {
        const res = await fetch(`/api/quicklinks/groups/${encodeURIComponent(oldName)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not rename group');
        STATE.quickLinksGroups = data;
        STATE.quickLinks.forEach((l) => {
          if (l.group === oldName) l.group = newName;
        });
        if (STATE.quickLinksFilter === oldName) STATE.quickLinksFilter = newName;
        STATE.quickLinksRenamingGroup = null;
        renderQuickLinksView();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Same armed two-click confirmation as link delete, but deleting a group
  // also removes every link filed under it (a group is a container).
  document.querySelectorAll('[data-del-group]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const group = btn.dataset.delGroup;
      if (STATE.confirmDeleteGroupId !== group) {
        clearTimeout(STATE.confirmDeleteGroupTimer);
        STATE.confirmDeleteGroupId = group;
        renderQuickLinksView();
        STATE.confirmDeleteGroupTimer = setTimeout(() => {
          if (STATE.confirmDeleteGroupId === group) {
            STATE.confirmDeleteGroupId = null;
            renderQuickLinksView();
          }
        }, 3500);
        return;
      }
      clearTimeout(STATE.confirmDeleteGroupTimer);
      STATE.confirmDeleteGroupId = null;
      await fetch(`/api/quicklinks/groups/${encodeURIComponent(group)}`, { method: 'DELETE' });
      STATE.quickLinksGroups = (STATE.quickLinksGroups || []).filter((g) => g !== group);
      STATE.quickLinks = STATE.quickLinks.filter((l) => l.group !== group);
      if (STATE.quickLinksFilter === group) STATE.quickLinksFilter = 'all';
      renderQuickLinksView();
    });
  });

  bindLinkDragDrop();
  bindExternalLinkDrop();
}

// Lets someone drag a link straight from elsewhere in the browser — another
// tab, a bookmark, a link on a webpage — and drop it onto a group box to add
// it as a new Quick Link. Internal card-reorder drags are handled separately
// (bindLinkDragDrop) and stop propagation before they reach here.
function bindExternalLinkDrop() {
  function extractUrl(dt) {
    const uriList = dt.getData('text/uri-list');
    if (uriList) {
      const first = uriList.split(/\r?\n/).find((l) => l && !l.startsWith('#'));
      if (first) return first.trim();
    }
    const plain = dt.getData('text/plain');
    if (plain && /^https?:\/\//i.test(plain.trim())) return plain.trim();
    return null;
  }
  function extractName(dt, url) {
    const html = dt.getData('text/html');
    if (html) {
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const a = doc.querySelector('a');
        const text = (a ? a.textContent : doc.body.textContent || '').trim();
        if (text) return text.slice(0, 120);
      } catch (err) {
        /* fall through to URL-derived name */
      }
    }
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      return decodeURIComponent(last || u.hostname);
    } catch (err) {
      return url;
    }
  }

  document.querySelectorAll('.link-group').forEach((el) => {
    el.addEventListener('dragover', (e) => {
      if (dragLinkCtx) return; // internal card reorder, not an external link drop
      if (!e.dataTransfer.types.includes('text/uri-list') && !e.dataTransfer.types.includes('text/plain')) return;
      e.preventDefault();
      el.classList.add('group-drag-over');
    });
    el.addEventListener('dragleave', (e) => {
      if (e.target === el) el.classList.remove('group-drag-over');
    });
    el.addEventListener('drop', async (e) => {
      el.classList.remove('group-drag-over');
      if (dragLinkCtx) return;
      const url = extractUrl(e.dataTransfer);
      if (!url) return;
      e.preventDefault();
      const group = el.dataset.dropGroup;
      const name = extractName(e.dataTransfer, url);
      const res = await fetch('/api/quicklinks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url, group }),
      });
      const link = await res.json();
      STATE.quickLinks.push(link);
      renderQuickLinksView();
    });
  });
}

function bindLinkDragDrop() {
  document.querySelectorAll('.link-card-wrap').forEach((el) => {
    el.addEventListener('dragstart', () => {
      dragLinkCtx = { id: el.dataset.linkId, group: el.dataset.group };
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      document.querySelectorAll('.link-card-wrap.drag-over').forEach((n) => n.classList.remove('drag-over'));
      dragLinkCtx = null;
    });
    el.addEventListener('dragover', (e) => {
      if (!dragLinkCtx || dragLinkCtx.group !== el.dataset.group || dragLinkCtx.id === el.dataset.linkId) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      if (!dragLinkCtx || dragLinkCtx.group !== el.dataset.group || dragLinkCtx.id === el.dataset.linkId) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-over');

      const group = el.dataset.group;
      const groupLinks = STATE.quickLinks
        .filter((l) => (l.group || 'Links') === group)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const fromIdx = groupLinks.findIndex((l) => l.id === dragLinkCtx.id);
      const toIdx = groupLinks.findIndex((l) => l.id === el.dataset.linkId);
      if (fromIdx === -1 || toIdx === -1) return;

      const [moved] = groupLinks.splice(fromIdx, 1);
      groupLinks.splice(toIdx, 0, moved);
      const orderedIds = groupLinks.map((l) => l.id);
      orderedIds.forEach((id, i) => {
        const link = STATE.quickLinks.find((l) => l.id === id);
        if (link) link.order = i;
      });

      renderQuickLinksView(); // optimistic re-render before the network round-trip
      await fetch('/api/quicklinks/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group, ids: orderedIds }),
      });
    });
  });
}

// ---------- Jira Update Check tab (field-completeness sanity view) ----------
// Read-only: shows every tracked card's fields with blanks highlighted red.
// PSEs fill blanks natively in Jira (via the card link); this reflects live.
const UC_SECTIONS = [
  { key: 'discovery', label: 'Discovery', cols: [
    { key: 'modules', label: 'List of Modules', type: 'arr' },
    { key: 'shipmentType', label: 'Shipment Type', type: 'arr' },
    { key: 'regionOfUse', label: 'Region of Use', type: 'arr' },
    { key: 'shipmentVolumePerMonth', label: 'Shipment Vol/Mo', type: 'num' },
  ] },
  { key: 'solutioning', label: 'Solutioning', cols: [
    { key: 'solutioningStartDate', label: 'Sol. Start Date', type: 'date' },
    { key: 'processFlowDoc', label: 'Process Flow Doc', type: 'rich' },
    { key: 'scopeOfWork', label: 'Scope of Work', type: 'rich' },
    { key: 'solPriority', label: 'Sol. Priority', type: 'text' },
    { key: 'sowSendDate', label: 'SoW Send Date', type: 'date' },
    { key: 'sowSignOffDate', label: 'SoW Sign-Off Date', type: 'date' },
  ] },
  { key: 'details', label: 'Details', cols: [
    { key: 'companySize', label: 'Company Size', type: 'text' },
    { key: 'projectComplexity', label: 'Project Complexity', type: 'text' },
    { key: 'clientRank', label: 'Client Rank', type: 'text' },
    { key: 'requestCategory', label: 'Request Category', type: 'text' },
    { key: 'mrr', label: 'MRR (USD)', type: 'num' },
    { key: 'kam', label: 'KAM', type: 'text' },
    { key: 'salesRep', label: 'Sales Rep', type: 'text' },
    { key: 'expectedSalesClosure', label: 'Exp. Sales Closure', type: 'date' },
    { key: 'expectedClosureWeeks', label: 'Exp. Closure (wks)', type: 'text' },
  ] },
];
const UC_ALL_COLS = UC_SECTIONS.flatMap((s) => s.cols);

function ucIsBlank(v, type) {
  if (v == null) return true;
  if (type === 'arr') return !Array.isArray(v) || v.length === 0;
  if (type === 'rich') return !v || (!v.text && !(v.links && v.links.length));
  return String(v).trim() === '';
}
function ucBlanksCount(card) {
  return UC_ALL_COLS.reduce((n, c) => n + (ucIsBlank(card[c.key], c.type) ? 1 : 0), 0);
}
function ucSectionBlanks(card, section) {
  return section.cols.reduce((n, c) => n + (ucIsBlank(card[c.key], c.type) ? 1 : 0), 0);
}
function ucCellContent(card, col) {
  const v = card[col.key];
  if (col.type === 'arr') return v.join(', ');
  if (col.type === 'rich') {
    const link = v.links && v.links[0];
    if (link) return `<a href="${link}" target="_blank" rel="noopener" class="uc-doc-link" title="${escapeAttr(v.text || link)}">Open ↗</a>`;
    return `<span title="${escapeAttr(v.text || '')}">${escapeHtml((v.text || '').slice(0, 40))}</span>`;
  }
  if (col.type === 'num') return col.key === 'mrr' ? fmtUsd(v) : v;
  if (col.type === 'date') return fmtDdMmYyyy(v);
  return escapeHtml(String(v));
}

function ucVisibleSections() {
  const sel = STATE.updateFilters.sections;
  return sel.size ? UC_SECTIONS.filter((s) => sel.has(s.key)) : UC_SECTIONS;
}

function applyUpdateFilters(cards) {
  const f = STATE.updateFilters;
  const search = f.search.trim().toLowerCase();
  return cards.filter((c) => {
    if (f.pse.size && !f.pse.has(c.assignee)) return false;
    if (f.status.size && !f.status.has(c.status)) return false;
    if (f.kam.size && !f.kam.has(c.kam)) return false;
    if (f.salesRep.size && !f.salesRep.has(c.salesRep)) return false;
    if (f.requestCategory.size && !f.requestCategory.has(c.requestCategory)) return false;
    const blanks = ucBlanksCount(c);
    if (f.completeness === 'incomplete' && blanks === 0) return false;
    if (f.completeness === 'complete' && blanks > 0) return false;
    if (f.missingField) {
      const col = UC_ALL_COLS.find((x) => x.key === f.missingField);
      if (col && !ucIsBlank(c[col.key], col.type)) return false;
    }
    if (search) {
      const hay = `${c.key} ${c.summary || ''} ${c.assignee || ''} ${c.kam || ''} ${c.salesRep || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

async function renderUpdateCheck() {
  document.getElementById('app').innerHTML = '<div class="page"><div class="loading">Loading Jira cards…</div></div>';
  try {
    const res = await fetch('/api/update-check', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    STATE.updateCards = data.cards || [];
  } catch (err) {
    document.getElementById('app').innerHTML = `<div class="page"><div class="empty">Could not load Jira cards: ${err.message}</div></div>`;
    return;
  }
  renderUpdateCheckView();
}

function renderUpdateCheckView() {
  renderUpdateCheckSidebar();
  const cards = applyUpdateFilters(STATE.updateCards);
  const sections = ucVisibleSections();
  const isSecCollapsed = (k) => STATE.ucSectionCollapsed.has(k);

  // Group by PSE.
  const byPse = {};
  cards.forEach((c) => { (byPse[c.assignee] = byPse[c.assignee] || []).push(c); });
  const pseNames = Object.keys(byPse).sort((a, b) => byPse[b].length - byPse[a].length);

  const totalBlanks = cards.reduce((n, c) => n + ucBlanksCount(c), 0);
  const incomplete = cards.filter((c) => ucBlanksCount(c) > 0).length;

  // ---- live stat boxes ----
  const sectionBlankTotals = UC_SECTIONS.map((s) => [s, cards.reduce((n, c) => n + ucSectionBlanks(c, s), 0)]);
  const pseBlankTotals = pseNames.map((p) => [p, byPse[p].reduce((n, c) => n + ucBlanksCount(c), 0), byPse[p].length]);
  const byStatus = {};
  cards.forEach((c) => { (byStatus[c.status] = byStatus[c.status] || []).push(c); });
  const statusBlankTotals = Object.keys(byStatus).sort().map((s) => [s, byStatus[s].reduce((n, c) => n + ucBlanksCount(c), 0), byStatus[s].length]);

  const headlineBoxes = `
    <div class="uc-stat-box uc-sb-total"><span class="uc-sb-n">${totalBlanks}</span><span class="uc-sb-l">Total Blank Fields</span></div>
    <div class="uc-stat-box"><span class="uc-sb-n">${cards.length}</span><span class="uc-sb-l">Cards</span></div>
    <div class="uc-stat-box uc-sb-red"><span class="uc-sb-n">${incomplete}</span><span class="uc-sb-l">Incomplete</span></div>
    <div class="uc-stat-box uc-sb-green"><span class="uc-sb-n">${cards.length - incomplete}</span><span class="uc-sb-l">Complete</span></div>`;
  const sectionBoxes = sectionBlankTotals.map(([s, n]) => `
    <div class="uc-stat-box uc-sb-sec uc-sb-${s.key}"><span class="uc-sb-n">${n}</span><span class="uc-sb-l">${s.label}</span></div>`).join('');
  const pseBoxes = pseBlankTotals.map(([p, n, cnt]) => `
    <div class="uc-stat-box uc-sb-click ${STATE.updateFilters.pse.has(p) ? 'sel' : ''} ${n ? 'uc-sb-red' : 'uc-sb-green'}" data-uc-pbox="${escapeAttr(p)}" title="Filter to ${p}">
      <span class="uc-sb-n">${n}</span><span class="uc-sb-l">${p} · ${cnt} card(s)</span></div>`).join('');
  const statusBoxes = statusBlankTotals.map(([s, n, cnt]) => `
    <div class="uc-stat-box uc-sb-click ${STATE.updateFilters.status.has(s) ? 'sel' : ''} ${n ? 'uc-sb-amber' : 'uc-sb-green'}" data-uc-sbox="${escapeAttr(s)}" title="Filter to ${s}">
      <span class="uc-sb-n">${n}</span><span class="uc-sb-l">${s} · ${cnt}</span></div>`).join('');

  const statsCollapsed = STATE.ucStatsCollapsed;
  const statsHtml = `
    <div class="uc-stats-wrap">
      <div class="uc-stats-head ${statsCollapsed ? 'collapsed' : ''}" id="ucStatsToggle" title="${statsCollapsed ? 'Expand' : 'Collapse'} stats">
        <span class="uc-chev">▸</span>
        <span class="uc-stats-title">Live Stats Overview</span>
        <span class="uc-stats-sub"><b class="uc-meta-red">${totalBlanks}</b> blank fields · <b>${cards.length}</b> cards · <b>${incomplete}</b> incomplete</span>
      </div>
      ${statsCollapsed ? '' : `<div class="uc-stats">
        <div class="uc-stat-row">${headlineBoxes}</div>
        <div class="uc-stat-cap">Blanks by Section</div>
        <div class="uc-stat-row">${sectionBoxes}</div>
        <div class="uc-stat-cap">Blanks by PSE <span class="uc-cap-hint">(click to filter)</span></div>
        <div class="uc-stat-row">${pseBoxes || '<span class="uc-blank-txt">—</span>'}</div>
        <div class="uc-stat-cap">Blanks by Status <span class="uc-cap-hint">(click to filter)</span></div>
        <div class="uc-stat-row">${statusBoxes || '<span class="uc-blank-txt">—</span>'}</div>
      </div>`}
    </div>`;

  // ---- table header with collapsible, clearly-separated section groups ----
  const groupHead = `<tr>
      <th class="uc-sticky" rowspan="2">Card</th>
      <th rowspan="2">Client</th>
      <th rowspan="2">Status</th>
      <th rowspan="2">Blanks</th>
      ${sections.map((s) => isSecCollapsed(s.key)
        ? `<th class="uc-group uc-group-${s.key} uc-sec-start uc-group-collapsed" data-uc-seccollapse="${s.key}" title="Expand ${s.label}" rowspan="2">▸ ${s.label}</th>`
        : `<th class="uc-group uc-group-${s.key} uc-sec-start" data-uc-seccollapse="${s.key}" colspan="${s.cols.length}" title="Collapse ${s.label}">${s.label} ▾</th>`).join('')}
    </tr>
    <tr>${sections.map((s) => isSecCollapsed(s.key) ? '' : s.cols.map((c, ci) => `<th class="uc-fh uc-fh-${s.key} ${ci === 0 ? 'uc-sec-start' : ''}">${c.label}</th>`).join('')).join('')}</tr>`;

  const panels = pseNames.map((pse) => {
    const list = byPse[pse].slice().sort((a, b) => ucBlanksCount(b) - ucBlanksCount(a));
    const collapsed = STATE.updateCollapsed.has(pse);
    const pseBlanks = list.reduce((n, c) => n + ucBlanksCount(c), 0);
    const rows = list.map((c) => {
      const blanks = ucBlanksCount(c);
      return `<tr data-key="${c.key}">
        <td class="uc-sticky uc-keycell"><a class="jira-key-link" href="${c.url}" target="_blank" rel="noopener" title="Open ${c.key} in Jira">${c.key} ↗</a></td>
        <td class="uc-client">${c.summary || '<span class="uc-blank-txt">—</span>'}</td>
        <td>${fbadge(c.status)}</td>
        <td><span class="uc-blanks ${blanks ? 'has' : 'none'}">${blanks || '✓'}</span></td>
        ${sections.map((s) => {
          if (isSecCollapsed(s.key)) {
            const sb = ucSectionBlanks(c, s);
            return `<td class="uc-cell uc-sec-start uc-seccol ${sb ? 'uc-blank' : ''}" title="${s.label}: ${sb} blank field(s)">${sb || '✓'}</td>`;
          }
          return s.cols.map((col, ci) => {
            const blank = ucIsBlank(c[col.key], col.type);
            const startCls = ci === 0 ? 'uc-sec-start' : '';
            return blank
              ? `<td class="uc-cell uc-blank ${startCls}" title="${col.label} is empty — fill it in Jira">—</td>`
              : `<td class="uc-cell ${startCls}">${ucCellContent(c, col)}</td>`;
          }).join('');
        }).join('')}
      </tr>`;
    }).join('');
    return `
      <div class="uc-panel">
        <div class="uc-panel-head ${collapsed ? 'collapsed' : ''}" data-uc-toggle="${escapeAttr(pse)}">
          <span class="uc-chev">▸</span>
          <span class="uc-panel-name">${pse}</span>
          <span class="uc-pb">${list.length} card(s)</span>
          <span class="uc-pb ${pseBlanks ? 'uc-pb-red' : 'uc-pb-green'}">${pseBlanks} blank field(s)</span>
        </div>
        ${collapsed ? '' : `<div class="uc-panel-body"><div class="tw uc-tw"><table class="uc-table"><thead>${groupHead}</thead><tbody>${rows}</tbody></table></div></div>`}
      </div>`;
  }).join('') || '<div class="empty">No cards match the current filters</div>';

  document.getElementById('app').innerHTML = `
    <div class="page tk-page">
      <div class="ph">
        <div class="ph-text">
          <div class="pht">Jira Update Check</div>
          <div class="phs">Field-completeness sanity check · live from Jira · red cells are empty — click a card's key to open it in Jira and fill it · collapse a section (▾) to focus on one at a time</div>
        </div>
      </div>
      ${statsHtml}
      ${panels}
    </div>`;

  const statsToggle = document.getElementById('ucStatsToggle');
  if (statsToggle) statsToggle.addEventListener('click', () => {
    STATE.ucStatsCollapsed = !STATE.ucStatsCollapsed;
    renderUpdateCheckView();
  });

  document.querySelectorAll('[data-uc-toggle]').forEach((head) => {
    head.addEventListener('click', () => {
      const pse = head.dataset.ucToggle;
      if (STATE.updateCollapsed.has(pse)) STATE.updateCollapsed.delete(pse);
      else STATE.updateCollapsed.add(pse);
      renderUpdateCheckView();
    });
  });

  document.querySelectorAll('[data-uc-seccollapse]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.ucSeccollapse;
      if (STATE.ucSectionCollapsed.has(k)) STATE.ucSectionCollapsed.delete(k);
      else STATE.ucSectionCollapsed.add(k);
      renderUpdateCheckView();
    });
  });

  document.querySelectorAll('[data-uc-pbox]').forEach((box) => {
    box.addEventListener('click', () => {
      const p = box.dataset.ucPbox;
      if (STATE.updateFilters.pse.has(p)) STATE.updateFilters.pse.delete(p);
      else STATE.updateFilters.pse.add(p);
      renderUpdateCheckView();
    });
  });
  document.querySelectorAll('[data-uc-sbox]').forEach((box) => {
    box.addEventListener('click', () => {
      const s = box.dataset.ucSbox;
      if (STATE.updateFilters.status.has(s)) STATE.updateFilters.status.delete(s);
      else STATE.updateFilters.status.add(s);
      renderUpdateCheckView();
    });
  });

  document.querySelectorAll('.uc-table tbody tr[data-key]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.jira-key-link') || e.target.closest('.uc-doc-link')) return;
      openUpdateDetail(tr.dataset.key);
    });
  });
}

// Card detail summary shown in the shared modal (point 6), sections + red blanks.
function openUpdateDetail(key) {
  const c = STATE.updateCards.find((x) => x.key === key);
  if (!c) return;
  const blanks = ucBlanksCount(c);
  const sectionHtml = UC_SECTIONS.map((s) => `
    <div class="uc-detail-section">
      <div class="uc-detail-sec-title uc-group-${s.key}">${s.label}</div>
      <div class="uc-detail-grid">
        ${s.cols.map((col) => {
          const blank = ucIsBlank(c[col.key], col.type);
          return `<div class="uc-detail-field ${blank ? 'uc-blank' : ''}">
            <div class="uc-detail-label">${col.label}</div>
            <div class="uc-detail-value">${blank ? '<span class="uc-blank-txt">— empty —</span>' : ucCellContent(c, col)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');
  document.getElementById('modalContent').innerHTML = `
    <div class="modal-head">
      <div>
        <div class="modal-key">${c.key} · ${fbadge(c.status)}</div>
        <div class="modal-title">${c.summary || ''}</div>
      </div>
      <button class="modal-close" id="modalCloseBtn">✕</button>
    </div>
    <div class="modal-body">
      <div class="uc-detail-top">
        <div><span class="uc-detail-label">PSE</span> <b>${c.assignee || '—'}</b></div>
        <div class="${blanks ? 'uc-meta-red' : 'uc-meta-green'}"><b>${blanks}</b> blank field(s)</div>
        <a class="jira-link" href="${c.url}" target="_blank" rel="noopener">Open & edit in Jira →</a>
      </div>
      ${sectionHtml}
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
}

function renderUpdateCheckSidebar() {
  if (!STATE.facc) loadSidebarPrefs();
  const f = STATE.updateFilters;
  const cards = STATE.updateCards;
  const opt = (key) => distinct(cards.map((c) => c[key]));
  const activeCount = f.pse.size + f.status.size + f.kam.size + f.salesRep.size + f.requestCategory.size +
    (f.completeness !== 'all' ? 1 : 0) + f.sections.size + (f.missingField ? 1 : 0) + (f.search.trim() ? 1 : 0);
  const sb = document.getElementById('sidebar');
  sb.style.display = '';
  sb.classList.toggle('collapsed', STATE.sidebarCollapsed);
  sb.innerHTML = `
    <div class="sb-header">
      <div class="sb-title">Filters${activeCount ? `<span class="facc-badge">${activeCount}</span>` : ''}</div>
      <button class="sb-toggle" id="sidebarToggleBtn" title="${STATE.sidebarCollapsed ? 'Expand filters' : 'Collapse filters'}">${STATE.sidebarCollapsed ? '»' : '«'}</button>
    </div>
    <div class="sb-content" id="sidebarContent" style="display:${STATE.sidebarCollapsed ? 'none' : ''}">
      <div class="sfgroup">
        <label>Completeness</label>
        <select class="fs" id="ucCompleteness">
          <option value="all" ${f.completeness === 'all' ? 'selected' : ''}>All cards</option>
          <option value="incomplete" ${f.completeness === 'incomplete' ? 'selected' : ''}>Only incomplete (has blanks)</option>
          <option value="complete" ${f.completeness === 'complete' ? 'selected' : ''}>Only complete</option>
        </select>
      </div>
      <div class="sfgroup">
        <label>Missing a specific field</label>
        <select class="fs" id="ucMissingField">
          <option value="">Any / none</option>
          ${UC_ALL_COLS.map((col) => `<option value="${col.key}" ${f.missingField === col.key ? 'selected' : ''}>${col.label}</option>`).join('')}
        </select>
      </div>
      <div class="sfgroup">
        <label>Show sections</label>
        <div class="sf-opts">
          ${UC_SECTIONS.map((s) => `<label class="sf-opt"><input type="checkbox" data-uc-section="${s.key}" ${f.sections.has(s.key) ? 'checked' : ''}/><span>${s.label}</span></label>`).join('')}
        </div>
        <div style="font-size:10px;color:var(--t3)">None checked = show all</div>
      </div>
      ${faccGroup('pse', 'PSE', checkboxListHtml('pse', distinct(cards.map((c) => c.assignee)), f.pse), f.pse.size)}
      ${faccGroup('status', 'Status', checkboxListHtml('status', distinct(cards.map((c) => c.status)), f.status), f.status.size)}
      ${faccGroup('kam', 'KAM', checkboxListHtml('kam', opt('kam'), f.kam), f.kam.size)}
      ${faccGroup('salesRep', 'Sales Representative', checkboxListHtml('salesRep', opt('salesRep'), f.salesRep), f.salesRep.size)}
      ${faccGroup('requestCategory', 'Request Category', checkboxListHtml('requestCategory', opt('requestCategory'), f.requestCategory), f.requestCategory.size)}
      <button class="clear-btn-full" id="clearUcFiltersBtn">Clear all filters</button>
    </div>`;

  document.getElementById('sidebarToggleBtn').addEventListener('click', () => {
    STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
    localStorage.setItem('psv_sidebar_collapsed', STATE.sidebarCollapsed ? '1' : '0');
    renderUpdateCheckSidebar();
  });
  if (STATE.sidebarCollapsed) return;

  document.getElementById('ucCompleteness').addEventListener('change', (e) => { STATE.updateFilters.completeness = e.target.value; renderUpdateCheckView(); });
  document.getElementById('ucMissingField').addEventListener('change', (e) => { STATE.updateFilters.missingField = e.target.value; renderUpdateCheckView(); });
  document.querySelectorAll('[data-uc-section]').forEach((cb) => cb.addEventListener('change', () => {
    const k = cb.dataset.ucSection;
    if (cb.checked) STATE.updateFilters.sections.add(k); else STATE.updateFilters.sections.delete(k);
    renderUpdateCheckView();
  }));

  document.querySelectorAll('[data-facc-toggle]').forEach((head) => {
    head.addEventListener('click', () => {
      const id = head.dataset.faccToggle;
      STATE.facc[id] = !STATE.facc[id];
      localStorage.setItem('psv_facc_' + id, STATE.facc[id] ? '1' : '0');
      head.closest('.facc').classList.toggle('open', STATE.facc[id]);
    });
  });
  document.querySelectorAll('#sidebar [data-mgroup]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const set = STATE.updateFilters[cb.dataset.mgroup];
      if (cb.checked) set.add(cb.value); else set.delete(cb.value);
      renderUpdateCheckView();
    });
  });
  document.getElementById('clearUcFiltersBtn').addEventListener('click', () => {
    STATE.updateFilters = { pse: new Set(), status: new Set(), kam: new Set(), salesRep: new Set(), requestCategory: new Set(), completeness: 'all', sections: new Set(), missingField: '', search: '' };
    renderUpdateCheckView();
  });
}

// ---------- card modal ----------
function openCardModal(key) {
  const issue = STATE.data.issues.find((i) => i.key === key);
  if (!issue) return;
  const timeline = (issue.history || [])
    .slice()
    .reverse()
    .map(
      (h) => `
      <div class="tl-item">
        <div class="tl-dot"></div>
        <div class="tl-body">
          <div class="tl-desc">${describeActivity(h)}</div>
          <div class="tl-meta">${h.author || 'Unknown'} · ${fmtDdMmYyyyTime(h.created)} IST</div>
        </div>
      </div>`
    )
    .join('');

  const field = (label, value) => `<div><div class="mf-l">${label}</div><div class="mf-v">${value ?? '—'}</div></div>`;

  document.getElementById('modalContent').innerHTML = `
    <div class="modal-head">
      <div>
        <div class="modal-key">${issue.key}${issue.isPreQuarterHoldover ? ' <span class="flag-badge">🔴 Red Flag</span>' : ''}</div>
        <div class="modal-title">${issue.summary || ''}</div>
      </div>
      <button class="modal-close" id="modalCloseBtn">✕</button>
    </div>
    <div class="modal-body">
      <div class="mfields">
        ${field('Status', fbadge(issue.status))}
        ${field('Priority', issue.priority)}
        ${field('PSE (Assignee)', issue.assignee)}
        ${field('KAM', issue.kam)}
        ${field('Sales Representative', issue.salesRep)}
        ${field('Request Category', issue.requestCategory)}
        ${field('Modules', modulePills(issue.modules))}
        ${field('MRR (USD)', fmtUsd(issue.mrr))}
        ${field('ARR (USD)', fmtUsd(issue.arr))}
        ${field('Deal Size', dealSizeBadge(issue.dealSize))}
        ${field('Shipment Volume / Month', issue.shipmentVolume)}
        ${field('Expected Closure (weeks)', issue.expectedClosureWeeks)}
        ${field('Expected Sales Closure', fmtDdMmYyyy(issue.expectedSalesClosure))}
        ${field('Solutioning Start Date', fmtDdMmYyyy(issue.solutioningStartDate))}
        ${field('SoW Send Date', fmtDdMmYyyy(issue.sowSendDate))}
        ${field('SoW Confirmation Date', fmtDdMmYyyy(issue.sowConfirmationDate))}
        ${field('TAT', tatLabel(issue) + (issue.tatHoldDays ? ` <span style="color:var(--t3);font-size:11px">(excl. ${issue.tatHoldDays}d client hold)</span>` : ''))}
        ${field('Created', fmtDdMmYyyyTime(issue.created))}
        ${field('Last Updated', fmtDdMmYyyyTime(issue.updated))}
      </div>
      <a class="jira-link" href="${issue.url}" target="_blank" rel="noopener">Open in Jira →</a>
      <div class="sh" style="margin-top:20px"><div class="sht">Activity on this card</div><div class="shl"></div></div>
      ${timeline || '<div class="empty">No activity recorded</div>'}
    </div>`;

  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') closeModal();
});

// ---------- main render dispatch ----------
function render() {
  document.querySelectorAll('.nt').forEach((t) => t.classList.remove('active'));
  const navName = ['status', 'segment', 'list'].includes(STATE.route.name) ? 'overview' : STATE.route.name;
  const activeNt = document.querySelector(`.nt[data-route="${navName}"]`);
  activeNt?.classList.add('active');
  // Keep the fixed header's current-tab label in sync.
  const curTabEl = document.getElementById('curTab');
  if (curTabEl && activeNt) curTabEl.textContent = activeNt.textContent;

  // The universal Jira filters (PSE, Status, KAM, etc.) don't apply to Quick
  // Links or Activity Log — those routes swap the same sidebar element for
  // their own filter set instead (see renderQuickLinksSidebar /
  // renderActivitySidebar). Restore the normal Jira sidebar for every other tab.
  if (!['links', 'activity', 'tracker', 'tat', 'update', 'team', 'overview'].includes(STATE.route.name)) renderSidebar();

  if (STATE.route.name === 'status') renderStatusDrilldown(STATE.route.param);
  else if (STATE.route.name === 'segment') renderSegment(STATE.route.param);
  else if (STATE.route.name === 'list') renderAdhocList();
  else if (STATE.route.name === 'activity') renderActivity();
  else if (STATE.route.name === 'mrr') renderMrr();
  else if (STATE.route.name === 'closing') renderClosingSoon();
  else if (STATE.route.name === 'tat') renderTat();
  else if (STATE.route.name === 'team') renderTeam();
  else if (STATE.route.name === 'pipeline') renderPipeline();
  else if (STATE.route.name === 'c3m') renderC3m();
  else if (STATE.route.name === 'tracker') renderTracker();
  else if (STATE.route.name === 'links') renderQuickLinks();
  else if (STATE.route.name === 'update') renderUpdateCheck();
  else renderOverview();
}

document.querySelectorAll('.nt').forEach((t) => {
  t.addEventListener('click', () => navigate(t.dataset.route === 'overview' ? '/' : `/${t.dataset.route}`));
});

// Prev/Next quick tab switching (wraps around), following the visible nav order.
function switchTab(dir) {
  const routes = [...document.querySelectorAll('.nt')].map((n) => n.dataset.route);
  const navName = ['status', 'segment', 'list'].includes(STATE.route.name) ? 'overview' : STATE.route.name;
  let idx = routes.indexOf(navName);
  if (idx === -1) idx = 0;
  idx = (idx + dir + routes.length) % routes.length;
  const route = routes[idx];
  navigate(route === 'overview' ? '/' : `/${route}`);
}
document.getElementById('prevTabBtn').addEventListener('click', () => switchTab(-1));
document.getElementById('nextTabBtn').addEventListener('click', () => switchTab(1));

// Keyboard tab switching: "<" previous, ">" next (one tab per press). The
// unshifted "," / "." on the same physical keys work too, so it doesn't matter
// whether Shift is held. Ignored while typing — the dashboard is full of text
// fields (task names, remarks, search) and typing "<" there must stay literal.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
  const el = e.target;
  const tag = el && el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
  if (document.getElementById('modalOverlay').classList.contains('open')) return;
  if (e.key === '<' || e.key === ',') { e.preventDefault(); switchTab(-1); }
  else if (e.key === '>' || e.key === '.') { e.preventDefault(); switchTab(1); }
});

// Search — present on every tab (outside #app/#sidebar so it survives every
// re-render), but scoped to whichever tab is currently open: it writes into
// that tab's own filter bucket and re-renders in place, rather than jumping
// to an unrelated cross-tab result list.
const SIDEBAR_SEARCH_ROUTES = ['pipeline', 'mrr', 'closing', 'c3m'];
function runTabSearch(q) {
  const route = STATE.route.name;
  if (SIDEBAR_SEARCH_ROUTES.includes(route)) {
    STATE.filters.search = q;
    render();
    return applyFilters(STATE.data.issues).length;
  }
  if (route === 'overview' || ['status', 'segment', 'list'].includes(route)) {
    STATE.ovFilters.search = q;
    renderOverviewView();
    return applyOvFilters(STATE.overviewCards || []).length;
  }
  if (route === 'team') {
    STATE.winFilters.search = q;
    renderTeamView();
    return applyWinFilters(STATE.winCards || []).length;
  }
  if (route === 'tat') {
    STATE.tatFilters.search = q;
    renderTat();
    return applyTatFilters(STATE.data.issues).length;
  }
  if (route === 'update') {
    STATE.updateFilters.search = q;
    renderUpdateCheckView();
    return applyUpdateFilters(STATE.updateCards || []).length;
  }
  if (route === 'tracker') {
    STATE.trackerFilters.dealName = q;
    renderTrackerView();
    return (STATE.trackerTasks || []).filter(trackerRowMatchesFilters).length;
  }
  if (route === 'links') {
    STATE.quickLinksSearch = q;
    renderQuickLinksView();
    return null; // rendered inline, no separate count needed
  }
  if (route === 'activity') {
    STATE.activityFilters.dealName = q;
    renderActivity();
    return null; // rendered inline, no separate count needed
  }
  return null;
}

document.getElementById('globalSearchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('globalSearchInput');
  const q = input.value.trim();
  const hint = document.getElementById('globalSearchHint');
  const count = runTabSearch(q);
  if (!q) {
    hint.classList.remove('show');
  } else if (count === 0) {
    hint.textContent = `No matches for "${q}" on this tab`;
    hint.classList.add('show');
  } else {
    hint.classList.remove('show');
  }
});

document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  btn.textContent = 'Refreshing…';
  btn.disabled = true;
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await loadData();
    markSlowPollFresh(STATE.route.name); // manual refresh restarts the clock
    render();
  } finally {
    btn.textContent = 'Refresh now';
    btn.disabled = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth', { method: 'DELETE' });
  location.href = '/login.html';
});

// ---------- boot ----------
(async function main() {
  STATE.route = parseRoute();
  try {
    await loadData();
    render();
  } catch (err) {
    document.getElementById('app').innerHTML = `<div class="page"><div class="empty">Could not load dashboard data: ${err.message}</div></div>`;
    return;
  }
  setInterval(async () => {
    try {
      await loadData();
      // Skip the full render dispatch while on a slow-poll tab — those refresh
      // on their own dedicated timer below. STATE.data is still refreshed
      // silently so every other tab is current the moment you switch to it.
      if (!SLOW_POLL_ROUTES[STATE.route.name]) render();
    } catch (err) {
      console.error('Poll failed', err);
    }
  }, POLL_MS);

  markSlowPollFresh(STATE.route.name); // start the clock for the landing tab
  setInterval(() => {
    const name = STATE.route.name;
    const cfg = SLOW_POLL_ROUTES[name];
    if (!cfg) return;
    const last = slowPollLastRun[name];
    if (last == null) { slowPollLastRun[name] = Date.now(); return; }
    if (Date.now() - last < cfg.ms) return;
    slowPollLastRun[name] = Date.now();
    cfg.run();
  }, SLOW_POLL_TICK_MS);
})();
