// PSV Dashboard — vanilla JS SPA. All data comes live from /api/data (backed by Jira).
const QUARTER_START = '2026-05-01';
const TRACKER_PSE_ROWS = ['Ankith', 'Avani', 'Dhananjay', 'Karan', 'Surabhi', 'Utkarsh'];

const STATE = {
  data: { generatedAt: null, count: 0, issues: [] },
  history: [],
  options: { pse: [], status: [], modules: [], kam: [], salesRep: [], requestCategory: [] },
  filters: {
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
  },
  activityFilters: { pse: new Set(), status: new Set(), dealName: '', dateFrom: '', dateTo: '' },
  trackerFilters: { pse: new Set(), status: new Set(), helpInSow: '', flagApoorv: '', dateFrom: '', dateTo: '' },
  trackerLeave: {},
  tatFilters: { pse: new Set(), status: new Set(), health: new Set() },
  tatBox: 'all',
  route: { name: 'overview', param: null },
  adhoc: null,
  charts: [],
};

const CAT_COLOR = { Done: '#12B76A', 'In Progress': '#0054FC', 'To Do': '#94A3B8', New: '#94A3B8' };
const POLL_MS = 60 * 1000;

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
  el.textContent = `${data.count} cards · refreshed ${dt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
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
  if (['activity', 'mrr', 'closing', 'tat', 'team', 'pipeline', 'c3m', 'tracker', 'list', 'links'].includes(name)) {
    return { name, param: null };
  }
  return { name: 'overview', param: null };
}

function navigate(hash) {
  location.hash = hash;
}

window.addEventListener('hashchange', () => {
  STATE.route = parseRoute();
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
function goToFilteredList(title, predicate) {
  STATE.adhoc = { title, predicate };
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

function checkboxListHtml(id, options, selected) {
  if (!options.length) return '<div class="empty" style="padding:8px;font-size:11px;">No data</div>';
  return `<div class="sf-opts">${options
    .map(
      (o) => `
      <label class="sf-opt">
        <input type="checkbox" data-mgroup="${id}" value="${escapeAttr(o)}" ${selected.has(o) ? 'checked' : ''}/>
        <span>${o}</span>
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
    STATE.filters = {
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

// ---------- overview ----------
function renderOverview() {
  const base = applyFilters(STATE.data.issues, { skipStatus: true });

  const statusCounts = {};
  base.forEach((i) => {
    statusCounts[i.status || 'Unknown'] = (statusCounts[i.status || 'Unknown'] || 0) + 1;
  });
  const statusEntries = Object.entries(statusCounts).sort((a, b) => b[1] - a[1]);

  const activeCount = base.filter((i) => i.stageGroup === 'active').length;
  const coldCount = base.filter((i) => i.stageGroup === 'cold').length;
  const stuckCount = base.filter((i) => i.stageGroup === 'active' && daysSince(i.updated) >= 14).length;
  const totalMrr = base.filter((i) => !isMrrMissing(i.mrr)).reduce((s, i) => s + i.mrr, 0);

  const pseCounts = {};
  base.forEach((i) => (pseCounts[i.assignee] = (pseCounts[i.assignee] || 0) + 1));
  const pseEntries = Object.entries(pseCounts).sort((a, b) => b[1] - a[1]);

  const modCounts = {};
  base.forEach((i) => (i.modules || []).forEach((m) => (modCounts[m] = (modCounts[m] || 0) + 1)));
  const modEntries = Object.entries(modCounts).sort((a, b) => b[1] - a[1]);

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">Overview</div><div class="phs">Live from Jira PSV board · Project Cards only, closed/won deals excluded · click a status block, KPI, or chart bar to drill in</div></div>
      <div class="krow">
        <div class="kpi kpi-tint"><div class="kb"></div><div class="kl">Total Deals</div><div class="kv">${base.length}</div><div class="ks">Matching current filters</div></div>
        <div class="kpi kpi-tint seg-kpi" data-segment="active" style="--kc:var(--b)"><div class="kb" style="background:var(--b)"></div><div class="kl">Active</div><div class="kv">${activeCount}</div><div class="ks">In pipeline</div></div>
        <div class="kpi kpi-tint seg-kpi" data-segment="cold" style="--kc:var(--a)"><div class="kb" style="background:var(--a)"></div><div class="kl">Cold / C3M</div><div class="kv">${coldCount}</div><div class="ks">Check in 3 months</div></div>
        <div class="kpi kpi-tint seg-kpi" data-segment="stuck" style="--kc:var(--a)"><div class="kb" style="background:var(--a)"></div><div class="kl">Stuck 14d+</div><div class="kv">${stuckCount}</div><div class="ks">Active, not moved recently</div></div>
        <div class="kpi kpi-tint" style="--kc:var(--b)"><div class="kb" style="background:var(--b)"></div><div class="kl">Total MRR</div><div class="kv" style="font-size:22px">${fmtUsd(totalMrr)}</div><div class="ks"><a href="#/mrr">View MRR tab →</a></div></div>
      </div>

      <div class="sh"><div class="sht">Deals by Status</div><div class="shl"></div><div class="shb">Scroll for more, like the Jira board</div></div>
      <div class="board-strip" id="statusBlocks">
        ${statusEntries
          .map(([status, count]) => {
            const cat = base.find((i) => i.status === status)?.statusCategory;
            const color = CAT_COLOR[cat] || '#94A3B8';
            const pct = ((count / (base.length || 1)) * 100).toFixed(1);
            return `<div class="bcol" data-status="${escapeAttr(status)}">
              <div class="bcol-head" style="background:${color}">${status}</div>
              <div class="bcol-body">
                <div class="bcol-count">${count}</div>
                <div class="bcol-pct">${pct}% of ${base.length}</div>
              </div>
            </div>`;
          })
          .join('')}
      </div>

      <div class="g2">
        <div class="card"><div class="ct">PSE Workload</div><div class="cs">Cards per PSE (filtered) · click a bar</div><div style="height:${hBarHeight(pseEntries.length)}"><canvas id="pseChart"></canvas></div></div>
        <div class="card"><div class="ct">Module Interest</div><div class="cs">How often each module is requested · click a bar</div><div style="height:${hBarHeight(modEntries.length)}"><canvas id="modChart"></canvas></div></div>
      </div>

      ${STATE.history.length > 1 ? `
      <div class="sh"><div class="sht">Trends</div><div class="shl"></div><div class="shb">Daily snapshots, unfiltered board totals</div></div>
      <div class="g2">
        <div class="card"><div class="ct">Total Deals Over Time</div><div class="cs">${STATE.history.length} day(s) of history</div><div style="height:220px"><canvas id="trendCountChart"></canvas></div></div>
        <div class="card"><div class="ct">Total MRR Over Time</div><div class="cs">Sum of valid MRR values (USD)</div><div style="height:220px"><canvas id="trendMrrChart"></canvas></div></div>
      </div>` : ''}
    </div>`;

  document.querySelectorAll('#statusBlocks .bcol').forEach((el) => {
    el.addEventListener('click', () => navigate(`/status/${encodeURIComponent(el.dataset.status)}`));
  });
  document.querySelectorAll('.seg-kpi').forEach((el) => {
    el.addEventListener('click', () => navigate(`/segment/${el.dataset.segment}`));
  });

  destroyCharts();
  addChart(
    'pseChart', 'bar', pseEntries.map((e) => e[0]),
    [{ label: 'Cards', data: pseEntries.map((e) => e[1]), backgroundColor: '#0054FC' }],
    { indexAxis: 'y' },
    (pse) => goToFilteredList(`PSE: ${pse}`, (i) => i.assignee === pse)
  );
  addChart(
    'modChart', 'bar', modEntries.map((e) => e[0]),
    [{ label: 'Cards', data: modEntries.map((e) => e[1]), backgroundColor: '#12B76A' }],
    { indexAxis: 'y' },
    (mod) => goToFilteredList(`Module: ${mod}`, (i) => (i.modules || []).includes(mod))
  );

  if (STATE.history.length > 1) {
    const labels = STATE.history.map((h) => h.date);
    addChart('trendCountChart', 'line', labels, [{ label: 'Total deals', data: STATE.history.map((h) => h.count), borderColor: '#0054FC', tension: 0.3, fill: false }]);
    addChart('trendMrrChart', 'line', labels, [{ label: 'Total MRR', data: STATE.history.map((h) => h.totalMrr), borderColor: '#12B76A', tension: 0.3, fill: false }]);
  }
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
                  <td>${new Date(i.updated).toLocaleDateString('en-IN')}</td>
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
  const rows = applyFilters(STATE.data.issues).filter(ad.predicate);
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
                  <td>${new Date(i.updated).toLocaleDateString('en-IN')}</td>
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
      <td>${i.solutioningStartDate ? new Date(i.solutioningStartDate).toLocaleDateString('en-IN') : '—'}</td>
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
              <thead><tr><th>Key</th><th>Client</th><th>Status</th><th>KAM</th><th>Sales Rep</th><th>MRR</th><th>ARR</th><th>Size</th><th>Sol. Start</th><th>Flag</th><th></th></tr></thead>
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
      <td>${new Date(i.updated).toLocaleDateString('en-IN')}</td>
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
            <thead><tr><th>Key</th><th>Client</th><th>PSE</th><th>Status</th><th>MRR</th><th>ARR</th><th></th></tr></thead>
            <tbody>${largeDeals.map(dealSizeRow).join('') || '<tr><td colspan="7" class="empty">No large deals match the current filters</td></tr>'}</tbody>
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
                <thead><tr><th>Key</th><th>Client</th><th>Status</th><th>MRR value</th><th>Updated</th></tr></thead>
                <tbody>
                  ${list
                    .map(
                      (i) => `
                    <tr data-key="${i.key}">
                      <td style="color:var(--b);font-weight:700">${i.key}</td>
                      <td>${i.summary || ''}</td>
                      <td>${fbadge(i.status)}</td>
                      <td>${i.mrr === null ? '<span class="bd bgy">blank</span>' : `<span class="bd ba">${i.mrr}</span>`}</td>
                      <td>${new Date(i.updated).toLocaleDateString('en-IN')}</td>
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
    .filter((i) => i.expectedSalesClosure)
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
            <thead><tr><th>Key</th><th>Client / Card</th><th>Status</th><th>PSE</th><th>KAM</th><th>MRR</th><th>Closure Date</th><th>Days Left</th></tr></thead>
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
                  <td>${new Date(i.expectedSalesClosure).toLocaleDateString('en-IN')}</td>
                  <td><span class="bd ${i.daysUntil <= 7 ? 'br' : i.daysUntil <= 15 ? 'ba' : 'bb'}">${i.daysUntil}d</span></td>
                </tr>`
                  )
                  .join('') || '<tr><td colspan="8" class="empty">No deals closing in the next 30 days</td></tr>'
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
      { label: 'MRR', value: (r) => r.mrr },
      { label: 'Closure Date', value: (r) => r.expectedSalesClosure },
      { label: 'Days Left', value: (r) => r.daysUntil },
    ]));
  });
}

