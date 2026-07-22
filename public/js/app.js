// PSV Dashboard — vanilla JS SPA. All data comes live from /api/data (backed by Jira).
const STATE = {
  data: { generatedAt: null, count: 0, issues: [] },
  history: [],
  options: { pse: [], status: [], modules: [] },
  filters: { pse: new Set(), status: new Set(), modules: new Set(), tat: '', search: '' },
  route: { name: 'overview', param: null },
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
  };
  updateHeader(data);

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
    if (!matchesTat(i, f.tat)) return false;
    if (search) {
      const hay = `${i.key} ${i.summary} ${i.assignee || ''} ${i.kam || ''}`.toLowerCase();
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
  if (['activity', 'mrr', 'closing', 'tat', 'team'].includes(name)) return { name, param: null };
  return { name: 'overview', param: null };
}

function navigate(hash) {
  location.hash = hash;
}

window.addEventListener('hashchange', () => {
  STATE.route = parseRoute();
  render();
});

// ---------- rendering: shared bits ----------
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

function multiSelect(id, label, options, selected) {
  const summary = selected.size ? `${selected.size} selected` : `All`;
  const opts = options
    .map(
      (o) => `
      <label class="msel-opt">
        <input type="checkbox" data-mgroup="${id}" value="${escapeAttr(o)}" ${selected.has(o) ? 'checked' : ''}/>
        <span>${o}</span>
      </label>`
    )
    .join('');
  return `
    <div class="fgroup msel">
      <label>${label}</label>
      <button type="button" class="msel-btn" data-mtoggle="${id}">${summary}</button>
      <div class="msel-panel" id="panel-${id}">${opts || '<div class="empty" style="padding:10px">No options</div>'}</div>
    </div>`;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

function filterBar({ includeStatus = true } = {}) {
  const f = STATE.filters;
  const chips = [];
  f.pse.forEach((v) => chips.push({ group: 'pse', value: v, label: `PSE: ${v}` }));
  if (includeStatus) f.status.forEach((v) => chips.push({ group: 'status', value: v, label: `Status: ${v}` }));
  f.modules.forEach((v) => chips.push({ group: 'modules', value: v, label: `Module: ${v}` }));
  if (f.tat) chips.push({ group: 'tat', value: f.tat, label: `TAT: ${tatBucketLabel(f.tat)}` });

  return `
    <div class="fbar">
      <div class="fgroup">
        <label>Search</label>
        <input class="fi" id="searchInput" type="text" placeholder="Client, PSV key, KAM…" value="${escapeAttr(f.search)}"/>
      </div>
      ${multiSelect('pse', 'PSE', STATE.options.pse, f.pse)}
      ${includeStatus ? multiSelect('status', 'Status', STATE.options.status, f.status) : ''}
      ${multiSelect('modules', 'Modules', STATE.options.modules, f.modules)}
      <div class="fgroup">
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
      <button class="clear-btn" id="clearFiltersBtn">Clear filters</button>
      ${chips.length ? `<div class="fchips">${chips.map((c) => `<span class="fchip">${c.label}<span class="x" data-chip-group="${c.group}" data-chip-value="${escapeAttr(c.value)}">✕</span></span>`).join('')}</div>` : ''}
    </div>`;
}

function tatBucketLabel(b) {
  return { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed', '0-7': '0–7d', '8-15': '8–15d', '16-30': '16–30d', '31+': '31+d' }[b] || b;
}

// ---------- overview ----------
function renderOverview() {
  const base = applyFilters(STATE.data.issues, { skipStatus: true });
  const filtered = applyFilters(STATE.data.issues);

  const statusCounts = {};
  base.forEach((i) => {
    statusCounts[i.status || 'Unknown'] = (statusCounts[i.status || 'Unknown'] || 0) + 1;
  });
  const statusEntries = Object.entries(statusCounts).sort((a, b) => b[1] - a[1]);

  const wonCount = base.filter((i) => i.stageGroup === 'won').length;
  const activeCount = base.filter((i) => i.stageGroup === 'active').length;
  const churnCount = base.filter((i) => i.stageGroup === 'churn').length;
  const coldCount = base.filter((i) => i.stageGroup === 'cold').length;
  const stuckCount = base.filter((i) => i.stageGroup === 'active' && daysSince(i.updated) >= 14).length;
  const totalMrr = base.filter((i) => !isMrrMissing(i.mrr)).reduce((s, i) => s + i.mrr, 0);

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">Overview</div><div class="phs">Live from Jira PSV board · click a status block or KPI to drill in</div></div>
      ${filterBar()}
      <div class="krow">
        <div class="kpi"><div class="kb"></div><div class="kl">Total Deals</div><div class="kv">${base.length}</div><div class="ks">Matching current filters</div></div>
        <div class="kpi seg-kpi" data-segment="active" style="cursor:pointer"><div class="kb" style="background:var(--b)"></div><div class="kl">Active</div><div class="kv">${activeCount}</div><div class="ks">In pipeline</div></div>
        <div class="kpi seg-kpi" data-segment="won" style="cursor:pointer"><div class="kb" style="background:var(--g)"></div><div class="kl">Won</div><div class="kv">${wonCount}</div><div class="ks">Closed / completed</div></div>
        <div class="kpi seg-kpi" data-segment="cold" style="cursor:pointer"><div class="kb" style="background:var(--a)"></div><div class="kl">Cold / C3M</div><div class="kv">${coldCount}</div><div class="ks">Check in 3 months</div></div>
        <div class="kpi seg-kpi" data-segment="churn" style="cursor:pointer"><div class="kb" style="background:var(--r)"></div><div class="kl">Churn</div><div class="kv">${churnCount}</div><div class="ks">Lost deals</div></div>
        <div class="kpi seg-kpi" data-segment="stuck" style="cursor:pointer"><div class="kb" style="background:var(--a)"></div><div class="kl">Stuck 14d+</div><div class="kv">${stuckCount}</div><div class="ks">Active, not moved recently</div></div>
        <div class="kpi"><div class="kb" style="background:var(--b)"></div><div class="kl">Total MRR</div><div class="kv" style="font-size:22px">${fmtUsd(totalMrr)}</div><div class="ks"><a href="#/mrr">View MRR tab →</a></div></div>
      </div>

      <div class="sh"><div class="sht">Deals by Status</div><div class="shl"></div></div>
      <div class="sblocks" id="statusBlocks">
        ${statusEntries
          .map(([status, count]) => {
            const cat = base.find((i) => i.status === status)?.statusCategory;
            const color = CAT_COLOR[cat] || '#94A3B8';
            const pct = ((count / (base.length || 1)) * 100).toFixed(1);
            return `<div class="sblock" style="--cat-color:${color}" data-status="${escapeAttr(status)}">
              <div class="sb-name">${status}</div>
              <div class="sb-count">${count}</div>
              <div class="sb-pct">${pct}% of ${base.length}</div>
            </div>`;
          })
          .join('')}
      </div>

      <div class="g2">
        <div class="card"><div class="ct">PSE Workload</div><div class="cs">Cards per PSE (filtered)</div><div style="height:240px"><canvas id="pseChart"></canvas></div></div>
        <div class="card"><div class="ct">Module Interest</div><div class="cs">How often each module is requested</div><div style="height:240px"><canvas id="modChart"></canvas></div></div>
      </div>

      ${STATE.history.length > 1 ? `
      <div class="sh"><div class="sht">Trends</div><div class="shl"></div><div class="shb">Daily snapshots, unfiltered board totals</div></div>
      <div class="g2">
        <div class="card"><div class="ct">Total Deals Over Time</div><div class="cs">${STATE.history.length} day(s) of history</div><div style="height:220px"><canvas id="trendCountChart"></canvas></div></div>
        <div class="card"><div class="ct">Total MRR Over Time</div><div class="cs">Sum of valid MRR values (USD)</div><div style="height:220px"><canvas id="trendMrrChart"></canvas></div></div>
      </div>` : ''}
    </div>`;

  bindFilterBarEvents(renderOverview);
  document.querySelectorAll('#statusBlocks .sblock').forEach((el) => {
    el.addEventListener('click', () => navigate(`/status/${encodeURIComponent(el.dataset.status)}`));
  });
  document.querySelectorAll('.seg-kpi').forEach((el) => {
    el.addEventListener('click', () => navigate(`/segment/${el.dataset.segment}`));
  });

  destroyCharts();
  const pseCounts = {};
  base.forEach((i) => {
    const k = i.assignee || 'Unassigned';
    pseCounts[k] = (pseCounts[k] || 0) + 1;
  });
  const pseEntries = Object.entries(pseCounts).sort((a, b) => b[1] - a[1]);
  addChart('pseChart', 'bar', pseEntries.map((e) => e[0]), [{ label: 'Cards', data: pseEntries.map((e) => e[1]), backgroundColor: '#0054FC' }], { indexAxis: 'y' });

  const modCounts = {};
  base.forEach((i) => (i.modules || []).forEach((m) => (modCounts[m] = (modCounts[m] || 0) + 1)));
  const modEntries = Object.entries(modCounts).sort((a, b) => b[1] - a[1]);
  addChart('modChart', 'bar', modEntries.map((e) => e[0]), [{ label: 'Cards', data: modEntries.map((e) => e[1]), backgroundColor: '#12B76A' }], { indexAxis: 'y' });

  if (STATE.history.length > 1) {
    const labels = STATE.history.map((h) => h.date);
    addChart('trendCountChart', 'line', labels, [{ label: 'Total deals', data: STATE.history.map((h) => h.count), borderColor: '#0054FC', tension: 0.3, fill: false }]);
    addChart('trendMrrChart', 'line', labels, [{ label: 'Total MRR', data: STATE.history.map((h) => h.totalMrr), borderColor: '#12B76A', tension: 0.3, fill: false }]);
  }

  void filtered; // filtered set reserved for future use (search/status combined view)
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

const STAGE_LABEL = { active: 'Active', won: 'Won', churn: 'Churn', cold: 'Cold / C3M', rejected: 'Rejected' };

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
      </div>
      ${filterBar({ includeStatus: false })}
      <div class="tc">
        <div class="th"><span class="tht">Cards</span><span class="ths">Click a row for full detail</span></div>
        <div class="tw">
          <table>
            <thead><tr><th>Key</th><th>Client / Card</th><th>PSE</th><th>KAM</th><th>Priority</th><th>Modules</th><th>TAT</th><th>Updated</th></tr></thead>
            <tbody>
              ${
                rows
                  .map(
                    (i) => `
                <tr data-key="${i.key}">
                  <td class="cb" style="color:var(--b);font-weight:700">${i.key}</td>
                  <td>${i.summary || ''}</td>
                  <td>${i.assignee || '—'}</td>
                  <td>${i.kam || '—'}</td>
                  <td>${i.priority || '—'}</td>
                  <td>${modulePills(i.modules)}</td>
                  <td>${tatLabel(i)}</td>
                  <td>${new Date(i.updated).toLocaleDateString('en-IN')}</td>
                </tr>`
                  )
                  .join('') || '<tr><td colspan="8" class="empty">No cards match the current filters</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  document.getElementById('backLink').addEventListener('click', () => navigate('/'));
  bindFilterBarEvents(() => renderStatusDrilldown(status));
  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => {
    tr.addEventListener('click', () => openCardModal(tr.dataset.key));
  });
}

// ---------- segment drilldown (Active/Won/Cold/Churn/Stuck KPI clicks) ----------
const SEGMENT_META = {
  active: { title: 'Active Deals', desc: 'All in-pipeline statuses' },
  won: { title: 'Won Deals', desc: 'Completed / Closure-Contract Won' },
  cold: { title: 'Cold / Check in 3 Months', desc: '' },
  churn: { title: 'Churned Deals', desc: '' },
  stuck: { title: 'Stuck Deals (14+ days idle)', desc: 'Active deals not updated recently' },
};

function renderSegment(segment) {
  const meta = SEGMENT_META[segment] || { title: segment, desc: '' };
  let rows = applyFilters(STATE.data.issues);
  rows = segment === 'stuck'
    ? rows.filter((i) => i.stageGroup === 'active' && daysSince(i.updated) >= 14)
    : rows.filter((i) => i.stageGroup === segment);

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph">
        <div>
          <div class="back-link" id="backLink">← Back to Overview</div>
          <div class="pht" style="margin-top:6px">${meta.title}</div>
          <div class="phs">${rows.length} card(s) · ${meta.desc}</div>
        </div>
        <button class="clear-btn" id="exportBtn">Export CSV</button>
      </div>
      ${filterBar()}
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
                  <td>${i.assignee || '—'}</td>
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

  document.getElementById('backLink').addEventListener('click', () => navigate('/'));
  bindFilterBarEvents(() => renderSegment(segment));
  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
  document.getElementById('exportBtn').addEventListener('click', () => {
    const csv = toCsv(rows, [
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'Status', value: (r) => r.status },
      { label: 'PSE', value: (r) => r.assignee },
      { label: 'KAM', value: (r) => r.kam },
      { label: 'MRR', value: (r) => r.mrr },
      { label: 'TAT Days', value: (r) => r.tatDays },
      { label: 'Updated', value: (r) => r.updated },
    ]);
    downloadCsv(`psv-${segment}.csv`, csv);
  });
}

// ---------- MRR tab ----------
function renderMrr() {
  const rows = applyFilters(STATE.data.issues);
  const valid = rows.filter((i) => !isMrrMissing(i.mrr));
  const missing = rows.filter((i) => isMrrMissing(i.mrr));
  const totalMrr = valid.reduce((s, i) => s + i.mrr, 0);

  const byPse = {};
  rows.forEach((i) => {
    const k = i.assignee || 'Unassigned';
    if (!byPse[k]) byPse[k] = { valid: [], missing: [] };
    (isMrrMissing(i.mrr) ? byPse[k].missing : byPse[k].valid).push(i);
  });
  const pseNames = Object.keys(byPse).sort();

  const mrrByPseEntries = pseNames
    .map((p) => [p, byPse[p].valid.reduce((s, i) => s + i.mrr, 0)])
    .sort((a, b) => b[1] - a[1]);

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">MRR</div><div class="phs">Live from Jira "MRR (USD)" field · zero/one values are treated as not filled in</div></div>
      ${filterBar()}
      <div class="krow">
        <div class="kpi"><div class="kb" style="background:var(--g)"></div><div class="kl">Total MRR</div><div class="kv" style="font-size:24px">${fmtUsd(totalMrr)}</div><div class="ks">Across ${valid.length} deals with a real value</div></div>
        <div class="kpi"><div class="kb" style="background:var(--b)"></div><div class="kl">Deals w/ MRR set</div><div class="kv">${valid.length}</div><div class="ks">of ${rows.length} matching filters</div></div>
        <div class="kpi"><div class="kb" style="background:var(--a)"></div><div class="kl">Missing / 0 / 1</div><div class="kv">${missing.length}</div><div class="ks">Needs an update in Jira</div></div>
      </div>

      <div class="card" style="margin-bottom:16px"><div class="ct">MRR by PSE</div><div class="cs">Sum of valid MRR per PSE (USD)</div><div style="height:240px"><canvas id="mrrPseChart"></canvas></div></div>

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

  bindFilterBarEvents(renderMrr);
  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
  document.getElementById('exportMissingBtn').addEventListener('click', () => {
    const csv = toCsv(missing, [
      { label: 'PSE', value: (r) => r.assignee },
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'Status', value: (r) => r.status },
      { label: 'MRR value', value: (r) => r.mrr },
      { label: 'Updated', value: (r) => r.updated },
    ]);
    downloadCsv('psv-missing-mrr.csv', csv);
  });

  destroyCharts();
  addChart(
    'mrrPseChart',
    'bar',
    mrrByPseEntries.map((e) => e[0]),
    [{ label: 'MRR (USD)', data: mrrByPseEntries.map((e) => e[1]), backgroundColor: '#12B76A' }],
    { indexAxis: 'y' }
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
      <div class="ph"><div class="pht">Closing Soon</div><div class="phs">Deals with an Expected Sales Closure date in the next 30 days</div></div>
      ${filterBar()}
      <div class="krow">
        <div class="kpi"><div class="kb"></div><div class="kl">Closing in 30 Days</div><div class="kv">${rows.length}</div><div class="ks">Matching current filters</div></div>
        <div class="kpi"><div class="kb" style="background:var(--g)"></div><div class="kl">MRR at Stake</div><div class="kv" style="font-size:22px">${fmtUsd(totalMrr)}</div><div class="ks">Sum of valid MRR</div></div>
      </div>
      <div class="ph"><div></div><button class="clear-btn" id="exportBtn">Export CSV</button></div>
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
                  <td>${i.assignee || '—'}</td>
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

  bindFilterBarEvents(renderClosingSoon);
  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
  document.getElementById('exportBtn').addEventListener('click', () => {
    const csv = toCsv(rows, [
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'Status', value: (r) => r.status },
      { label: 'PSE', value: (r) => r.assignee },
      { label: 'KAM', value: (r) => r.kam },
      { label: 'MRR', value: (r) => r.mrr },
      { label: 'Closure Date', value: (r) => r.expectedSalesClosure },
      { label: 'Days Left', value: (r) => r.daysUntil },
    ]);
    downloadCsv('psv-closing-soon.csv', csv);
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

  const byPse = {};
  started.forEach((i) => {
    const k = i.assignee || 'Unassigned';
    if (!byPse[k]) byPse[k] = [];
    byPse[k].push(i);
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
      <td>${i.assignee || '—'}</td>
      <td>${i.tatStartDate ? new Date(i.tatStartDate).toLocaleDateString('en-IN') : '—'}</td>
      <td>${i.tatEndDate ? new Date(i.tatEndDate).toLocaleDateString('en-IN') : i.tatStatus === 'in_progress' ? '<span style="color:var(--t3)">ongoing</span>' : '—'}</td>
      <td>${tatSeverityBadge(i.tatDays)}</td>
    </tr>`;

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">TAT (Turnaround Time)</div><div class="phs">Req. Gathering → Solutions Draft Shared · Great ≤15d · Mid ≤30d · Watch ≤60d · Flagged &gt;60d</div></div>
      ${filterBar()}
      <div class="krow">
        <div class="kpi"><div class="kb" style="background:var(--g)"></div><div class="kl">Avg TAT (Completed)</div><div class="kv">${avgCompleted ?? '—'}${avgCompleted != null ? 'd' : ''}</div><div class="ks">Across ${completed.length} completed deals</div></div>
        <div class="kpi"><div class="kb" style="background:var(--b)"></div><div class="kl">Avg TAT (Running)</div><div class="kv">${avgRunning ?? '—'}${avgRunning != null ? 'd' : ''}</div><div class="ks">Across ${running.length} in-progress deals</div></div>
        <div class="kpi"><div class="kb" style="background:var(--r)"></div><div class="kl">Flagged &gt;60d</div><div class="kv">${flagged.length}</div><div class="ks">Needs attention</div></div>
        <div class="kpi"><div class="kb"></div><div class="kl">TAT Not Started</div><div class="kv">${notStartedCount}</div><div class="ks">Never entered Req. Gathering from Upcoming</div></div>
      </div>

      <div class="card" style="margin-bottom:16px"><div class="ct">Average Completed TAT by PSE</div><div class="cs">Lower is better (days)</div><div style="height:240px"><canvas id="tatPseChart"></canvas></div></div>

      <div class="ph"><div class="pht" style="font-size:14px">Flagged Deals (&gt;60 days)</div>${flagged.length ? '<button class="clear-btn" id="exportFlaggedBtn">Export CSV</button>' : ''}</div>
      <div class="tc">
        <div class="tw">
          <table>
            <thead><tr><th>Key</th><th>Client</th><th>Status</th><th>PSE</th><th>TAT Start</th><th>TAT End</th><th>TAT</th></tr></thead>
            <tbody>${flagged.map(dealRow).join('') || '<tr><td colspan="7" class="empty">No deals are over 60 days 🎉</td></tr>'}</tbody>
          </table>
        </div>
      </div>

      <div class="sh"><div class="sht">Deal-wise TAT by PSE</div><div class="shl"></div></div>
      ${pseNames
        .map((p) => {
          const list = byPse[p].slice().sort((a, b) => b.tatDays - a.tatDays);
          const pseAvg = avg(list.filter((i) => i.tatStatus === 'completed').map((i) => i.tatDays));
          return `
        <div class="tc">
          <div class="th"><span class="tht">${p}</span><span class="ths">${list.length} deal(s) with TAT started${pseAvg != null ? ` · avg completed ${pseAvg}d` : ''}</span></div>
          <div class="tw">
            <table>
              <thead><tr><th>Key</th><th>Client</th><th>Status</th><th>PSE</th><th>TAT Start</th><th>TAT End</th><th>TAT</th></tr></thead>
              <tbody>${list.map(dealRow).join('')}</tbody>
            </table>
          </div>
        </div>`;
        })
        .join('') || '<div class="empty">No deals have entered Req. Gathering yet</div>'}
    </div>`;

  bindFilterBarEvents(renderTat);
  document.querySelectorAll('tbody tr[data-key]').forEach((tr) => tr.addEventListener('click', () => openCardModal(tr.dataset.key)));
  const exportBtn = document.getElementById('exportFlaggedBtn');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const csv = toCsv(flagged, [
      { label: 'Key', value: (r) => r.key },
      { label: 'Client', value: (r) => r.summary },
      { label: 'Status', value: (r) => r.status },
      { label: 'PSE', value: (r) => r.assignee },
      { label: 'TAT Start', value: (r) => r.tatStartDate },
      { label: 'TAT End', value: (r) => r.tatEndDate },
      { label: 'TAT Days', value: (r) => r.tatDays },
    ]);
    downloadCsv('psv-tat-flagged.csv', csv);
  });

  destroyCharts();
  addChart(
    'tatPseChart',
    'bar',
    avgByPseEntries.map((e) => e[0]),
    [{ label: 'Avg Completed TAT (days)', data: avgByPseEntries.map((e) => e[1]), backgroundColor: avgByPseEntries.map((e) => ({ great: '#12B76A', mid: '#0054FC', watch: '#D97706', flagged: '#DC2626' }[tatSeverity(e[1])] || '#94A3B8')) }],
    { indexAxis: 'y' }
  );
}

// ---------- Team Performance tab ----------
function renderTeam() {
  const rows = applyFilters(STATE.data.issues);
  const byPse = {};
  rows.forEach((i) => {
    const k = i.assignee || 'Unassigned';
    if (!byPse[k]) byPse[k] = { total: 0, active: 0, won: 0, churn: 0, cold: 0, rejected: 0 };
    byPse[k].total++;
    byPse[k][i.stageGroup]++;
  });
  const pseNames = Object.keys(byPse).sort((a, b) => byPse[b].total - byPse[a].total);

  const statuses = distinct(rows.map((i) => i.status));
  const statusByPse = {};
  statuses.forEach((s) => {
    statusByPse[s] = {};
    pseNames.forEach((p) => (statusByPse[s][p] = 0));
  });
  rows.forEach((i) => {
    const k = i.assignee || 'Unassigned';
    if (!statusByPse[i.status]) statusByPse[i.status] = {};
    statusByPse[i.status][k] = (statusByPse[i.status][k] || 0) + 1;
  });

  document.getElementById('app').innerHTML = `
    <div class="page">
      <div class="ph"><div class="pht">Team Performance</div><div class="phs">Per-PSE win/churn rates, computed live from current statuses</div></div>
      ${filterBar()}
      <div class="krow">
        ${pseNames
          .map((p) => {
            const d = byPse[p];
            const winRate = d.total ? ((d.won / d.total) * 100).toFixed(1) : '0.0';
            const churnRate = d.total ? ((d.churn / d.total) * 100).toFixed(1) : '0.0';
            return `<div class="kpi"><div class="kb"></div><div class="kl">${p}</div><div class="kv" style="font-size:22px">${d.total}</div><div class="ks">Win ${winRate}% · Churn ${churnRate}%</div></div>`;
          })
          .join('')}
      </div>

      <div class="g2">
        <div class="card"><div class="ct">Portfolio by Stage Group</div><div class="cs">Active / Won / Cold / Churn per PSE</div><div style="height:280px"><canvas id="pseStackChart"></canvas></div></div>
        <div class="card"><div class="ct">Win Rate vs Churn Rate</div><div class="cs">% per PSE</div><div style="height:280px"><canvas id="rateChart"></canvas></div></div>
      </div>

      <div class="tc">
        <div class="th"><span class="tht">Status × PSE Matrix</span><span class="ths">Exact live counts</span></div>
        <div class="tw">
          <table>
            <thead><tr><th>Status</th>${pseNames.map((p) => `<th>${p}</th>`).join('')}<th>Total</th></tr></thead>
            <tbody>
              ${statuses
                .map((s) => {
                  const total = pseNames.reduce((sum, p) => sum + (statusByPse[s][p] || 0), 0);
                  return `<tr><td class="fw7" style="font-weight:700">${s}</td>${pseNames.map((p) => `<td>${statusByPse[s][p] || 0}</td>`).join('')}<td style="font-weight:700">${total}</td></tr>`;
                })
                .join('')}
              <tr style="background:#F7F9FC"><td style="font-weight:800">TOTAL</td>${pseNames.map((p) => `<td style="font-weight:800">${byPse[p].total}</td>`).join('')}<td style="font-weight:800">${rows.length}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  bindFilterBarEvents(renderTeam);
  destroyCharts();
  addChart(
    'pseStackChart',
    'bar',
    pseNames,
    [
      { label: 'Active', data: pseNames.map((p) => byPse[p].active), backgroundColor: '#0054FC' },
      { label: 'Won', data: pseNames.map((p) => byPse[p].won), backgroundColor: '#12B76A' },
      { label: 'Cold', data: pseNames.map((p) => byPse[p].cold), backgroundColor: '#D97706' },
      { label: 'Churn', data: pseNames.map((p) => byPse[p].churn), backgroundColor: '#DC2626' },
    ],
    { plugins: { legend: { display: true, position: 'bottom' } }, scales: { x: { stacked: true }, y: { stacked: true } } }
  );
  addChart(
    'rateChart',
    'bar',
    pseNames,
    [
      { label: 'Win %', data: pseNames.map((p) => (byPse[p].total ? +((byPse[p].won / byPse[p].total) * 100).toFixed(1) : 0)), backgroundColor: '#12B76A' },
      { label: 'Churn %', data: pseNames.map((p) => (byPse[p].total ? +((byPse[p].churn / byPse[p].total) * 100).toFixed(1) : 0)), backgroundColor: '#DC2626' },
    ],
    { plugins: { legend: { display: true, position: 'bottom' } } }
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
      <div class="ph"><div class="pht">Board Activity Log</div><div class="phs">Every field change across all PSV cards, most recent first · showing ${feed.length} of ${allActivity.length}</div></div>
      <div class="fbar">
        <div class="fgroup">
          <label>Search</label>
          <input class="fi" id="searchInput" type="text" placeholder="Card key, client, author…" value="${escapeAttr(STATE.filters.search)}"/>
        </div>
      </div>
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

  const input = document.getElementById('searchInput');
  input.addEventListener('input', () => {
    STATE.filters.search = input.value;
    renderActivity();
    document.getElementById('searchInput').focus();
    const v = document.getElementById('searchInput').value;
    document.getElementById('searchInput').setSelectionRange(v.length, v.length);
  });
  document.querySelectorAll('.tl-key').forEach((el) => el.addEventListener('click', () => openCardModal(el.dataset.key)));
}

function describeActivity(h) {
  if (h.field === 'status') return `Status moved from <b>${h.from || '—'}</b> to <b>${h.to || '—'}</b>`;
  if (h.field === 'assignee') return `PSE changed from <b>${h.from || 'Unassigned'}</b> to <b>${h.to || 'Unassigned'}</b>`;
  if (h.field === 'priority') return `Priority changed from <b>${h.from || '—'}</b> to <b>${h.to || '—'}</b>`;
  if (h.field === 'Comment') return `Comment added`;
  return `<b>${h.field}</b> updated${h.to ? ` to <b>${h.to}</b>` : ''}`;
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
        <div class="modal-key">${issue.key}</div>
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
        ${field('Request Category', issue.requestCategory)}
        ${field('Modules', modulePills(issue.modules))}
        ${field('Shipment Volume / Month', issue.shipmentVolume)}
        ${field('Expected Closure (weeks)', issue.expectedClosureWeeks)}
        ${field('Expected Sales Closure', issue.expectedSalesClosure)}
        ${field('Solutioning Start Date', issue.solutioningStartDate)}
        ${field('SoW Send Date', issue.sowSendDate)}
        ${field('SoW Confirmation Date', issue.sowConfirmationDate)}
        ${field('TAT', tatLabel(issue) + (issue.tatStartDate ? ` <span style="color:var(--t3);font-size:11px">(${new Date(issue.tatStartDate).toLocaleDateString('en-IN')} → ${issue.tatEndDate ? new Date(issue.tatEndDate).toLocaleDateString('en-IN') : 'ongoing'})</span>` : ''))}
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

// ---------- filter bar event binding ----------
function bindFilterBarEvents(rerender) {
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      STATE.filters.search = searchInput.value;
      rerender();
      const el = document.getElementById('searchInput');
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }

  const tatSelect = document.getElementById('tatSelect');
  if (tatSelect) tatSelect.addEventListener('change', () => {
    STATE.filters.tat = tatSelect.value;
    rerender();
  });

  document.querySelectorAll('[data-mtoggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.mtoggle;
      const panel = document.getElementById(`panel-${id}`);
      const isOpen = panel.classList.contains('open');
      document.querySelectorAll('.msel-panel').forEach((p) => p.classList.remove('open'));
      if (!isOpen) panel.classList.add('open');
    });
  });

  document.querySelectorAll('[data-mgroup]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const group = cb.dataset.mgroup;
      const set = STATE.filters[group];
      if (cb.checked) set.add(cb.value);
      else set.delete(cb.value);
      rerender();
    });
  });

  const clearBtn = document.getElementById('clearFiltersBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    STATE.filters = { pse: new Set(), status: new Set(), modules: new Set(), tat: '', search: '' };
    rerender();
  });

  document.querySelectorAll('[data-chip-group]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const group = chip.dataset.chipGroup;
      if (group === 'tat') STATE.filters.tat = '';
      else STATE.filters[group].delete(chip.dataset.chipValue);
      rerender();
    });
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.msel')) {
    document.querySelectorAll('.msel-panel').forEach((p) => p.classList.remove('open'));
  }
});

// ---------- charts ----------
function destroyCharts() {
  STATE.charts.forEach((c) => c.destroy());
  STATE.charts = [];
}

function addChart(canvasId, type, labels, datasets, extraOptions = {}) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  const chart = new Chart(el, {
    type,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      ...extraOptions,
    },
  });
  STATE.charts.push(chart);
}

// ---------- main render dispatch ----------
function render() {
  document.querySelectorAll('.nt').forEach((t) => t.classList.remove('active'));
  const navName = ['status', 'segment'].includes(STATE.route.name) ? 'overview' : STATE.route.name;
  document.querySelector(`.nt[data-route="${navName}"]`)?.classList.add('active');

  if (STATE.route.name === 'status') renderStatusDrilldown(STATE.route.param);
  else if (STATE.route.name === 'segment') renderSegment(STATE.route.param);
  else if (STATE.route.name === 'activity') renderActivity();
  else if (STATE.route.name === 'mrr') renderMrr();
  else if (STATE.route.name === 'closing') renderClosingSoon();
  else if (STATE.route.name === 'tat') renderTat();
  else if (STATE.route.name === 'team') renderTeam();
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
