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
      <div class="ph"><div class="pht">Active Pipeline</div><div class="phs">Req. Gathering · Internal Sign-off ("Solution Design") · Pending On Client · Solutions Draft Shared · COMMERCIALS · Solutioning (Post closure) — not yet closed. Use "Current quarter only" in the sidebar to hide pre-quarter holdovers.</div></div>
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
function renderTat() {
  const allFiltered = applyFilters(STATE.data.issues);
  const started = allFiltered.filter((i) => i.tatDays != null);
  const completed = started.filter((i) => i.tatStatus === 'completed');
  const running = started.filter((i) => i.tatStatus === 'in_progress');
  const notStartedCount = allFiltered.filter((i) => i.tatStatus === 'not_started').length;
  const flagged = started.filter((i) => tatSeverity(i.tatDays) === 'flagged').sort((a, b) => b.tatDays - a.tatDays);

  const avgCompleted = avg(completed.map((i) => i.tatDays));
  const avgRunning = avg(running.map((i) => i.tatDays));
  const avgHold = avg(started.map((i) => i.tatHoldDays || 0));

  const byPse = {};
  started.forEach((i) => {
    if (!byPse[i.assignee]) byPse[i.assignee] = [];
    byPse[i.assignee].push(i);
  });
  const pseNames = Object.keys(byPse).sort((a, b) => byPse[b].length - byPse[a].length);
  const avgByPseEntries = pseNames
    .map((p) => [p, avg(byPse[p].filter((i) => i.tatStatus === 'completed').map((i) => i.tatDays))])
    .filter((e) => e[1] != null)
    .sort((a, b) => a[1] - b[1]);

  const dealRow = (i) => `
    <tr data-key="${i.key}">
      <td style="color:var(--b);font-weight:700">${i.key}</td>
      <td>${i.summary || ''}</td>
      <td>${fbadge(i.status)}</td>
      <td>${i.assignee}</td>
      <td>${i.tatStartDate ? new Date(i.tatStartDate).toLocaleDateString('en-IN') : '—'}</td>
      <td>${i.tatEndDate ? new Date(i.tatEndDate).toLocaleDateString('en-IN') : i.tatStatus === 'in_progress' ? '<span style="color:var(--t3)">ongoing</span>' : '—'}</td>
      <td>${i.tatHoldDays ? `<span class="bd ba">${i.tatHoldDays}d</span>` : '—'}</td>
      <td>${tatSeverityBadge(i.tatDays)}</td>
    </tr>`;

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">TAT (Turnaround Time)</div><div class="phs">Solutioning Start Date → SoW Send Date, excluding any time spent in "Pending On Client" · Great ≤15d · Mid ≤30d · Watch ≤60d · Flagged &gt;60d</div></div>
      <div class="krow">
        <div class="kpi"><div class="kb" style="background:var(--g)"></div><div class="kl">Avg TAT (Completed)</div><div class="kv">${avgCompleted ?? '—'}${avgCompleted != null ? 'd' : ''}</div><div class="ks">Across ${completed.length} completed deals</div></div>
        <div class="kpi"><div class="kb" style="background:var(--b)"></div><div class="kl">Avg TAT (Running)</div><div class="kv">${avgRunning ?? '—'}${avgRunning != null ? 'd' : ''}</div><div class="ks">Across ${running.length} in-progress deals</div></div>
        <div class="kpi"><div class="kb" style="background:var(--a)"></div><div class="kl">Avg Client Hold</div><div class="kv">${avgHold ?? '—'}${avgHold != null ? 'd' : ''}</div><div class="ks">Time excluded (Pending On Client)</div></div>
        <div class="kpi"><div class="kb" style="background:var(--r)"></div><div class="kl">Flagged &gt;60d</div><div class="kv">${flagged.length}</div><div class="ks">Needs attention</div></div>
        <div class="kpi"><div class="kb"></div><div class="kl">TAT Not Started</div><div class="kv">${notStartedCount}</div><div class="ks">No Solutioning Start Date yet</div></div>
      </div>

      <div class="card" style="margin-bottom:16px"><div class="ct">Average Completed TAT by PSE</div><div class="cs">Lower is better (days) · click a bar</div><div style="height:240px"><canvas id="tatPseChart"></canvas></div></div>

      <div class="ph"><div class="pht" style="font-size:14px">Flagged Deals (&gt;60 days)</div>${flagged.length ? '<button class="clear-btn" id="exportFlaggedBtn">Export CSV</button>' : ''}</div>
      <div class="tc">
        <div class="tw">
          <table>
            <thead><tr><th>Key</th><th>Client</th><th>Status</th><th>PSE</th><th>Sol. Start</th><th>SoW Send</th><th>Client Hold</th><th>TAT</th></tr></thead>
            <tbody>${flagged.map(dealRow).join('') || '<tr><td colspan="8" class="empty">No deals are over 60 days 🎉</td></tr>'}</tbody>
          </table>
        </div>
      </div>

      <div class="sh"><div class="sht">Deal-wise TAT by PSE</div><div class="shl"></div></div>
      ${
        pseNames
          .map((p) => {
            const list = byPse[p].slice().sort((a, b) => b.tatDays - a.tatDays);
            const pseAvg = avg(list.filter((i) => i.tatStatus === 'completed').map((i) => i.tatDays));
            return `
        <div class="tc">
          <div class="th"><span class="tht">${p}</span><span class="ths">${list.length} deal(s) with TAT started${pseAvg != null ? ` · avg completed ${pseAvg}d` : ''}</span></div>
          <div class="tw">
            <table>
              <thead><tr><th>Key</th><th>Client</th><th>Status</th><th>PSE</th><th>Sol. Start</th><th>SoW Send</th><th>Client Hold</th><th>TAT</th></tr></thead>
              <tbody>${list.map(dealRow).join('')}</tbody>
            </table>
          </div>
        </div>`;
          })
          .join('') || '<div class="empty">No deals have a Solutioning Start Date yet</div>'
      }
    </div>`;

  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
  const exportBtn = document.getElementById('exportFlaggedBtn');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    downloadCsv('psv-tat-flagged.csv', toCsv(flagged, [
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'Status', value: (r) => r.status },
      { label: 'PSE', value: (r) => r.assignee },
      { label: 'Solutioning Start', value: (r) => r.tatStartDate },
      { label: 'SoW Send', value: (r) => r.tatEndDate },
      { label: 'Client Hold Days', value: (r) => r.tatHoldDays },
      { label: 'TAT Days', value: (r) => r.tatDays },
    ]));
  });

  destroyCharts();
  addChart(
    'tatPseChart', 'bar', avgByPseEntries.map((e) => e[0]),
    [{ label: 'Avg Completed TAT (days)', data: avgByPseEntries.map((e) => e[1]), backgroundColor: avgByPseEntries.map((e) => ({ great: '#12B76A', mid: '#0054FC', watch: '#D97706', flagged: '#DC2626' }[tatSeverity(e[1])] || '#94A3B8')) }],
    { indexAxis: 'y' },
    (pse) => goToFilteredList(`TAT — ${pse}`, (i) => i.assignee === pse && i.tatDays != null)
  );
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
function renderActivity() {
  const allActivity = STATE.data.issues
    .flatMap((i) => (i.history || []).map((h) => ({ ...h, key: i.key, summary: i.summary })))
    .sort((a, b) => new Date(b.created) - new Date(a.created));

  const search = STATE.filters.search.trim().toLowerCase();
  const feed = (search
    ? allActivity.filter((a) => `${a.key} ${a.summary} ${a.author || ''} ${a.field}`.toLowerCase().includes(search))
    : allActivity
  ).slice(0, 400);

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">Board Activity Log</div><div class="phs">Every field change across all PSV cards, most recent first · showing ${feed.length} of ${allActivity.length} · use the sidebar search</div></div>
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

// referenceDay defaults to real "today", but the tracker view always passes
// STATE.trackerDay explicitly — so browsing forward to a future day via
// "Next" immediately shows tasks due before THAT day as overdue, instead of
// waiting for the real clock to catch up to whatever day you're looking at.
function taskOverdue(task, referenceDay = istToday()) {
  return task.status !== 'Done' && !!task.dueDate && task.dueDate < referenceDay;
}

const trackerSaveTimers = {};

async function renderTracker() {
  document.getElementById('app').innerHTML = '<div class="page"><div class="loading">Loading tracker…</div></div>';
  if (!STATE.trackerDay) STATE.trackerDay = istToday();
  try {
    const res = await fetch('/api/tracker', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    STATE.trackerTasks = await res.json();
  } catch (err) {
    document.getElementById('app').innerHTML = `<div class="page"><div class="empty">Could not load the task tracker: ${err.message}</div></div>`;
    return;
  }
  renderTrackerView();
}

function trackerRow(t, day) {
  const overdue = taskOverdue(t, day);
  return `
    <tr data-id="${t.id}" class="${overdue ? 'row-flagged' : ''}">
      <td class="tk-cell"><input class="tk-input" data-field="dealName" value="${escapeAttr(t.dealName || '')}" placeholder="Deal name…"/></td>
      <td class="tk-cell">
        <select class="tk-select" data-field="status">
          ${['Open', 'In Progress', 'Done'].map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="tk-cell"><input class="tk-input" type="date" data-field="dueDate" value="${t.dueDate || ''}"/></td>
      <td class="tk-cell">
        <select class="tk-select" data-field="flagApoorv">
          <option value="false" ${!t.flagApoorv ? 'selected' : ''}>No</option>
          <option value="true" ${t.flagApoorv ? 'selected' : ''}>Yes</option>
        </select>
      </td>
      <td class="tk-cell">
        <select class="tk-select" data-field="helpInSow">
          <option value="false" ${!t.helpInSow ? 'selected' : ''}>No</option>
          <option value="true" ${t.helpInSow ? 'selected' : ''}>Yes</option>
        </select>
      </td>
      <td class="tk-cell"><input class="tk-input" data-field="blocker" value="${escapeAttr(t.blocker || '')}" placeholder="Remarks…"/></td>
      <td class="tk-cell"><button class="tk-del" data-del-id="${t.id}" title="Delete task">✕</button></td>
    </tr>`;
}

function renderTrackerView() {
  const day = STATE.trackerDay;
  const tasks = STATE.trackerTasks || [];
  const isToday = day === istToday();
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  const overdueTotal = tasks.filter((t) => taskOverdue(t, day)).length;

  const pseSections = TRACKER_PSE_ROWS.map((pse) => {
    const rows = tasks
      .filter((t) => t.pse === pse && taskVisibleOnDay(t, day))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return `
    <div class="tc">
      <div class="th"><span class="tht">${pse}</span><span class="ths">${rows.length} task(s)</span></div>
      <div class="tw">
        <table>
          <thead><tr><th style="width:26%">Deal Name</th><th>Status</th><th>Due Date</th><th>Flag Apoorv</th><th>Help in SOW</th><th style="width:20%">Blocker</th><th></th></tr></thead>
          <tbody>${rows.map((t) => trackerRow(t, day)).join('') || '<tr><td colspan="7" class="empty">No tasks yet</td></tr>'}</tbody>
        </table>
      </div>
      <div style="padding:10px 16px"><button class="tk-add" data-add-pse="${pse}">+ Add Task</button></div>
    </div>`;
  }).join('');

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">Daily Task Tracker</div><div class="phs">One sheet per PSE · in-progress tasks carry forward automatically until marked Done · red rows are overdue as of this day (${overdueTotal})</div></div>
      <div class="tk-daynav">
        <button id="prevDayBtn">← Prev</button>
        <div class="tk-daydate">${dayLabel}${isToday ? ' (Today)' : ''}</div>
        <button id="nextDayBtn">Next →</button>
        ${!isToday ? '<button id="todayBtn">Jump to Today</button>' : ''}
      </div>
      ${pseSections}
    </div>`;

  bindTrackerEvents();
}

function bindTrackerEvents() {
  document.getElementById('prevDayBtn').addEventListener('click', () => {
    STATE.trackerDay = addDays(STATE.trackerDay, -1);
    renderTrackerView();
  });
  document.getElementById('nextDayBtn').addEventListener('click', () => {
    STATE.trackerDay = addDays(STATE.trackerDay, 1);
    renderTrackerView();
  });
  const todayBtn = document.getElementById('todayBtn');
  if (todayBtn) todayBtn.addEventListener('click', () => {
    STATE.trackerDay = istToday();
    renderTrackerView();
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
// A simple static reference list — add entries here as they're shared.
// Optional "group" clusters related links under the same heading.
const QUICK_LINKS = [
  { name: 'GoComet_PSV_Board_PSE_Process_Guide', url: 'https://docs.google.com/document/d/1vj_hQZ3ApDX_ZLUi3P-w0cHqSE0V1bojfoiiXLJHj9Q/edit?usp=sharing' },
  { name: 'Feature Alignment Matrix', url: 'https://docs.google.com/spreadsheets/d/1jArAvGvCjucuPTK3ZrSDZpsLoTUv1C2RmS9tMmaOBLY/edit?usp=sharing' },
  { name: 'Customer Feature and Guardrail', url: 'https://docs.google.com/spreadsheets/d/1IZ38WmjYlbBu7FCzOHVGsHFBj_r4AQ28gom6hmHuEH0/edit?usp=sharing' },
  { name: 'Existing Clients and Modules List', url: 'https://docs.google.com/spreadsheets/d/1Z4ezXemkt7QZzFpjtrJnHJ45DbTI9EDWe_dnnu_1ZIQ/edit?usp=sharing' },
  { name: 'Operations (Ops) Repository Latest', url: 'https://docs.google.com/spreadsheets/d/1kXxI11KuE3CPJkFbD00mJhT7Q1E5fEmVdRcLaVvDUjA/edit?usp=sharing' },
  { name: 'Product Council Sheet', url: 'https://docs.google.com/spreadsheets/d/1JiSiBSP2GpMxUb6wG9LfcCr53wIo7Kf9s8udA2hSdKw/edit?usp=sharing' },

  { name: 'Deck1_Training_Plan.pdf', url: 'https://gocomet.slack.com/files/U08B06AJK6K/F0B5EKSE7S9/deck1_training_plan.pdf', group: 'Solutions Team Decks' },
  { name: 'Deck2_Operational_Checklists.pdf', url: 'https://gocomet.slack.com/files/U08B06AJK6K/F0B5MKL2YRJ/deck2_operational_checklists.pdf', group: 'Solutions Team Decks' },
  { name: 'Deck3_Governance_Metrics.pdf', url: 'https://gocomet.slack.com/files/U08B06AJK6K/F0B5J1MTG3C/deck3_governance_metrics.pdf', group: 'Solutions Team Decks' },
  { name: 'KPI_Incentive_Framework_Presentation.pdf', url: 'https://gocomet.slack.com/files/U08B06AJK6K/F0B52HNBADV/kpi_incentive_framework_presentation.pdf', group: 'Solutions Team Decks' },
  { name: 'Product Solutions Team Deck.pdf', url: 'https://gocomet.slack.com/files/U08B06AJK6K/F0B5J1N11UJ/product_solutions_team_deck.pdf', group: 'Solutions Team Decks' },
];

function renderQuickLinks() {
  if (!QUICK_LINKS.length) {
    document.getElementById('app').innerHTML = `
      <div class="page">
        <div class="ph"><div class="pht">Quick Links</div><div class="phs">A quick-reference repository of important worksheets for the Product Solutions team</div></div>
        <div class="empty">No links added yet — share a name and URL and it'll show up here.</div>
      </div>`;
    return;
  }

  const groups = {};
  QUICK_LINKS.forEach((l) => {
    const g = l.group || 'Links';
    if (!groups[g]) groups[g] = [];
    groups[g].push(l);
  });

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">Quick Links</div><div class="phs">A quick-reference repository of important worksheets for the Product Solutions team</div></div>
      ${Object.entries(groups)
        .map(
          ([group, links]) => `
        <div class="sh"><div class="sht">${group}</div><div class="shl"></div></div>
        <div class="link-grid">
          ${links
            .map(
              (l) => `
            <a class="link-card" href="${l.url}" target="_blank" rel="noopener">
              <span class="link-card-name">${l.name}</span>
              <span class="link-card-arrow">↗</span>
            </a>`
            )
            .join('')}
        </div>`
        )
        .join('')}
    </div>`;
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