// ---------- TAT tab ----------
// Only PSE/Status/Health matter here — the TAT tab has its own exclusive
// sidebar, not the universal Jira filter set.
function applyTatFilters(list) {
  const f = STATE.tatFilters;
  return list.filter((i) => {
    if (f.pse.size && !f.pse.has(i.assignee)) return false;
    if (f.status.size && !f.status.has(i.status)) return false;
    if (f.health.size && !f.health.has(tatHealth(i.tatDays))) return false;
    return true;
  });
}

function tatDealRow(i) {
  const inHold = i.status === PENDING_ON_CLIENT;
  return `
    <tr data-key="${i.key}">
      <td><a class="jira-key-link" href="${i.url}" target="_blank" rel="noopener" title="Open ${i.key} in Jira">${i.key} ↗</a></td>
      <td>${i.summary || ''}</td>
      <td>${i.assignee}</td>
      <td>${fbadge(i.status)}</td>
      <td>${i.tatStartDate ? new Date(i.tatStartDate).toLocaleDateString('en-IN') : '—'}</td>
      <td>${i.tatHoldDays ? `<span class="bd ba">${i.tatHoldDays}d${inHold ? ' · ongoing' : ''}</span>` : '—'}</td>
      <td>${i.tatDays != null ? i.tatDays + 'd' : '—'}</td>
      <td>${tatHealthBadge(i.tatDays)}</td>
    </tr>`;
}

function tatDealTable(list, emptyMsg) {
  return `
    <div class="tc">
      <div class="tw">
        <table>
          <thead><tr><th>Key</th><th>Client</th><th>PSE</th><th>Status</th><th>Sol. Start</th><th>Client Hold</th><th>Active TAT</th><th>Health</th></tr></thead>
          <tbody>${list.map(tatDealRow).join('') || `<tr><td colspan="8" class="empty">${emptyMsg}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}

function renderTat() {
  renderTatSidebar();

  const issues = STATE.data.issues;
  const isActiveStatus = (i) => TAT_ACTIVE_STATUSES.includes(i.status);

  // Q1 FY26-27 active deals: an active status + Solutioning Start on/after 1 May 2026.
  const quarterActive = issues.filter((i) => isActiveStatus(i) && i.solutioningStartDate && i.solutioningStartDate >= QUARTER_START);
  // Pre-quarter but still ongoing: started before 1 May 2026, no SoW Send yet, active status.
  const preQuarterOngoing = issues.filter((i) => isActiveStatus(i) && i.solutioningStartDate && i.solutioningStartDate < QUARTER_START && !i.sowSendDate);
  // Active status but no Solutioning Start Date yet — can't compute TAT.
  const noStart = issues.filter((i) => isActiveStatus(i) && !i.solutioningStartDate);
  // Solutioning (Post closure) — tracked separately, exclusive from active TAT.
  const postClosure = issues.filter((i) => i.status === TAT_POST_CLOSURE_STATUS);

  // Sidebar PSE/Status filters scope the whole active view; health boxes are computed from that scope.
  const scoped = applyTatFilters(quarterActive.filter((i) => {
    const f = STATE.tatFilters;
    if (f.pse.size && !f.pse.has(i.assignee)) return false;
    if (f.status.size && !f.status.has(i.status)) return false;
    return true;
  }));

  const good = scoped.filter((i) => tatHealth(i.tatDays) === 'good');
  const mid = scoped.filter((i) => tatHealth(i.tatDays) === 'mid');
  const review = scoped.filter((i) => tatHealth(i.tatDays) === 'review');
  const inHold = scoped.filter((i) => i.status === PENDING_ON_CLIENT);
  const avgActive = avg(scoped.map((i) => i.tatDays).filter((d) => d != null));
  const avgHold = avg(scoped.map((i) => i.tatHoldDays || 0));

  const boxes = [
    { id: 'all', label: 'Active Q1 Deals', value: scoped.length, sub: 'Since 1 May 2026', color: 'var(--b)' },
    { id: 'good', label: 'Good (≤30d)', value: good.length, sub: 'Healthy', color: '#12B76A' },
    { id: 'mid', label: 'Mid (31–60d)', value: mid.length, sub: 'Watch', color: '#D97706' },
    { id: 'review', label: 'Review (≥61d)', value: review.length, sub: 'Needs attention', color: '#DC2626' },
    { id: 'hold', label: 'In Client Hold', value: inHold.length, sub: 'Currently Pending On Client', color: 'var(--pu)' },
  ];

  // Which list the selected value box shows.
  const boxList = {
    all: scoped,
    good, mid, review,
    hold: inHold,
  }[STATE.tatBox] || scoped;
  const detail = applyTatFilters(boxList).slice().sort((a, b) => (b.tatDays ?? 0) - (a.tatDays ?? 0));
  const boxLabel = (boxes.find((b) => b.id === STATE.tatBox) || boxes[0]).label;

  // Per-PSE active averages (dynamic, colored by the average's own health band).
  const byPse = {};
  scoped.forEach((i) => { (byPse[i.assignee] = byPse[i.assignee] || []).push(i); });
  const pseNames = Object.keys(byPse).sort((a, b) => byPse[b].length - byPse[a].length);
  const avgByPse = pseNames
    .map((p) => [p, avg(byPse[p].map((i) => i.tatDays).filter((d) => d != null))])
    .filter((e) => e[1] != null)
    .sort((a, b) => a[1] - b[1]);

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">TAT (Turnaround Time)</div><div class="phs">Active TAT for FY26-27 Q1 (Solutioning Start ≥ 1 May 2026) · statuses: Req. Gathering · Solution Design · Pending On Client · Solutions Draft Shared · client hold time excluded · live from Jira · Good ≤30d · Mid 31–60d · Review ≥61d</div></div>

      <div class="krow tat-boxes">
        ${boxes.map((b) => `
          <div class="kpi tat-box ${STATE.tatBox === b.id ? 'active' : ''}" data-box="${b.id}">
            <div class="kb" style="background:${b.color}"></div>
            <div class="kl">${b.label}</div>
            <div class="kv">${b.value}</div>
            <div class="ks">${b.sub}</div>
          </div>`).join('')}
      </div>

      <div class="krow">
        <div class="kpi"><div class="kb" style="background:var(--b)"></div><div class="kl">Avg Active TAT</div><div class="kv">${avgActive ?? '—'}${avgActive != null ? 'd' : ''}</div><div class="ks">Across ${scoped.length} active deals</div></div>
        <div class="kpi"><div class="kb" style="background:var(--a)"></div><div class="kl">Avg Client Hold Excluded</div><div class="kv">${avgHold ?? '—'}${avgHold != null ? 'd' : ''}</div><div class="ks">Pending On Client time removed</div></div>
      </div>

      <div class="card" style="margin-bottom:16px"><div class="ct">Average Active TAT by PSE</div><div class="cs">Lower is better (days) · colored by health · click a bar to filter that PSE</div><div style="height:${hBarHeight(avgByPse.length)}px"><canvas id="tatPseChart"></canvas></div></div>

      <div class="ph"><div class="pht" style="font-size:14px">${boxLabel} — ${detail.length} deal(s)</div>${detail.length ? '<button class="clear-btn" id="exportTatBtn">Export CSV</button>' : ''}</div>
      ${tatDealTable(detail, 'No deals in this view')}

      <div class="sh"><div class="sht">Active TAT by PSE</div><div class="shl"></div></div>
      ${
        pseNames.map((p) => {
          const list = applyTatFilters(byPse[p]).slice().sort((a, b) => (b.tatDays ?? 0) - (a.tatDays ?? 0));
          if (!list.length) return '';
          const pseAvg = avg(list.map((i) => i.tatDays).filter((d) => d != null));
          return `
        <div class="tc">
          <div class="th"><span class="tht">${p}</span><span class="ths">${list.length} active deal(s)${pseAvg != null ? ` · avg ${pseAvg}d ${TAT_HEALTH_META[tatHealth(pseAvg)].label}` : ''}</span></div>
          <div class="tw">
            <table>
              <thead><tr><th>Key</th><th>Client</th><th>PSE</th><th>Status</th><th>Sol. Start</th><th>Client Hold</th><th>Active TAT</th><th>Health</th></tr></thead>
              <tbody>${list.map(tatDealRow).join('')}</tbody>
            </table>
          </div>
        </div>`;
        }).join('') || '<div class="empty">No active Q1 deals match the current filters</div>'
      }

      <div class="sh" style="margin-top:24px"><div class="sht">Ongoing Deals Started Before 1 May 2026 (no SoW Send yet)</div><div class="shl"></div></div>
      <div class="phs" style="margin-bottom:10px">Carried-over active deals (Req. Gathering / Solution Design / Pending On Client / Solutions Draft Shared) — outside Q1 but still open</div>
      ${tatDealTable(applyTatFilters(preQuarterOngoing).slice().sort((a, b) => (b.tatDays ?? 0) - (a.tatDays ?? 0)), 'No pre-quarter ongoing deals')}

      <div class="sh" style="margin-top:24px"><div class="sht">Solutioning (Post Closure)</div><div class="shl"></div></div>
      <div class="phs" style="margin-bottom:10px">Tracked separately — excluded from active TAT totals and health above</div>
      ${tatDealTable(applyTatFilters(postClosure).slice().sort((a, b) => (b.tatDays ?? 0) - (a.tatDays ?? 0)), 'No post-closure deals')}

      ${noStart.length ? `
      <div class="sh" style="margin-top:24px"><div class="sht">Active Status, Awaiting Solutioning Start Date</div><div class="shl"></div></div>
      <div class="phs" style="margin-bottom:10px">${noStart.length} deal(s) in an active status but with no Solutioning Start Date — TAT can't start yet</div>
      ${tatDealTable(applyTatFilters(noStart), 'None')}` : ''}
    </div>`;

  // Row click → card modal; the Jira "↗" link opens Jira without triggering the modal.
  document.querySelectorAll('tbody tr[data-key]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.jira-key-link')) return;
      openCardModal(tr.dataset.key);
    })
  );

  document.querySelectorAll('.tat-box').forEach((box) => {
    box.addEventListener('click', () => {
      STATE.tatBox = box.dataset.box;
      renderTat();
    });
  });

  const exportBtn = document.getElementById('exportTatBtn');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    downloadCsv('psv-tat-active.csv', toCsv(detail, [
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'PSE', value: (r) => r.assignee },
      { label: 'Status', value: (r) => r.status },
      { label: 'Solutioning Start', value: (r) => r.tatStartDate },
      { label: 'Client Hold Days', value: (r) => r.tatHoldDays },
      { label: 'Active TAT Days', value: (r) => r.tatDays },
      { label: 'Health', value: (r) => (tatHealth(r.tatDays) ? TAT_HEALTH_META[tatHealth(r.tatDays)].label : '') },
      { label: 'Jira URL', value: (r) => r.url },
    ]));
  });

  destroyCharts();
  addChart(
    'tatPseChart', 'bar', avgByPse.map((e) => e[0]),
    [{ label: 'Avg Active TAT (days)', data: avgByPse.map((e) => e[1]), backgroundColor: avgByPse.map((e) => TAT_HEALTH_META[tatHealth(e[1])].color) }],
    { indexAxis: 'y', scales: { y: { ticks: { autoSkip: false } } } },
    (pse) => { STATE.tatFilters.pse = new Set([pse]); STATE.tatBox = 'all'; renderTat(); }
  );
}

// Exclusive TAT sidebar: PSE, Status (the 4 active), Health band.
function renderTatSidebar() {
  if (!STATE.facc) loadSidebarPrefs();
  const f = STATE.tatFilters;
  const activeCount = f.pse.size + f.status.size + f.health.size;
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
      ${faccGroup('pse', 'PSE', checkboxListHtml('pse', STATE.options.pse, f.pse), f.pse.size)}
      ${faccGroup('status', 'Status', checkboxListHtml('status', TAT_ACTIVE_STATUSES, f.status), f.status.size)}
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
    STATE.tatFilters = { pse: new Set(), status: new Set(), health: new Set() };
    STATE.tatBox = 'all';
    renderTat();
  });
}

// ---------- Team Performance tab ----------
function renderTeam() {
  const rows = applyFilters(STATE.data.issues);
  const byPse = {};
  rows.forEach((i) => {
    if (!byPse[i.assignee]) byPse[i.assignee] = { total: 0, active: 0, won: 0, churn: 0, cold: 0, rejected: 0 };
    byPse[i.assignee].total++;
    byPse[i.assignee][i.stageGroup]++;
  });
  const pseNames = Object.keys(byPse).sort((a, b) => byPse[b].total - byPse[a].total);

  const statuses = distinct(rows.map((i) => i.status));
  const statusByPse = {};
  statuses.forEach((s) => {
    statusByPse[s] = {};
    pseNames.forEach((p) => (statusByPse[s][p] = 0));
  });
  rows.forEach((i) => {
    if (!statusByPse[i.status]) statusByPse[i.status] = {};
    statusByPse[i.status][i.assignee] = (statusByPse[i.status][i.assignee] || 0) + 1;
  });

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">Team Performance</div><div class="phs">Per-PSE live portfolio breakdown · closed/won deals aren't tracked here — this reflects work still in motion</div></div>
      <div class="krow">
        ${pseNames
          .map((p) => {
            const d = byPse[p];
            return `<div class="kpi"><div class="kb"></div><div class="kl">${p}</div><div class="kv" style="font-size:22px">${d.total}</div><div class="ks">${d.active} active · ${d.cold} cold</div></div>`;
          })
          .join('')}
      </div>

      <div class="card" style="margin-bottom:16px"><div class="ct">Portfolio by Stage</div><div class="cs">Active / Cold per PSE</div><div style="height:280px"><canvas id="pseStackChart"></canvas></div></div>

      <div class="tc">
        <div class="th"><span class="tht">Status × PSE Matrix</span><span class="ths">Exact live counts</span></div>
        <div class="tw">
          <table>
            <thead><tr><th>Status</th>${pseNames.map((p) => `<th>${p}</th>`).join('')}<th>Total</th></tr></thead>
            <tbody>
              ${statuses
                .map((s) => {
                  const total = pseNames.reduce((sum, p) => sum + (statusByPse[s][p] || 0), 0);
                  return `<tr><td style="font-weight:700">${s}</td>${pseNames.map((p) => `<td>${statusByPse[s][p] || 0}</td>`).join('')}<td style="font-weight:700">${total}</td></tr>`;
                })
                .join('')}
              <tr style="background:#F7F9FC"><td style="font-weight:800">TOTAL</td>${pseNames.map((p) => `<td style="font-weight:800">${byPse[p].total}</td>`).join('')}<td style="font-weight:800">${rows.length}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  destroyCharts();
  addChart(
    'pseStackChart', 'bar', pseNames,
    [
      { label: 'Active', data: pseNames.map((p) => byPse[p].active), backgroundColor: '#0054FC' },
      { label: 'Cold', data: pseNames.map((p) => byPse[p].cold), backgroundColor: '#D97706' },
    ],
    { plugins: { legend: { display: true, position: 'bottom' } }, scales: { x: { stacked: true }, y: { stacked: true } } },
    (pse) => goToFilteredList(`PSE: ${pse}`, (i) => i.assignee === pse)
  );
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
      <div class="ph"><div class="pht">Board Activity Log</div><div class="phs">Every field change across all PSV cards, most recent first · showing ${feed.length} of ${allActivity.length} · use the sidebar filters</div></div>
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
                <div class="tl-meta">${a.author || 'Unknown'} · ${new Date(a.created).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</div>
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
// Inclusive list of Mon–Fri working-day date strings between from and to.
function workingDaysBetween(from, to) {
  const days = [];
  let d = from;
  while (d <= to) {
    if (!isWeekendDay(d)) days.push(d);
    d = addDays(d, 1);
  }
  return days;
}

// Report windows start fresh on these dates (per spec); anything earlier just
// shows a "not started yet" note rather than partial data.
const WEEKLY_REPORT_START = '2026-07-27'; // Monday
const MONTHLY_REPORT_START = '2026-08-03'; // first Monday of Aug 2026

// Aggregate one PSE's completion stats across a set of working days. Tasks are
// bucketed by their INITIAL committed due date; "delayed" tasks (finished late
// or still open past commitment) are collected with their extra-day count so
// the report can highlight them and name them on hover.
function pseStats(tasks, leave, pse, days, referenceDay = istToday()) {
  const dayset = new Set(days);
  let due = 0, onTime = 0, delayed = 0, unmarked = 0, created = 0, completed = 0, leaveDays = 0, extraDaysTotal = 0;
  const delayedList = [];
  for (const d of days) if (leave[`${pse}|${d}`]) leaveDays++;
  for (const t of tasks) {
    if (t.pse !== pse) continue;
    if (t.createdDate && dayset.has(t.createdDate)) created++;
    if (t.completedDate && dayset.has(t.completedDate)) completed++;
    const committed = committedDue(t);
    if (committed && dayset.has(committed)) {
      due++;
      const extra = taskDelayDays(t, referenceDay);
      if (t.status === 'Done' && extra === 0) {
        onTime++;
      } else if (extra > 0) {
        delayed++;
        extraDaysTotal += extra;
        delayedList.push({ name: t.dealName || '(unnamed task)', extra });
      }
      if (t.status !== 'Done') unmarked++;
    }
  }
  const rate = due ? Math.round((onTime / due) * 100) : null;
  return { due, onTime, delayed, unmarked, created, completed, leaveDays, extraDaysTotal, delayedList, rate };
}

// Mirrors lib/tracker.js: still-open tasks carry forward to every day from
// creation onward; once Done, the task remains visible on its start day,
// its actual completion day, and its due day — so both ends stay on record.
function taskVisibleOnDay(task, day) {
  if (task.createdDate > day) return false;
  if (task.status === 'Done') {
    return day === task.createdDate || day === task.completedDate || day === task.dueDate;
  }
  return true;
}

// The hard-coded initial commitment. Falls back to the current dueDate for
// legacy tasks created before committedDueDate existed.
function committedDue(task) {
  return task.committedDueDate || task.dueDate || null;
}
function daysBetween(fromStr, toStr) {
  return Math.round((Date.parse(toStr + 'T00:00:00Z') - Date.parse(fromStr + 'T00:00:00Z')) / 86400000);
}

// A task is delayed when it blew past its INITIAL committed due date — whether
// it was eventually finished late, or is still open past that date. Measured
// against the committed date so pushing the due date out can't clear the flag.
function taskDelayDays(task, referenceDay = istToday()) {
  const committed = committedDue(task);
  if (!committed) return 0;
  const endRef = task.status === 'Done' ? task.completedDate || referenceDay : referenceDay;
  const diff = daysBetween(committed, endRef);
  return diff > 0 ? diff : 0;
}
// referenceDay defaults to real "today", but the tracker view always passes
// STATE.trackerDay explicitly — so browsing forward to a future day via
// "Next" immediately shows tasks past their committed date as delayed.
function taskOverdue(task, referenceDay = istToday()) {
  const committed = committedDue(task);
  if (task.status === 'Done') return !!committed && !!task.completedDate && task.completedDate > committed;
  return !!committed && committed < referenceDay;
}

const trackerSaveTimers = {};

async function renderTracker() {
  document.getElementById('app').innerHTML = '<div class="page"><div class="loading">Loading tracker…</div></div>';
  if (!STATE.trackerDay) STATE.trackerDay = lastWorkingDayOnOrBefore(istToday());
  try {
    const [tasks, leave] = await Promise.all([
      fetch('/api/tracker', { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
      fetch('/api/tracker?resource=leave', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})),
    ]);
    STATE.trackerTasks = tasks;
    STATE.trackerLeave = leave || {};
  } catch (err) {
    document.getElementById('app').innerHTML = `<div class="page"><div class="empty">Could not load the task tracker: ${err.message}</div></div>`;
    return;
  }
  renderTrackerView();
}

function trackerRow(t, day) {
  const overdue = taskOverdue(t, day);
  const delay = taskDelayDays(t, day);
  const committed = committedDue(t);
  const statusCls = 'tk-status-' + (t.status || 'Open').toLowerCase().replace(/\s+/g, '-');
  const delayCell = delay > 0
    ? `<span class="delay-chip" title="Committed due ${committed || '—'}${t.dueDate && t.dueDate !== committed ? ` · revised to ${t.dueDate}` : ''} — ${t.status === 'Done' ? 'completed' : 'still open'} ${delay} day(s) late">+${delay}d late</span>`
    : '<span class="tk-ontime">—</span>';
  return `
    <tr data-id="${t.id}" class="${overdue ? 'row-flagged' : ''}">
      <td class="tk-cell tk-cell-name"><input class="tk-input" data-field="dealName" value="${escapeAttr(t.dealName || '')}" placeholder="Task name…"/></td>
      <td class="tk-cell">
        <select class="tk-select tk-select-status ${statusCls}" data-field="status">
          ${['Open', 'In Progress', 'Done'].map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="tk-cell"><input class="tk-input" type="date" data-field="dueDate" value="${t.dueDate || ''}"/></td>
      <td class="tk-cell tk-cell-delay">${delayCell}</td>
      <td class="tk-cell">
        <select class="tk-select tk-select-yn ${t.flagApoorv ? 'yn-yes' : 'yn-no'}" data-field="flagApoorv">
          <option value="false" ${!t.flagApoorv ? 'selected' : ''}>No</option>
          <option value="true" ${t.flagApoorv ? 'selected' : ''}>Yes</option>
        </select>
      </td>
      <td class="tk-cell">
        <select class="tk-select tk-select-yn ${t.helpInSow ? 'yn-yes' : 'yn-no'}" data-field="helpInSow">
          <option value="false" ${!t.helpInSow ? 'selected' : ''}>No</option>
          <option value="true" ${t.helpInSow ? 'selected' : ''}>Yes</option>
        </select>
      </td>
      <td class="tk-cell"><input class="tk-input" data-field="blocker" value="${escapeAttr(t.blocker || '')}" placeholder="Remarks…"/></td>
      <td class="tk-cell"><button class="tk-del" data-del-id="${t.id}" title="Delete task">✕</button></td>
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
  if (f.status.size && !f.status.has(t.status)) return false;
  if (f.helpInSow && String(!!t.helpInSow) !== f.helpInSow) return false;
  if (f.flagApoorv && String(!!t.flagApoorv) !== f.flagApoorv) return false;
  return true;
}

function reportTable(title, subtitle, tasks, leave, days, pses) {
  const refDay = STATE.trackerDay || istToday();
  const rows = pses.map((pse) => {
    const s = pseStats(tasks, leave, pse, days, refDay);
    const rateCls = s.rate == null ? '' : s.rate >= 80 ? 'rate-good' : s.rate >= 50 ? 'rate-mid' : 'rate-bad';
    // Hover tooltip naming each delayed task and how many extra days it ran.
    const delayedTip = s.delayedList.length
      ? escapeAttr(s.delayedList.map((x) => `${x.name} (+${x.extra}d)`).join(', '))
      : '';
    const delayedCell = s.delayed
      ? `<span class="delay-chip" title="Delayed tasks — ${delayedTip}">${s.delayed} · +${s.extraDaysTotal}d</span>`
      : '0';
    return `
      <tr class="${s.delayed ? 'report-row-delayed' : ''}">
        <td class="tk-cell"><b>${pse}</b></td>
        <td class="tk-cell">${s.due}</td>
        <td class="tk-cell">${s.onTime}</td>
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
          <thead><tr><th>PSE</th><th>Tasks Due</th><th>On Time</th><th title="Tasks that missed their committed due date — hover the value to see which">Delayed</th><th>Unmarked</th><th>On Leave</th><th>Completion</th></tr></thead>
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
    <div class="ph" style="margin-top:26px"><div class="pht" style="font-size:15px">Completion Tracker Reports</div><div class="phs">Auto-calculated · "Unmarked" = tasks due but not marked Done · weekends excluded · leave days discounted</div></div>
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
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  renderTrackerSidebar();

  const pses = trackerVisiblePses();
  const tasksForPse = allTasks.filter((t) => pses.includes(t.pse));

  const daynav = `
    <div class="tk-daynav">
      <button id="prevDayBtn">← Prev working day</button>
      <div class="tk-daydate">${dayLabel}${isToday ? ' (Today)' : weekend ? ' · Weekend' : ''}</div>
      <button id="nextDayBtn">Next working day →</button>
      ${!isToday ? '<button id="todayBtn">Jump to Today</button>' : ''}
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
  const sc = { Open: 0, 'In Progress': 0, Done: 0 };
  visibleToday.forEach((t) => { sc[t.status] = (sc[t.status] || 0) + 1; });
  const delayedToday = visibleToday.filter((t) => taskDelayDays(t, day) > 0).length;
  const overdueTotal = tasksForPse.filter((t) => taskOverdue(t, day)).length;

  const summaryPanel = `
    <div class="tk-summary">
      <div class="tk-sum-cell tk-sum-open"><span class="tk-sum-n">${sc.Open}</span><span class="tk-sum-l">Open</span></div>
      <div class="tk-sum-cell tk-sum-prog"><span class="tk-sum-n">${sc['In Progress']}</span><span class="tk-sum-l">In Progress</span></div>
      <div class="tk-sum-cell tk-sum-done"><span class="tk-sum-n">${sc.Done}</span><span class="tk-sum-l">Done</span></div>
      <div class="tk-sum-cell tk-sum-delayed"><span class="tk-sum-n">${delayedToday}</span><span class="tk-sum-l">Delayed</span></div>
    </div>`;

  const pseSections = pses.map((pse) => {
    const onLeave = !!leave[`${pse}|${day}`];
    const rows = tasksForPse
      .filter((t) => t.pse === pse && taskVisibleOnDay(t, day) && trackerRowMatchesFilters(t))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return `
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
          <thead><tr><th style="width:30%">Task Name</th><th>Status</th><th>Due Date</th><th>Delay</th><th>Flag Apoorv</th><th>Help in SOW</th><th style="width:22%">Blocker</th><th></th></tr></thead>
          <tbody>${rows.map((t) => trackerRow(t, day)).join('') || '<tr><td colspan="8" class="empty">No tasks</td></tr>'}</tbody>
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
          <div class="phs">One sheet per PSE · in-progress tasks carry forward automatically until marked Done · rows in red missed their committed due date (${overdueTotal})</div>
        </div>
        ${summaryPanel}
      </div>
      ${daynav}
      ${pseSections || '<div class="empty">No PSE matches the current filter</div>'}
      ${renderTrackerReports(tasksForPse, leave, pses, day)}
    </div>`;

  bindTrackerEvents();
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

  document.querySelectorAll('.tk-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delId;
      if (!confirm('Delete this task?')) return;
      await fetch(`/api/tracker/${id}`, { method: 'DELETE' });
      STATE.trackerTasks = STATE.trackerTasks.filter((t) => t.id !== id);
      renderTrackerView();
    });
  });

  document.querySelectorAll('.tk-input[data-field], .tk-select[data-field]').forEach((el) => {
    const row = el.closest('tr');
    const id = row.dataset.id;
    const field = el.dataset.field;
    const immediate = el.tagName === 'SELECT' || el.type === 'date';
    el.addEventListener(immediate ? 'change' : 'input', () => {
      let value = el.value;
      if (field === 'flagApoorv' || field === 'helpInSow') value = value === 'true';
      saveTrackerField(id, field, value, immediate);
    });
  });
}

// Exclusive left-sidebar filters for the Daily Tracker tab: PSE, Status,
// Date bracket, Help in SOW, Flag Apoorv (per spec — the universal Jira
// filters don't apply here).
function renderTrackerSidebar() {
  if (!STATE.facc) loadSidebarPrefs();
  const f = STATE.trackerFilters;
  const activeCount = f.pse.size + f.status.size + (f.helpInSow ? 1 : 0) + (f.flagApoorv ? 1 : 0) + (f.dateFrom ? 1 : 0) + (f.dateTo ? 1 : 0);
  const sb = document.getElementById('sidebar');
  sb.style.display = '';
  sb.classList.toggle('collapsed', STATE.sidebarCollapsed);
  sb.innerHTML = `
    <div class="sb-header">
      <div class="sb-title">Filters${activeCount ? `<span class="facc-badge">${activeCount}</span>` : ''}</div>
      <button class="sb-toggle" id="sidebarToggleBtn" title="${STATE.sidebarCollapsed ? 'Expand filters' : 'Collapse filters'}">${STATE.sidebarCollapsed ? '»' : '«'}</button>
    </div>
    <div class="sb-content" id="sidebarContent" style="display:${STATE.sidebarCollapsed ? 'none' : ''}">
      ${faccGroup('pse', 'PSE', checkboxListHtml('pse', TRACKER_PSE_ROWS, f.pse), f.pse.size)}
      ${faccGroup('status', 'Status', checkboxListHtml('status', ['Open', 'In Progress', 'Done'], f.status), f.status.size)}

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
          <input type="date" class="fi" id="tkDateFrom" value="${f.dateFrom}"/>
          <input type="date" class="fi" id="tkDateTo" value="${f.dateTo}"/>
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
    STATE.trackerFilters = { pse: new Set(), status: new Set(), helpInSow: '', flagApoorv: '', dateFrom: '', dateTo: '' };
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
          const groupLinks = groups[group];
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
        .join('')}
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
          <div class="tl-meta">${h.author || 'Unknown'} · ${new Date(h.created).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</div>
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
        ${field('Expected Sales Closure', issue.expectedSalesClosure)}
        ${field('Solutioning Start Date', issue.solutioningStartDate)}
        ${field('SoW Send Date', issue.sowSendDate)}
        ${field('SoW Confirmation Date', issue.sowConfirmationDate)}
        ${field('TAT', tatLabel(issue) + (issue.tatHoldDays ? ` <span style="color:var(--t3);font-size:11px">(excl. ${issue.tatHoldDays}d client hold)</span>` : ''))}
        ${field('Created', new Date(issue.created).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}
        ${field('Last Updated', new Date(issue.updated).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}
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
  document.querySelector(`.nt[data-route="${navName}"]`)?.classList.add('active');

  // The universal Jira filters (PSE, Status, KAM, etc.) don't apply to Quick
  // Links or Activity Log — those routes swap the same sidebar element for
  // their own filter set instead (see renderQuickLinksSidebar /
  // renderActivitySidebar). Restore the normal Jira sidebar for every other tab.
  if (!['links', 'activity', 'tracker', 'tat'].includes(STATE.route.name)) renderSidebar();

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
  else renderOverview();
}

document.querySelectorAll('.nt').forEach((t) => {
  t.addEventListener('click', () => navigate(t.dataset.route === 'overview' ? '/' : `/${t.dataset.route}`));
});

document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  btn.textContent = 'Refreshing…';
  btn.disabled = true;
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await loadData();
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
      render();
    } catch (err) {
      console.error('Poll failed', err);
    }
  }, POLL_MS);
})();
