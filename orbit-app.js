/* ============================================================
   PROJECT ORBIT — Application Logic
   Filtering · KPI Computation · Charts (Canvas) · Table

   Manager mapping design:
     D_PROD[m] = org-level manager as recorded in Fact_Productivity
                 for that specific period — PERIOD-AWARE.
     D_PROD[a] = associate name.
     D_ASSOC   = domain-ID → name lookup for QA resolution only.
     D_MANAGERS = union of all managers from D_PROD + D_QA.

   Manager is NEVER sourced from Dim_Associate (static).
   ============================================================ */

'use strict';

/* ── Enterprise Target engine ───────────────────────────────── */
// Rate and headcount are fixed business inputs — not derived from data.
// They do NOT respond to Manager or Associate filters.
// Only the selected month changes the business-day count.
const ENT = {
  RATE: 29.75,       // standard daily production rate per associate
  HEADCOUNT: 28,     // billable headcount (update when roster changes)

  // US Federal holidays observed in 2026 (date strings yyyy-MM-dd).
  // Observed rule applied: if holiday falls Sat → Fri, Sun → Mon.
  HOLIDAYS: new Set([
    '2026-01-01', // New Year's Day
    '2026-01-19', // MLK Day
    '2026-02-16', // Presidents' Day
    '2026-05-25', // Memorial Day
    '2026-06-19', // Juneteenth
    '2026-07-03', // Independence Day (Jul 4 Sat → observed Fri Jul 3)
    '2026-09-07', // Labor Day
    '2026-10-12', // Columbus Day
    '2026-11-11', // Veterans Day
    '2026-11-26', // Thanksgiving
    '2026-12-25', // Christmas
  ]),

  // Returns business days in a given 'yyyy-MM' string.
  // Excludes Saturdays, Sundays, and holidays from HOLIDAYS.
  bizDays(ym) {
    if (!ym || ym === 'all') return null;
    const [yr, mo] = ym.split('-').map(Number);
    const last = new Date(yr, mo, 0).getDate(); // days in month
    let count = 0;
    for (let d = 1; d <= last; d++) {
      const dt  = new Date(yr, mo - 1, d);
      const dow = dt.getDay(); // 0=Sun, 6=Sat
      if (dow === 0 || dow === 6) continue;
      const ds = `${yr}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (!ENT.HOLIDAYS.has(ds)) count++;
    }
    return count;
  },

  // Returns { target, bizDays } for a ym, or null when ym === 'all'.
  compute(ym) {
    const bd = ENT.bizDays(ym);
    if (bd === null) return null;
    return { target: Math.round(ENT.RATE * ENT.HEADCOUNT * bd * 100) / 100, bizDays: bd };
  },
};

/* ── State ─────────────────────────────────────────────────── */
const STATE = {
  month:   'all',   // 'all' | 'yyyy-MM'
  manager: 'all',   // 'all' | manager name string (matches D_PROD[m])
  sortCol: 'prodPct',
  sortDir: 'desc',
};

let trendChart = null;
let qaChart    = null;

/* ── Helpers ────────────────────────────────────────────────── */
const fmt = {
  num:  v => v == null ? '—' : Number(v).toLocaleString('en-US', {maximumFractionDigits: 0}),
  pct:  v => v == null ? '—' : (v * 100).toFixed(1) + '%',
  sign: v => v > 0 ? '+' + fmt.num(v) : fmt.num(v),
};

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

/* ── QA Passing Threshold (Payment Integrity standard) ─────── */
// 98.50% is the fixed business threshold. Anything below is FAIL.
// Do NOT change this to a relative or percentile-based rule.
const QA_PASS = 0.985;

// Returns 'pass' | 'fail' | null (null = no QA data)
function qaStatus(score) {
  if (score == null) return null;
  return score >= QA_PASS ? 'pass' : 'fail';
}

/* ── Domain ID → name lookup (for QA only, not for manager) ── */
// Built once from D_ASSOC: id → associate name
const idToName = {};
D_ASSOC.forEach(r => { if (r.id && r.n) idToName[r.id] = r.n; });

/* ── Data filtering ─────────────────────────────────────────── */
// Manager filter matches D_PROD[m] directly — period-aware because
// each D_PROD row carries the manager valid for that specific ym.
function filterProd(month, manager) {
  return D_PROD.filter(r =>
    (manager === 'all' || r.m === manager) &&
    (month   === 'all' || r.ym === month)
  );
}

// QA manager filter matches D_QA[m] directly (same logic).
function filterQA(month, manager) {
  return D_QA.filter(r =>
    (manager === 'all' || r.m === manager) &&
    (month   === 'all' || r.d.startsWith(month))
  );
}

/* ── Group helpers ──────────────────────────────────────────── */
function uniqueSorted(arr, key) {
  return [...new Set(arr.map(r => r[key]))].filter(Boolean).sort();
}

function groupBy(arr, key) {
  return arr.reduce((acc, r) => {
    const k = r[key];
    if (!acc[k]) acc[k] = [];
    acc[k].push(r);
    return acc;
  }, {});
}

/* ── KPI computation ────────────────────────────────────────── */
function computeKPIs(prodRows, qaRows) {
  const totalAct = prodRows.reduce((s, r) => s + (r.act || 0), 0);
  const totalTgt = prodRows.reduce((s, r) => s + (r.tgt || 0), 0);
  const prodPct  = totalTgt > 0 ? totalAct / totalTgt : 0;

  // QA: group by domain ID to count distinct audited associates
  const qaByID = groupBy(qaRows, 'id');
  const qaIDKeys = Object.keys(qaByID).filter(k => k && k !== '');
  let totalCnt = 0, weightedScore = 0;
  qaIDKeys.forEach(id => {
    const rows = qaByID[id];
    const cnt  = rows.reduce((s, r) => s + (r.cnt || 0), 0);
    const wScr = rows.reduce((s, r) => s + (r.cnt || 0) * (r.scr || 0), 0);
    totalCnt      += cnt;
    weightedScore += wScr;
  });
  const avgQA   = totalCnt > 0 ? weightedScore / totalCnt : 0;
  const audited = qaIDKeys.length;

  return { totalAct, totalTgt, prodPct, avgQA, totalCnt, audited };
}

/* ── Associate table computation ───────────────────────────── */
// Manager = D_PROD[m] for the filtered period (period-aware).
// When month filter is active, each associate's manager reflects
// who managed them IN THAT MONTH — not a static Dim_Associate value.
function computeAssocTable(prodRows, qaRows) {
  const assocMap = {};

  // Build from prod rows — group by associate name
  // Manager for each associate = D_PROD[m] for rows in this filter window.
  // If an associate appears under different managers in different months
  // and month='all', we take the most recent manager (largest ym).
  const prodByAssoc = groupBy(prodRows, 'a');
  Object.entries(prodByAssoc).forEach(([name, rows]) => {
    if (!name) return;
    const act = rows.reduce((s, r) => s + (r.act || 0), 0);
    const tgt = rows.reduce((s, r) => s + (r.tgt || 0), 0);
    // Most recent manager for this associate in the filtered window
    const sorted  = [...rows].sort((a, b) => (a.ym > b.ym ? -1 : 1));
    const manager = sorted[0].m;
    assocMap[name] = { name, manager, act, tgt, qaCnt: 0, qaScr: 0 };
  });

  // Merge QA data — resolve domain ID → associate name via D_ASSOC lookup
  const qaByID = groupBy(qaRows, 'id');
  Object.entries(qaByID).forEach(([id, rows]) => {
    // Resolve name: D_ASSOC lookup first, fallback to D_QA[a], fallback to id
    const name = idToName[id] || rows[0].a || id;
    if (!name) return;
    const cnt  = rows.reduce((s, r) => s + (r.cnt || 0), 0);
    const wScr = rows.reduce((s, r) => s + (r.cnt || 0) * (r.scr || 0), 0);
    if (!assocMap[name]) {
      // QA-only associate: manager from D_QA[m]
      assocMap[name] = { name, manager: rows[0].m, act: 0, tgt: 0, qaCnt: 0, qaScr: 0 };
    }
    assocMap[name].qaCnt += cnt;
    assocMap[name].qaScr += wScr;
  });

  return Object.values(assocMap).map(r => ({
    ...r,
    variance: r.act - r.tgt,
    prodPct:  r.tgt > 0 ? r.act / r.tgt : 0,
    avgQA:    r.qaCnt > 0 ? r.qaScr / r.qaCnt : null,
  }));
}

/* ── Weekly trend data ──────────────────────────────────────── */
function computeWeeklyTrend(prodRows) {
  const byYMW = {};
  prodRows.forEach(r => {
    const key = `${r.ym}|${r.w}`;
    if (!byYMW[key]) byYMW[key] = { label: `${r.ym} ${r.w}`, ym: r.ym, w: r.w, act: 0, tgt: 0 };
    byYMW[key].act += r.act || 0;
    byYMW[key].tgt += r.tgt || 0;
  });
  return Object.values(byYMW).sort((a, b) => {
    if (a.ym !== b.ym) return a.ym < b.ym ? -1 : 1;
    return a.w < b.w ? -1 : 1;
  });
}

/* ── QA Overview data ───────────────────────────────────────── */
function computeQAOverview(qaRows) {
  const byMonth = {};
  qaRows.forEach(r => {
    const m = r.d ? r.d.substring(0, 7) : 'Unknown';
    if (!byMonth[m]) byMonth[m] = { label: m, cnt: 0, wScr: 0 };
    byMonth[m].cnt  += r.cnt || 0;
    byMonth[m].wScr += (r.cnt || 0) * (r.scr || 0);
  });
  return Object.values(byMonth)
    .sort((a, b) => a.label < b.label ? -1 : 1)
    .map(m => ({ ...m, avgScr: m.cnt > 0 ? m.wScr / m.cnt : 0 }));
}

/* ── Chart.js defaults ──────────────────────────────────────── */
Chart.defaults.color       = '#5A5470';
Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
Chart.defaults.font.size   = 11;
Chart.defaults.plugins.legend.display = false;

function destroyChart(ref) { if (ref) { try { ref.destroy(); } catch(e) {} } }

function renderTrendChart(weeklyData) {
  const canvas = document.getElementById('chart-trend');
  if (!canvas) return null;
  const ctx    = canvas.getContext('2d');
  const MAX    = 24;
  const from   = Math.max(0, weeklyData.length - MAX);
  const labels = weeklyData.slice(from).map(d => d.label.replace(/\d{4}-/, '').replace('Week ', 'W'));
  const acts   = weeklyData.slice(from).map(d => Math.round(d.act * 10) / 10);
  const tgts   = weeklyData.slice(from).map(d => Math.round(d.tgt * 10) / 10);

  // Reuse existing instance — update data without full destroy/recreate
  if (trendChart) {
    trendChart.data.labels        = labels;
    trendChart.data.datasets[0].data = acts;
    trendChart.data.datasets[1].data = tgts;
    trendChart.update('none');
    return trendChart;
  }

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Actual', data: acts, borderColor: '#44B8F3', backgroundColor: 'rgba(68,184,243,0.12)', borderWidth: 2.5, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: '#44B8F3', tension: 0.35, fill: true, order: 2 },
        { label: 'Target', data: tgts, borderColor: '#794CFF', backgroundColor: 'transparent', borderWidth: 2, borderDash: [5, 3], pointRadius: 2, pointHoverRadius: 5, pointBackgroundColor: '#794CFF', tension: 0.35, fill: false, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: { backgroundColor: '#FFFFFF', borderColor: '#5009B5', borderWidth: 1, titleColor: '#231E33', bodyColor: '#231E33', padding: 12, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt.num(ctx.parsed.y)}` } },
        legend: { display: false },
      },
      scales: {
        x: { grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#5A5470', maxRotation: 45, maxTicksLimit: 12, font: { size: 10 } } },
        y: { grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#5A5470', font: { size: 10 } }, beginAtZero: false },
      },
    },
  });
}

function renderQAChart(qaMonthData) {
  const canvas = document.getElementById('chart-qa');
  if (!canvas) return null;
  const ctx    = canvas.getContext('2d');
  const labels = qaMonthData.map(d => d.label.replace(/^\d{4}-/, ''));
  const cnts   = qaMonthData.map(d => Math.round(d.cnt));
  const scrs   = qaMonthData.map(d => Math.round(d.avgScr * 1000) / 10);

  // Per-bar color: teal = PASS (≥98.5%), red = FAIL
  const QA_PCT = QA_PASS * 100; // 98.5
  const barColors = scrs.map(s => s >= QA_PCT ? 'rgba(0,188,187,0.70)' : 'rgba(248,113,113,0.70)');
  const barBorders = scrs.map(s => s >= QA_PCT ? '#00BBBA' : '#FA8072');

  // Reuse existing instance — only update data + colors
  if (qaChart) {
    qaChart.data.labels            = labels;
    qaChart.data.datasets[0].data  = cnts;
    qaChart.data.datasets[1].data  = scrs;
    qaChart.data.datasets[1].borderColor       = scrs.length === 1 ? barBorders[0] : scrs.map(s => s >= QA_PCT ? '#00BBBA' : '#FA8072');
    qaChart.data.datasets[1].backgroundColor   = scrs.map(s => s >= QA_PCT ? 'rgba(0,188,187,0.15)' : 'rgba(248,113,113,0.15)');
    qaChart.data.datasets[1].pointBackgroundColor = scrs.map(s => s >= QA_PCT ? '#00BBBA' : '#FA8072');
    qaChart.update('none');
    return qaChart;
  }

  // Threshold line plugin — draws a dashed horizontal rule at 98.5%
  const thresholdPlugin = {
    id: 'qaThreshold',
    afterDraw(chart) {
      const { ctx: c, chartArea: { left, right }, scales: { yScore } } = chart;
      if (!yScore) return;
      const y = yScore.getPixelForValue(QA_PCT);
      c.save();
      c.setLineDash([5, 4]);
      c.lineWidth   = 1.5;
      c.strokeStyle = 'rgba(248,113,113,0.75)';
      c.beginPath();
      c.moveTo(left,  y);
      c.lineTo(right, y);
      c.stroke();
      c.setLineDash([]);
      // Label
      c.font      = '600 9px Inter, sans-serif';
      c.fillStyle = '#FA8072';
      c.textAlign = 'right';
      c.fillText('98.5% threshold', right - 4, y - 4);
      c.restore();
    },
  };

  return new Chart(ctx, {
    type: 'bar',
    plugins: [thresholdPlugin],
    data: {
      labels,
      datasets: [
        {
          label: 'Audit Count',
          data: cnts,
          backgroundColor: 'rgba(68,184,243,0.5)',
          borderColor: '#44B8F3',
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: 'yCount',
          order: 2,
        },
        {
          label: 'Avg Score %',
          data: scrs,
          type: 'line',
          // Color each point: pass=teal, fail=red
          borderColor: scrs.length === 1
            ? barBorders[0]
            : scrs.map(s => s >= QA_PCT ? '#00BBBA' : '#FA8072'),
          backgroundColor: scrs.map(s => s >= QA_PCT ? 'rgba(0,188,187,0.15)' : 'rgba(248,113,113,0.15)'),
          segment: {
            borderColor: ctx => {
              const s = scrs[ctx.p1DataIndex];
              return s >= QA_PCT ? '#00BBBA' : '#FA8072';
            },
          },
          pointBackgroundColor: scrs.map(s => s >= QA_PCT ? '#00BBBA' : '#FA8072'),
          pointBorderColor: '#231E33',
          pointBorderWidth: 1,
          borderWidth: 2.5,
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.35,
          yAxisID: 'yScore',
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          backgroundColor: '#FFFFFF',
          borderColor: '#5009B5',
          borderWidth: 1,
          titleColor: '#231E33',
          bodyColor: '#231E33',
          padding: 12,
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label === 'Avg Score %') {
                const s = ctx.parsed.y;
                const status = s >= QA_PCT ? '✓ PASS' : '✗ FAIL';
                return ` Score: ${s.toFixed(1)}%  ${status}`;
              }
              return ` Audits: ${fmt.num(ctx.parsed.y)}`;
            },
          },
        },
        legend: { display: false },
      },
      scales: {
        x: { grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#5A5470', font: { size: 10 } } },
        yCount: { position: 'left', grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#44B8F3', font: { size: 10 } }, beginAtZero: true },
        yScore: {
          position: 'right',
          min: 85,
          max: 105,
          grid: { display: false },
          ticks: { color: '#00BBBA', font: { size: 10 }, callback: v => v + '%' },
        },
      },
    },
  });
}

/* ── Table rendering ────────────────────────────────────────── */
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sortAssocs(rows, col, dir) {
  return [...rows].sort((a, b) => {
    let av = a[col] ?? -Infinity;
    let bv = b[col] ?? -Infinity;
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 :  1;
    if (av > bv) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

function renderTable(assocRows) {
  const tbody = document.getElementById('assoc-tbody');
  const meta  = document.getElementById('table-meta');
  if (!tbody) return;

  const sorted = sortAssocs(assocRows, STATE.sortCol, STATE.sortDir);
  if (meta) meta.textContent = sorted.length + ' associates';

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="orbit-empty"><div class="orbit-empty__title">No data for current filters</div><div class="orbit-empty__desc">Try a different month or manager.</div></div></td></tr>`;
    return;
  }

  const maxPct = Math.max(...sorted.map(r => r.prodPct || 0), 0.01);
  const rows = sorted.map((r, i) => {
    const pct      = r.prodPct || 0;
    const barW     = clamp(Math.round((pct / Math.max(maxPct, 1.2)) * 100), 0, 100);
    const barClass = pct >= 1.0 ? 'is-above' : pct < 0.9 ? 'is-below' : '';
    const varClass = r.variance >= 0 ? 'is-positive' : 'is-negative';
    const qaScore  = r.avgQA;
    const qaSt     = qaStatus(qaScore);   // 'pass' | 'fail' | null
    const qaClass  = qaSt === 'pass' ? 'is-pass' : qaSt === 'fail' ? 'is-fail' : '';
    const qaStr    = qaScore != null ? fmt.pct(qaScore) : '—';
    // Badge: dot + label, tooltip shows threshold
    const qaBadge  = qaSt != null
      ? `<span class="qa-badge qa-badge--${qaSt}" title="PI QA threshold: 98.50%">${qaSt === 'pass' ? '● PASS' : '● FAIL'}</span>`
      : '';

    return `<tr>
      <td class="col-rank">${i + 1}</td>
      <td class="col-associate">${escHtml(r.name)}</td>
      <td class="col-manager">${escHtml(r.manager)}</td>
      <td class="col-num">${fmt.num(r.act)}</td>
      <td class="col-num">${fmt.num(r.tgt)}</td>
      <td class="col-variance ${varClass}">${fmt.sign(r.variance)}</td>
      <td class="col-pct">
        <div class="pct-cell">
          <span class="pct-cell__value">${fmt.pct(pct)}</span>
          <div class="pct-cell__bar-track">
            <div class="pct-cell__bar-fill ${barClass}" style="width:${barW}%"></div>
          </div>
        </div>
      </td>
      <td class="col-num">${r.qaCnt > 0 ? fmt.num(r.qaCnt) : '—'}</td>
      <td class="col-qa-score ${qaClass}">
        <div class="qa-score-cell">
          <span class="qa-score-cell__value">${qaStr}</span>
          ${qaBadge}
        </div>
      </td>
    </tr>`;
  });
  tbody.innerHTML = rows.join('');
}

/* ── KPI cards ──────────────────────────────────────────────── */
function renderKPIs(kpis) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('kpi-actual',   fmt.num(kpis.totalAct));
  set('kpi-target',   fmt.num(kpis.totalTgt));
  set('kpi-pct',      fmt.pct(kpis.prodPct));
  set('kpi-qa-score', kpis.avgQA > 0 ? fmt.pct(kpis.avgQA) : '—');
  set('kpi-qa-count', fmt.num(kpis.totalCnt));
  set('kpi-audited',  fmt.num(kpis.audited));

  const pctEl = document.getElementById('kpi-pct-sub');
  if (pctEl) {
    const delta = kpis.prodPct - 1.0;
    pctEl.className = delta >= 0 ? 'kpi-sub kpi-sub--up' : 'kpi-sub kpi-sub--down';
    pctEl.textContent = (delta >= 0 ? '+' : '') + (delta * 100).toFixed(1) + '% vs target';
  }

  // ── QA Score KPI card: strict 98.50% PI threshold ──────────
  const qaValEl = document.getElementById('kpi-qa-score');
  const qaEl    = document.getElementById('kpi-qa-score-sub');
  const qaCard  = document.querySelector('.kpi-card--qa-score');
  if (kpis.avgQA > 0) {
    const st = qaStatus(kpis.avgQA);
    // Value color driven by pass/fail
    if (qaValEl) {
      qaValEl.classList.remove('qa-kpi-pass', 'qa-kpi-fail');
      qaValEl.classList.add(st === 'pass' ? 'qa-kpi-pass' : 'qa-kpi-fail');
    }
    // Sub-text: PASS / FAILED
    if (qaEl) {
      if (st === 'pass') {
        qaEl.className = 'kpi-sub kpi-sub--up';
        qaEl.textContent = 'PASS — above 98.50%';
      } else {
        qaEl.className = 'kpi-sub kpi-sub--down';
        qaEl.textContent = 'FAILED — below 98.50%';
      }
    }
    // Card accent stripe
    if (qaCard) {
      qaCard.classList.remove('kpi-card--qa-pass', 'kpi-card--qa-fail');
      qaCard.classList.add(st === 'pass' ? 'kpi-card--qa-pass' : 'kpi-card--qa-fail');
    }
  } else {
    // No QA data
    if (qaValEl) qaValEl.classList.remove('qa-kpi-pass', 'qa-kpi-fail');
    if (qaEl) { qaEl.className = 'kpi-sub'; qaEl.textContent = 'No audit data'; }
    if (qaCard) qaCard.classList.remove('kpi-card--qa-pass', 'kpi-card--qa-fail');
  }

  // Enterprise KPIs now live in Leadership Portal — rendered by renderEnterpriseKPIs()
}

/* ── Enterprise Target & Variance (Leadership Portal only) ──────────────────
   Called from the Overview refresh path AND from LP.renderAll() so the cards
   always stay current whichever tab triggered the STATE.month change.
   Cards live exclusively in the LP Summary KPI strip — never on Overview.    */
function renderEnterpriseKPIs() {
  const entEl   = document.getElementById('kpi-ent-target');
  const entSub  = document.getElementById('kpi-ent-target-sub');
  const entVEl  = document.getElementById('kpi-ent-variance');
  const entVSub = document.getElementById('kpi-ent-variance-sub');
  if (!entEl && !entVEl) return;   // LP not in DOM yet — skip silently

  // These cards are month-scoped ONLY.
  // Manager/Associate filters have NO effect — ENT.compute reads STATE.month directly.
  const ent = ENT.compute(STATE.month);   // null when STATE.month === 'all'

  if (entEl)  entEl.textContent  = ent ? fmt.num(ent.target) : '—';
  if (entSub) {
    entSub.textContent = ent
      ? `${ENT.RATE} × ${ENT.HEADCOUNT} hc × ${ent.bizDays} days`
      : 'Select a single month';
    entSub.className = 'kpi-sub';
  }

  if (entVEl) {
    if (!ent) {
      entVEl.textContent = '—';
    } else {
      // Full-month total across ALL managers — true enterprise view, ignores manager filter.
      const allMonthProd = D_PROD.filter(r => r.ym === STATE.month);
      const totalActFull = allMonthProd.reduce((s, r) => s + (r.act || 0), 0);
      const variance     = Math.round((totalActFull - ent.target) * 100) / 100;
      entVEl.textContent = fmt.sign(variance);
      if (entVSub) {
        entVSub.className   = variance >= 0 ? 'kpi-sub kpi-sub--up' : 'kpi-sub kpi-sub--down';
        entVSub.textContent = variance >= 0 ? 'Above enterprise target' : 'Below enterprise target';
      }
    }
  }
  if (entVSub && !ent) {
    entVSub.textContent = 'Select a single month';
    entVSub.className   = 'kpi-sub';
  }
}

/* ── Period badge ───────────────────────────────────────────── */
function updatePeriodBadge() {
  const mgrText = STATE.manager === 'all' ? 'All Managers' : STATE.manager;
  const monText = STATE.month   === 'all' ? 'All Months'   : STATE.month;
  document.querySelectorAll('.chart-period-badge').forEach(el => {
    el.textContent = `${monText} · ${mgrText}`;
  });
}

/* ── Month pills ────────────────────────────────────────────── */
function buildMonthPills() {
  const container = document.getElementById('month-pills');
  if (!container) return;
  const months = uniqueSorted(D_PROD, 'ym');

  const allPill = document.createElement('button');
  allPill.className = 'orbit-pill is-active';
  allPill.textContent = 'All';
  allPill.dataset.month = 'all';
  allPill.addEventListener('click', () => setMonth('all'));
  container.appendChild(allPill);

  months.forEach(m => {
    const pill = document.createElement('button');
    pill.className = 'orbit-pill';
    const [yr, mo] = m.split('-');
    pill.textContent = new Date(parseInt(yr), parseInt(mo) - 1, 1)
      .toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    pill.dataset.month = m;
    pill.addEventListener('click', () => setMonth(m));
    container.appendChild(pill);
  });
}

function setMonth(m) {
  STATE.month = m;
  document.querySelectorAll('.orbit-pill').forEach(p => {
    p.classList.toggle('is-active', p.dataset.month === m);
  });
  refresh();
}

/* ── Manager dropdown ───────────────────────────────────────── */
// D_MANAGERS = union of all managers from D_PROD and D_QA (period-aware).
// Selecting a manager filters rows where D_PROD[m] or D_QA[m] === that manager.
function buildManagerSelect() {
  const sel = document.getElementById('manager-select');
  if (!sel) return;

  sel.innerHTML = '<option value="all">All Managers</option>';
  D_MANAGERS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });

  sel.addEventListener('change', () => {
    STATE.manager = sel.value;
    refresh();
  });
}

/* ── Sort ───────────────────────────────────────────────────── */
function initSortHeaders() {
  document.querySelectorAll('[data-sort]').forEach(th => {
    th.classList.add('is-sortable');
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      STATE.sortDir = STATE.sortCol === col
        ? (STATE.sortDir === 'asc' ? 'desc' : 'asc')
        : 'desc';
      STATE.sortCol = col;
      updateSortUI();
      const prod = filterProd(STATE.month, STATE.manager);
      const qa   = filterQA(STATE.month, STATE.manager);
      renderTable(computeAssocTable(prod, qa));
    });
  });
}

function updateSortUI() {
  document.querySelectorAll('[data-sort]').forEach(th => {
    th.classList.remove('is-sorted-asc', 'is-sorted-desc', 'is-sortable');
    if (th.dataset.sort === STATE.sortCol) {
      th.classList.add(STATE.sortDir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
    } else {
      th.classList.add('is-sortable');
    }
  });
}

/* ── Table search ───────────────────────────────────────────── */
function initTableSearch() {
  const inp = document.getElementById('table-search');
  if (!inp) return;
  let tsTimer;
  inp.addEventListener('input', () => {
    clearTimeout(tsTimer);
    tsTimer = setTimeout(() => {
      const q = inp.value.toLowerCase().trim();
      document.querySelectorAll('#assoc-tbody tr').forEach(tr => {
        tr.style.display = q === '' || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }, 140);
  });
}

/* ── Main refresh ───────────────────────────────────────────── */
function refresh() {
  const prod     = filterProd(STATE.month, STATE.manager);
  const qa       = filterQA(STATE.month, STATE.manager);
  const kpis     = computeKPIs(prod, qa);
  const assocs   = computeAssocTable(prod, qa);
  const weekly   = computeWeeklyTrend(prod);
  const qaMonths = computeQAOverview(qa);

  renderKPIs(kpis);
  renderEnterpriseKPIs();   // Enterprise cards live in LP Summary — keep them current on every refresh
  renderTable(assocs);
  updatePeriodBadge();
  trendChart = renderTrendChart(weekly);
  qaChart    = renderQAChart(qaMonths);

  const ts = document.getElementById('last-updated');
  if (ts) ts.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/* ── Init ───────────────────────────────────────────────────── */
function init() {
  buildMonthPills();
  buildManagerSelect();
  initSortHeaders();
  initTableSearch();
  updateSortUI();
  refresh();

  const loader = document.getElementById('orbit-loading');
  if (loader) { loader.classList.add('is-hidden'); setTimeout(() => loader.remove(), 500); }
}

document.addEventListener('DOMContentLoaded', init);

/* ── Global page-tab router with lazy-init support ──────────
   Replaces the stub inside the DD closure.
   Each page can register a one-time firstRender callback that
   fires the first time that tab is activated.  LP also calls
   this so the Leadership tab activation triggers renderAll.   */
const PAGE_NAV = (() => {
  const firstRender = {};   // pageId → callback run once on first open
  let ready = false;

  function register(pageId, cb) { firstRender[pageId] = cb; }

  function activate(target, opts = {}) {
    document.querySelectorAll('.orbit-page-tab').forEach(t => {
      t.classList.toggle('is-active', t.dataset.page === target);
      t.setAttribute('aria-selected', t.dataset.page === target ? 'true' : 'false');
    });
    document.querySelectorAll('.orbit-page').forEach(p => {
      p.classList.toggle('is-hidden', p.id !== 'page-' + target);
    });
    if (firstRender[target]) {
      firstRender[target]();
      delete firstRender[target];   // run only once
    }
  }

  function init() {
    if (ready) return;
    ready = true;
    document.querySelectorAll('.orbit-page-tab').forEach(tab => {
      tab.addEventListener('click', () => activate(tab.dataset.page));
    });
  }

  return { init, register, activate };
})();

document.addEventListener('DOMContentLoaded', PAGE_NAV.init);


/* ============================================================
   DAILY DETAIL PAGE — DD namespace
   Displays one row per D_PROD record (day-level grain).
   Fields: Date (ym+week), Associate, Manager, Actual, Target,
           Variance, Week, Month.
   Filters: Timeline (month pills), Manager, Associate, Search.
   Features: sortable columns, CSV export.
   ============================================================ */

const DD = (() => {
  /* ── Local state ── */
  const DD_PAGE = 200;   // rows per page — keeps DOM node count manageable
  let ddPage = 1;        // current page (accumulating — "load more" pattern)

  const S = {
    month:   'all',
    manager: 'all',
    assoc:   'all',
    date:    '',       // exact calendar date filter — 'YYYY-MM-DD' or '' for all
    search:  '',
    sortCol: 'd',      // default: most-recent calendar date first
    sortDir: 'desc',
  };

  /* ── Filter ── */
  // Convert YYYY-MM-DD (from <input type="date">) to the M/d/yyyy format stored in r.d
  function isoToMdY(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${+m}/${+d}/${y}`;   // strips leading zeros to match r.d exactly
  }

  function filteredRows() {
    const q        = S.search.toLowerCase().trim();
    const dateStr  = isoToMdY(S.date);   // '' when no date selected
    return D_PROD.filter(r => {
      if (S.month   !== 'all' && r.ym !== S.month)        return false;
      if (S.manager !== 'all' && r.m  !== S.manager)       return false;
      if (S.assoc   !== 'all' && r.a  !== S.assoc)         return false;
      if (dateStr   !== ''    && (r.d || '') !== dateStr)  return false;
      if (q) {
        const hay = ((r.a || '') + ' ' + (r.m || '') + ' ' + (r.ym || '') + ' ' + (r.w || '') + ' ' + (r.d || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /* ── Sort ── */
  // Parse M/d/yyyy date strings into a numeric timestamp for correct chronological sort
  function parseDd(s) {
    if (!s) return 0;
    const p = s.split('/');
    if (p.length !== 3) return 0;
    return new Date(+p[2], +p[0] - 1, +p[1]).getTime();
  }

  function sorted(rows) {
    return [...rows].sort((a, b) => {
      let av, bv;
      // 'd' sort: parse M/d/yyyy to a proper timestamp
      if (S.sortCol === 'd') {
        av = parseDd(a.d);
        bv = parseDd(b.d);
      } else if (S.sortCol === 'variance') {
        av = (a.act || 0) - (a.tgt || 0);
        bv = (b.act || 0) - (b.tgt || 0);
      } else {
        av = a[S.sortCol] ?? '';
        bv = b[S.sortCol] ?? '';
      }
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return S.sortDir === 'asc' ? -1 :  1;
      if (av > bv) return S.sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }

  /* ── Render table (paginated — DD_PAGE rows at a time) ── */
  function rowHtml(r) {
    const variance  = (r.act || 0) - (r.tgt || 0);
    const varClass  = variance >= 0 ? 'is-positive' : 'is-negative';
    // Display the specific calendar date (e.g. 9/1/2026); fall back to ym if d is absent
    const dateLabel = r.d ? escHtml(r.d) : (r.ym || '—');
    return `<tr>
      <td class="col-date">${dateLabel}</td>
      <td class="col-associate">${escHtml(r.a || '—')}</td>
      <td class="col-manager">${escHtml(r.m || '—')}</td>
      <td class="col-num">${fmt.num(r.act)}</td>
      <td class="col-num">${fmt.num(r.tgt)}</td>
      <td class="col-num ${varClass}">${fmt.sign(variance)}</td>
      <td class="col-num">${escHtml(r.w || '—')}</td>
      <td class="col-num">${escHtml(r.ym || '—')}</td>
    </tr>`;
  }

  function render() {
    ddPage = 1;   // filter/sort changes always reset to page 1
    renderPage();
  }

  function renderPage() {
    const tbody  = document.getElementById('dd-tbody');
    const meta   = document.getElementById('dd-meta');
    const moreEl = document.getElementById('dd-load-more');
    if (!tbody) return;

    const allRows  = sorted(filteredRows());
    const visible  = allRows.slice(0, ddPage * DD_PAGE);
    const hasMore  = visible.length < allRows.length;

    if (meta) meta.textContent = `${visible.length.toLocaleString()} of ${allRows.length.toLocaleString()} records`;

    if (allRows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="orbit-dd-empty">No records match the current filters.</div></td></tr>`;
      if (moreEl) moreEl.classList.add('is-hidden');
      updateSortHeaders();
      return;
    }

    tbody.innerHTML = visible.map(rowHtml).join('');
    if (moreEl) {
      moreEl.classList.toggle('is-hidden', !hasMore);
      if (hasMore) moreEl.textContent = `Load more (${(allRows.length - visible.length).toLocaleString()} remaining)`;
    }
    updateSortHeaders();
  }

  /* ── Sort header UI ── */
  function updateSortHeaders() {
    document.querySelectorAll('#dd-table [data-dd-sort]').forEach(th => {
      th.classList.remove('is-sorted-asc', 'is-sorted-desc');
      if (th.dataset.ddSort === S.sortCol) {
        th.classList.add(S.sortDir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
      }
    });
  }

  /* ── Build month pills (mirrors Overview pills) ── */
  function buildMonthPills() {
    const container = document.getElementById('dd-month-pills');
    if (!container) return;
    const months = uniqueSorted(D_PROD, 'ym');

    const allBtn = document.createElement('button');
    allBtn.className = 'orbit-pill' + (S.month === 'all' ? ' is-active' : '');
    allBtn.textContent = 'All';
    allBtn.dataset.month = 'all';
    container.appendChild(allBtn);

    months.forEach(ym => {
      const btn = document.createElement('button');
      btn.className = 'orbit-pill' + (S.month === ym ? ' is-active' : '');
      btn.textContent = ym;
      btn.dataset.month = ym;
      container.appendChild(btn);
    });

    container.addEventListener('click', e => {
      const btn = e.target.closest('[data-month]');
      if (!btn) return;
      S.month = btn.dataset.month;
      container.querySelectorAll('[data-month]').forEach(b => b.classList.toggle('is-active', b === btn));
      // Reset date-picker min/max when switching months; clears date if out of range
      const inp = document.getElementById('dd-date-input');
      if (inp) {
        if (S.month === 'all') { inp.min = ''; inp.max = ''; }
        else { syncDateToMonth(); }
      }
      rebuildAssocSelect();
      render();
    });
  }

  /* ── Build manager dropdown ── */
  function buildManagerSelect() {
    const sel = document.getElementById('dd-manager-select');
    if (!sel) return;
    sel.innerHTML = '<option value="all">All Managers</option>';
    D_MANAGERS.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      S.manager = sel.value;
      S.assoc   = 'all';
      rebuildAssocSelect();
      render();
    });
  }

  /* ── Build associate dropdown (responds to manager filter) ── */
  function buildAssocSelect() {
    rebuildAssocSelect();
    const sel = document.getElementById('dd-assoc-select');
    if (!sel) return;
    sel.addEventListener('change', () => {
      S.assoc = sel.value;
      render();
    });
  }

  function rebuildAssocSelect() {
    const sel = document.getElementById('dd-assoc-select');
    if (!sel) return;
    const prev = sel.value;
    const assocs = [...new Set(
      D_PROD
        .filter(r => (S.month === 'all' || r.ym === S.month) && (S.manager === 'all' || r.m === S.manager))
        .map(r => r.a)
        .filter(Boolean)
    )].sort();
    sel.innerHTML = '<option value="all">All Associates</option>';
    assocs.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      if (a === prev) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!assocs.includes(S.assoc)) S.assoc = 'all';
  }

  /* ── Date filter ── */
  function initDateFilter() {
    const inp   = document.getElementById('dd-date-input');
    const clear = document.getElementById('dd-date-clear');
    if (!inp) return;

    inp.addEventListener('change', () => {
      S.date = inp.value;   // 'YYYY-MM-DD' or '' if cleared natively
      if (clear) clear.classList.toggle('is-hidden', !S.date);
      render();
    });

    if (clear) {
      clear.addEventListener('click', () => {
        inp.value = '';
        S.date = '';
        clear.classList.add('is-hidden');
        render();
      });
    }
  }

  // Constrain or clear the date when the month pill changes
  function syncDateToMonth() {
    const inp   = document.getElementById('dd-date-input');
    const clear = document.getElementById('dd-date-clear');
    if (!inp || !S.date) return;

    if (S.month === 'all') {
      // "All" selected — date filter still valid, leave it
      return;
    }
    // If selected date is outside the chosen month, clear it
    const [y, m] = S.month.split('-');
    const [dy, dm] = S.date.split('-');
    if (dy !== y || dm !== m) {
      inp.value = '';
      S.date = '';
      if (clear) clear.classList.add('is-hidden');
    }
    // Set min/max on the input to constrain the date-picker to the selected month
    const firstDay = `${y}-${m}-01`;
    const lastDay  = new Date(+y, +m, 0);   // day 0 of next month = last day of this month
    const lastStr  = `${y}-${m}-${String(lastDay.getDate()).padStart(2, '0')}`;
    inp.min = firstDay;
    inp.max = lastStr;
  }

  /* ── Search input ── */
  function initSearch() {
    const inp = document.getElementById('dd-search');
    if (!inp) return;
    let ddTimer;
    inp.addEventListener('input', () => {
      clearTimeout(ddTimer);
      ddTimer = setTimeout(() => { S.search = inp.value; render(); }, 220);
    });
  }

  /* ── Column sort ── */
  function initSortHeaders() {
    document.querySelectorAll('#dd-table [data-dd-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.ddSort;
        if (S.sortCol === col) {
          S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          S.sortCol = col;
          S.sortDir = col === 'a' || col === 'm' ? 'asc' : 'desc';
        }
        render();
      });
    });
  }

  /* ── CSV export ── */
  function initExport() {
    const btn = document.getElementById('dd-export-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const rows = sorted(filteredRows());
      const header = ['Date','Associate','Manager','Actual','Target','Variance','Week','Month'];
      const lines  = rows.map(r => {
        const v = (r.act || 0) - (r.tgt || 0);
        return [
          `"${r.ym} ${r.w}"`,
          `"${(r.a || '').replace(/"/g, '""')}"`,
          `"${(r.m || '').replace(/"/g, '""')}"`,
          r.act || 0,
          r.tgt || 0,
          v,
          `"${r.w || ''}"`,
          `"${r.ym || ''}"`,
        ].join(',');
      });
      const csv  = [header.join(','), ...lines].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `ORBIT_Daily_Detail_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  /* ── Page-tab switching ── */
  /* NOTE: initPageNav is now defined at module scope below so it can
     register lazy-init callbacks for DD and MP. This stub is kept
     empty so the DD closure doesn't break existing call-sites. */
  function initPageNav() { /* wired by globalInitPageNav() below */ }

  /* ── Load more button ── */
  function initLoadMore() {
    const btn = document.getElementById('dd-load-more');
    if (!btn) return;
    btn.addEventListener('click', () => { ddPage++; renderPage(); });
  }

  /* ── Init ── */
  function init() {
    buildMonthPills();
    buildManagerSelect();
    buildAssocSelect();
    initDateFilter();
    initSearch();
    initSortHeaders();
    initLoadMore();
    // render() is deferred — called on first activation of #page-daily
  }

  return { init, render };
})();

/* ── Attach DD init to DOMContentLoaded alongside main init ── */
document.addEventListener('DOMContentLoaded', () => {
  DD.init();
  // Register lazy first-render: DD table is built only when Daily Detail tab first opens
  PAGE_NAV.register('daily', () => DD.render());
});


/* ============================================================
   MONTHLY PERFORMANCE PAGE — MP namespace
   Aggregates D_PROD + D_QA by associate × month.
   Business rules:
     Prod PASS  : prodPct >= 1.00  (100%)
     QA   PASS  : avgQA  >= 0.985  (98.50%)
   ============================================================ */

const MP = (() => {

  /* ── Local state ─────────────────────────────────────────── */
  const S = {
    month:   'all',
    manager: 'all',
    assoc:   'all',
    sortCol: 'ym',
    sortDir: 'desc',
  };

  let mpProdChart = null;
  let mpQAChart   = null;
  let mpDistChart = null;

  /* ── Month label formatter ─── */
  function fmtYM(ym) {
    if (!ym) return '—';
    const [yr, mo] = ym.split('-').map(Number);
    const label = new Date(yr, mo - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
    return label; // e.g. "Jul 2026"
  }

  /* ── Core computation ────────────────────────────────────── */
  // Returns one row per (associate × month): { a, m, ym, act, tgt, prodPct, avgQA }
  function computeRows() {
    const prodRows = D_PROD.filter(r =>
      (S.month   === 'all' || r.ym === S.month) &&
      (S.manager === 'all' || r.m  === S.manager) &&
      (S.assoc   === 'all' || r.a  === S.assoc)
    );
    const qaRows = D_QA.filter(r =>
      (S.month   === 'all' || r.d.startsWith(S.month)) &&
      (S.manager === 'all' || r.m  === S.manager)
    );

    // Aggregate prod by associate + month
    const prodMap = {};
    prodRows.forEach(r => {
      if (!r.a) return;
      const key = r.a + '|' + r.ym;
      if (!prodMap[key]) {
        const latestMgr = r.m;
        prodMap[key] = { a: r.a, m: latestMgr, ym: r.ym, act: 0, tgt: 0 };
      }
      prodMap[key].act += r.act || 0;
      prodMap[key].tgt += r.tgt || 0;
    });

    // Aggregate QA by associate + month (resolve name via idToName)
    const qaMap = {};
    qaRows.forEach(r => {
      const name = idToName[r.id] || r.a || r.id;
      if (!name) return;
      // Filter by assoc after name resolution
      if (S.assoc !== 'all' && name !== S.assoc) return;
      const ym = r.d ? r.d.substring(0, 7) : null;
      if (!ym) return;
      const key = name + '|' + ym;
      if (!qaMap[key]) qaMap[key] = { a: name, m: r.m, ym, cnt: 0, wScr: 0 };
      qaMap[key].cnt  += r.cnt || 0;
      qaMap[key].wScr += (r.cnt || 0) * (r.scr || 0);
    });

    // Merge into final rows keyed by assoc|ym
    const merged = { ...prodMap };
    Object.entries(qaMap).forEach(([key, q]) => {
      if (!merged[key]) merged[key] = { a: q.a, m: q.m, ym: q.ym, act: 0, tgt: 0 };
      merged[key].qaCnt = (merged[key].qaCnt || 0) + q.cnt;
      merged[key].qaScr = (merged[key].qaScr || 0) + q.wScr;
    });

    return Object.values(merged).map(r => ({
      ...r,
      prodPct: r.tgt > 0 ? r.act / r.tgt : null,
      avgQA:   (r.qaCnt > 0) ? r.qaScr / r.qaCnt : null,
    }));
  }

  /* ── Compute month-level aggregates (for trend charts) ────── */
  function computeMonthTrend(rows) {
    const byYM = {};
    rows.forEach(r => {
      if (!byYM[r.ym]) byYM[r.ym] = { ym: r.ym, act: 0, tgt: 0, qaCnt: 0, qaScr: 0 };
      byYM[r.ym].act   += r.act || 0;
      byYM[r.ym].tgt   += r.tgt || 0;
      byYM[r.ym].qaCnt += r.qaCnt || 0;
      byYM[r.ym].qaScr += r.qaScr || 0;
    });
    return Object.values(byYM)
      .sort((a, b) => a.ym < b.ym ? -1 : 1)
      .map(r => ({
        ...r,
        prodPct: r.tgt > 0 ? r.act / r.tgt : null,
        avgQA:   r.qaCnt > 0 ? r.qaScr / r.qaCnt : null,
      }));
  }

  /* ── KPI cards ───────────────────────────────────────────── */
  function renderKPIs(rows) {
    const withProd = rows.filter(r => r.prodPct != null);
    const passing  = withProd.filter(r => r.prodPct >= 1.0).length;
    const failing  = withProd.filter(r => r.prodPct < 1.0).length;

    const avgProd = withProd.length > 0
      ? withProd.reduce((s, r) => s + r.prodPct, 0) / withProd.length
      : null;

    const withQA  = rows.filter(r => r.avgQA != null);
    const totalQACnt = withQA.reduce((s, r) => s + (r.qaCnt || 0), 0);
    const totalQAScr = withQA.reduce((s, r) => s + (r.qaScr || 0), 0);
    const avgQA  = totalQACnt > 0 ? totalQAScr / totalQACnt : null;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('mp-kpi-passing', passing);
    set('mp-kpi-failing', failing);
    set('mp-kpi-avg-prod', avgProd != null ? fmt.pct(avgProd) : '—');
    set('mp-kpi-avg-qa',   avgQA   != null ? fmt.pct(avgQA)   : '—');

    // Prod sub-text
    const prodSubEl = document.getElementById('mp-kpi-avg-prod-sub');
    if (prodSubEl && avgProd != null) {
      const delta = avgProd - 1.0;
      prodSubEl.className = delta >= 0 ? 'kpi-sub kpi-sub--up' : 'kpi-sub kpi-sub--down';
      prodSubEl.textContent = (delta >= 0 ? '+' : '') + (delta * 100).toFixed(1) + '% vs target';
    }

    // QA sub-text + value color
    const qaValEl  = document.getElementById('mp-kpi-avg-qa');
    const qaSubEl  = document.getElementById('mp-kpi-avg-qa-sub');
    if (avgQA != null) {
      const st = qaStatus(avgQA);
      if (qaValEl) {
        qaValEl.classList.remove('qa-kpi-pass', 'qa-kpi-fail');
        qaValEl.classList.add(st === 'pass' ? 'qa-kpi-pass' : 'qa-kpi-fail');
      }
      if (qaSubEl) {
        qaSubEl.className = st === 'pass' ? 'kpi-sub kpi-sub--up' : 'kpi-sub kpi-sub--down';
        qaSubEl.textContent = st === 'pass' ? 'PASS — above 98.50%' : 'FAILED — below 98.50%';
      }
    }

    // ── QA Pass / Fail counts (PI 98.50% threshold) ────────────
    const qaPassCount = withQA.filter(r => r.avgQA >= QA_PASS).length;
    const qaFailCount = withQA.filter(r => r.avgQA <  QA_PASS).length;

    const qaPassEl = document.getElementById('mp-kpi-qa-pass');
    const qaFailEl = document.getElementById('mp-kpi-qa-fail');
    if (qaPassEl) {
      qaPassEl.textContent = qaPassCount;
      qaPassEl.classList.remove('qa-kpi-pass', 'qa-kpi-fail');
      if (withQA.length > 0) qaPassEl.classList.add('qa-kpi-pass');
    }
    if (qaFailEl) {
      qaFailEl.textContent = qaFailCount;
      qaFailEl.classList.remove('qa-kpi-pass', 'qa-kpi-fail');
      if (qaFailCount > 0) qaFailEl.classList.add('qa-kpi-fail');
    }
  }

  /* ── Productivity Trend chart ────────────────────────────── */
  function renderProdChart(monthRows) {
    const canvas = document.getElementById('mp-chart-prod');
    if (!canvas) return null;
    const ctx    = canvas.getContext('2d');
    const labels = monthRows.map(r => fmtYM(r.ym));
    const vals   = monthRows.map(r => r.prodPct != null ? +(r.prodPct * 100).toFixed(2) : null);

    // Per-point colors
    const ptColors  = vals.map(v => v == null ? 'transparent' : v >= 100 ? '#00BBBA' : '#FA8072');
    const segColors = vals.map(v => v == null ? 'rgba(0,0,0,0)' : v >= 100 ? '#00BBBA' : '#FA8072');

    // Reuse existing instance
    if (mpProdChart) {
      mpProdChart.data.labels            = labels;
      mpProdChart.data.datasets[0].data  = vals;
      mpProdChart.data.datasets[0].pointBackgroundColor = ptColors;
      mpProdChart.data.datasets[0].pointBorderColor     = ptColors;
      mpProdChart.update('none');
      return mpProdChart;
    }

    // Threshold plugin: dashed line at 100%
    const threshPlugin = {
      id: 'mpProdThresh',
      afterDraw(chart) {
        const { ctx: c, chartArea: { left, right }, scales: { y } } = chart;
        if (!y) return;
        const yp = y.getPixelForValue(100);
        c.save();
        c.setLineDash([5, 4]);
        c.lineWidth = 1.5;
        c.strokeStyle = 'rgba(248,113,113,0.6)';
        c.beginPath(); c.moveTo(left, yp); c.lineTo(right, yp); c.stroke();
        c.setLineDash([]);
        c.font = '600 9px Inter, sans-serif';
        c.fillStyle = '#FA8072';
        c.textAlign = 'right';
        c.fillText('100% target', right - 4, yp - 4);
        c.restore();
      },
    };

    mpProdChart = new Chart(ctx, {
      type: 'line',
      plugins: [threshPlugin],
      data: {
        labels,
        datasets: [{
          label: 'Productivity %',
          data: vals,
          borderColor: ctx => {
            const v = vals[ctx.dataIndex];
            return v == null ? 'transparent' : v >= 100 ? '#00BBBA' : '#FA8072';
          },
          segment: {
            borderColor: ctx => {
              const v = vals[ctx.p1DataIndex];
              return v == null ? 'transparent' : v >= 100 ? '#00BBBA' : '#FA8072';
            },
          },
          backgroundColor: vals.map(v => v == null ? 'transparent' : v >= 100
            ? 'rgba(0,188,187,0.12)' : 'rgba(248,113,113,0.08)'),
          pointBackgroundColor: ptColors,
          pointBorderColor: '#231E33',
          pointBorderWidth: 1,
          pointRadius: vals.length === 1 ? 6 : 4,
          pointHoverRadius: 7,
          borderWidth: 2.5,
          tension: 0.35,
          fill: true,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#FFFFFF',
            borderColor: '#5009B5', borderWidth: 1,
            titleColor: '#231E33', bodyColor: '#231E33', padding: 12,
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                const st = v >= 100 ? '✓ PASS' : '✗ FAIL';
                return ` Productivity: ${v.toFixed(1)}%  ${st}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#5A5470', font: { size: 10 } } },
          y: {
            grid: { color: 'rgba(225,237,255,0.35)' },
            ticks: { color: '#5A5470', font: { size: 10 }, callback: v => v + '%' },
            beginAtZero: false,
          },
        },
      },
    });
    return mpProdChart;
  }

  /* ── QA Trend chart ──────────────────────────────────────── */
  function renderQATrendChart(monthRows) {
    const canvas = document.getElementById('mp-chart-qa');
    if (!canvas) return null;
    const ctx    = canvas.getContext('2d');
    const labels = monthRows.map(r => fmtYM(r.ym));
    const vals   = monthRows.map(r => r.avgQA != null ? +(r.avgQA * 100).toFixed(2) : null);
    const QA_PCT = QA_PASS * 100; // 98.5

    // Reuse existing instance
    if (mpQAChart) {
      const ptC = vals.map(v => v == null ? 'transparent' : v >= QA_PCT ? '#00BBBA' : '#FA8072');
      mpQAChart.data.labels            = labels;
      mpQAChart.data.datasets[0].data  = vals;
      mpQAChart.data.datasets[0].pointBackgroundColor = ptC;
      mpQAChart.data.datasets[0].pointBorderColor     = ptC;
      mpQAChart.update('none');
      return mpQAChart;
    }

    const threshPlugin = {
      id: 'mpQAThresh',
      afterDraw(chart) {
        const { ctx: c, chartArea: { left, right }, scales: { y } } = chart;
        if (!y) return;
        const yp = y.getPixelForValue(QA_PCT);
        c.save();
        c.setLineDash([5, 4]);
        c.lineWidth = 1.5;
        c.strokeStyle = 'rgba(248,113,113,0.6)';
        c.beginPath(); c.moveTo(left, yp); c.lineTo(right, yp); c.stroke();
        c.setLineDash([]);
        c.font = '600 9px Inter, sans-serif';
        c.fillStyle = '#FA8072';
        c.textAlign = 'right';
        c.fillText('98.5% threshold', right - 4, yp - 4);
        c.restore();
      },
    };

    mpQAChart = new Chart(ctx, {
      type: 'line',
      plugins: [threshPlugin],
      data: {
        labels,
        datasets: [{
          label: 'QA Score %',
          data: vals,
          segment: {
            borderColor: ctx => {
              const v = vals[ctx.p1DataIndex];
              return v == null ? 'transparent' : v >= QA_PCT ? '#00BBBA' : '#FA8072';
            },
          },
          backgroundColor: vals.map(v => v == null ? 'transparent' : v >= QA_PCT
            ? 'rgba(0,188,187,0.12)' : 'rgba(248,113,113,0.08)'),
          pointBackgroundColor: vals.map(v => v == null ? 'transparent' : v >= QA_PCT ? '#00BBBA' : '#FA8072'),
          pointBorderColor: '#231E33',
          pointBorderWidth: 1,
          pointRadius: vals.length === 1 ? 6 : 4,
          pointHoverRadius: 7,
          borderWidth: 2.5,
          tension: 0.35,
          fill: true,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#FFFFFF',
            borderColor: '#5009B5', borderWidth: 1,
            titleColor: '#231E33', bodyColor: '#231E33', padding: 12,
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                const st = v >= QA_PCT ? '✓ PASS' : '✗ FAIL';
                return ` QA Score: ${v.toFixed(1)}%  ${st}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { color: 'rgba(225,237,255,0.35)' }, ticks: { color: '#5A5470', font: { size: 10 } } },
          y: {
            min: 85, max: 105,
            grid: { color: 'rgba(225,237,255,0.35)' },
            ticks: { color: '#5A5470', font: { size: 10 }, callback: v => v + '%' },
          },
        },
      },
    });
    return mpQAChart;
  }

  /* ── Pass/Fail Distribution donut chart ──────────────────── */
  function renderDistChart(rows) {
    const canvas = document.getElementById('mp-chart-dist');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');

    const withProd = rows.filter(r => r.prodPct != null);
    const prodPass = withProd.filter(r => r.prodPct >= 1.0).length;
    const prodFail = withProd.filter(r => r.prodPct < 1.0).length;

    const withQA   = rows.filter(r => r.avgQA != null);
    const qaPass   = withQA.filter(r => r.avgQA >= QA_PASS).length;
    const qaFail   = withQA.filter(r => r.avgQA < QA_PASS).length;

    // Reuse existing instance
    if (mpDistChart) {
      mpDistChart.data.datasets[0].data = [prodPass, prodFail, qaPass, qaFail];
      mpDistChart.update('none');
      return mpDistChart;
    }

    mpDistChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Prod Pass', 'Prod Fail', 'QA Pass', 'QA Fail'],
        datasets: [{
          data: [prodPass, prodFail, qaPass, qaFail],
          backgroundColor: [
            'rgba(0,188,187,0.80)',
            'rgba(248,113,113,0.80)',
            'rgba(0,188,187,0.45)',
            'rgba(248,113,113,0.45)',
          ],
          borderColor: ['#00BBBA', '#FA8072', '#00BBBA', '#FA8072'],
          borderWidth: 1.5,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '55%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#5A5470', font: { size: 10 }, padding: 10, boxWidth: 12 },
          },
          tooltip: {
            backgroundColor: '#FFFFFF',
            borderColor: '#5009B5', borderWidth: 1,
            titleColor: '#231E33', bodyColor: '#231E33', padding: 12,
          },
        },
      },
    });
    return mpDistChart;
  }

  /* ── Associate Performance Grid ──────────────────────────── */
  function renderGrid(rows) {
    const thead = document.getElementById('mp-grid-thead');
    const tbody = document.getElementById('mp-grid-tbody');
    const meta  = document.getElementById('mp-grid-meta');
    if (!thead || !tbody) return;

    // Derive sorted months from rows
    const months = [...new Set(rows.map(r => r.ym))].filter(Boolean).sort();

    // Unique associates (sorted), respecting current filters
    const assocs = [...new Set(rows.map(r => r.a))].filter(Boolean).sort();

    if (meta) meta.textContent = assocs.length + ' associates';

    if (assocs.length === 0 || months.length === 0) {
      thead.innerHTML = `<tr><th>Associate</th><th>Manager</th></tr>`;
      tbody.innerHTML = `<tr><td colspan="2"><div class="orbit-dd-empty">No data for current filters.</div></td></tr>`;
      return;
    }

    // Index rows by assoc+ym for fast lookup
    const idx = {};
    rows.forEach(r => { idx[r.a + '|' + r.ym] = r; });

    // Most-recent manager per associate (for display)
    const mgr = {};
    rows.forEach(r => { if (!mgr[r.a] || r.ym > (mgr[r.a].ym || '')) mgr[r.a] = r; });

    // Header
    const thMonths = months.map(ym =>
      `<th class="mp-month-col">${fmtYM(ym)}</th>`).join('');
    thead.innerHTML = `<tr>
      <th class="col-associate">Associate</th>
      <th class="col-manager">Manager</th>
      ${thMonths}
    </tr>`;

    // Body
    tbody.innerHTML = assocs.map(name => {
      const manager = mgr[name] ? escHtml(mgr[name].m) : '—';
      const cells   = months.map(ym => {
        const r = idx[name + '|' + ym];
        if (!r) return `<td class="mp-month-col"><div class="mp-cell mp-cell--empty">—</div></td>`;

        const pp = r.prodPct;
        const qa = r.avgQA;

        const prodPctStr   = pp != null ? fmt.pct(pp) : '—';
        const prodPassFail = pp != null ? (pp >= 1.0 ? 'pass' : 'fail') : null;
        const qaStr        = qa != null ? fmt.pct(qa) : '—';
        const qaSt         = qaStatus(qa);

        const prodValClass   = prodPassFail ? `is-${prodPassFail}` : '';
        const prodBadgeClass = prodPassFail ? `is-${prodPassFail}` : '';
        const qaClass        = qaSt ? `is-${qaSt}` : '';

        const prodBadgeLabel = prodPassFail ? prodPassFail.toUpperCase() : '';

        return `<td class="mp-month-col">
          <div class="mp-cell">
            <span class="mp-cell__prod ${prodValClass}">${prodPctStr}</span>
            ${prodPassFail ? `<span class="mp-cell__prod-badge ${prodBadgeClass}">${prodBadgeLabel}</span>` : ''}
            ${qa != null ? `<span class="mp-cell__qa ${qaClass}" title="QA: ${qaStr}">${qaStr}</span>` : ''}
          </div>
        </td>`;
      }).join('');

      return `<tr>
        <td class="col-associate">${escHtml(name)}</td>
        <td class="col-manager">${manager}</td>
        ${cells}
      </tr>`;
    }).join('');
  }

  /* ── Monthly Detail Trend table ──────────────────────────── */
  const DT = { sortCol: 'ym', sortDir: 'desc' };

  function sortedRows(rows) {
    return [...rows].sort((a, b) => {
      let av = a[DT.sortCol], bv = b[DT.sortCol];
      if (av == null) av = DT.sortDir === 'asc' ? Infinity : -Infinity;
      if (bv == null) bv = DT.sortDir === 'asc' ? Infinity : -Infinity;
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return DT.sortDir === 'asc' ? -1 :  1;
      if (av > bv) return DT.sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }

  function updateDetailSortUI() {
    document.querySelectorAll('#mp-detail-table [data-mp-sort]').forEach(th => {
      th.classList.remove('is-sorted-asc', 'is-sorted-desc');
      if (th.dataset.mpSort === DT.sortCol) {
        th.classList.add(DT.sortDir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
      }
    });
  }

  function renderDetailTable(rows) {
    const tbody  = document.getElementById('mp-detail-tbody');
    const meta   = document.getElementById('mp-detail-meta');
    if (!tbody) return;

    const sorted = sortedRows(rows);
    if (meta) meta.textContent = sorted.length + ' rows';

    if (sorted.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="orbit-dd-empty">No data for current filters.</div></td></tr>`;
      updateDetailSortUI();
      return;
    }

    tbody.innerHTML = sorted.map(r => {
      const prodSt = r.prodPct != null ? (r.prodPct >= 1.0 ? 'pass' : 'fail') : null;
      const qaSt   = qaStatus(r.avgQA);

      const prodPill = prodSt
        ? `<span class="mp-status-pill is-${prodSt}">${prodSt.toUpperCase()}</span>`
        : `<span class="mp-status-pill is-na">—</span>`;
      const qaPill = qaSt
        ? `<span class="mp-status-pill is-${qaSt}">${qaSt.toUpperCase()}</span>`
        : `<span class="mp-status-pill is-na">—</span>`;

      const prodClass = r.prodPct != null ? (r.prodPct >= 1.0 ? 'is-positive' : 'is-negative') : '';
      const qaClass   = qaSt ? (qaSt === 'pass' ? 'is-pass' : 'is-fail') : '';

      return `<tr>
        <td class="col-num">${escHtml(fmtYM(r.ym))}</td>
        <td class="col-associate">${escHtml(r.a || '—')}</td>
        <td class="col-manager">${escHtml(r.m || '—')}</td>
        <td class="col-num">${fmt.num(r.act)}</td>
        <td class="col-num">${fmt.num(r.tgt)}</td>
        <td class="col-num ${prodClass}">${r.prodPct != null ? fmt.pct(r.prodPct) : '—'}</td>
        <td class="col-num ${qaClass}">${r.avgQA != null ? fmt.pct(r.avgQA) : '—'}</td>
        <td class="col-num">${prodPill}</td>
        <td class="col-num">${qaPill}</td>
      </tr>`;
    }).join('');

    updateDetailSortUI();
  }

  /* ── Detail table sort ───────────────────────────────────── */
  function initDetailSort(getRows) {
    document.querySelectorAll('#mp-detail-table [data-mp-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.mpSort;
        DT.sortDir = DT.sortCol === col ? (DT.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
        DT.sortCol = col;
        renderDetailTable(getRows());
      });
    });
  }

  /* ── Master render ───────────────────────────────────────── */
  function render() {
    const rows       = computeRows();
    const monthRows  = computeMonthTrend(rows);
    renderKPIs(rows);
    renderGrid(rows);
    renderDetailTable(rows);
    renderProdChart(monthRows);
    renderQATrendChart(monthRows);
    renderDistChart(rows);
  }

  /* ── Filter controls ─────────────────────────────────────── */
  function buildMonthPills() {
    const container = document.getElementById('mp-month-pills');
    if (!container) return;
    const months = uniqueSorted(D_PROD, 'ym');

    const mkBtn = (val, label) => {
      const b = document.createElement('button');
      b.className = 'orbit-pill' + (S.month === val ? ' is-active' : '');
      b.textContent = label;
      b.dataset.month = val;
      return b;
    };

    container.appendChild(mkBtn('all', 'All'));
    months.forEach(ym => container.appendChild(mkBtn(ym, ym)));

    container.addEventListener('click', e => {
      const btn = e.target.closest('[data-month]');
      if (!btn) return;
      S.month = btn.dataset.month;
      container.querySelectorAll('[data-month]').forEach(b =>
        b.classList.toggle('is-active', b === btn));
      rebuildAssocSelect();
      render();
    });
  }

  function buildManagerSelect() {
    const sel = document.getElementById('mp-manager-select');
    if (!sel) return;
    sel.innerHTML = '<option value="all">All Managers</option>';
    D_MANAGERS.forEach(m => {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      S.manager = sel.value;
      S.assoc   = 'all';
      rebuildAssocSelect();
      render();
    });
  }

  function buildAssocSelect() {
    rebuildAssocSelect();
    document.getElementById('mp-assoc-select')
      ?.addEventListener('change', e => { S.assoc = e.target.value; render(); });
  }

  function rebuildAssocSelect() {
    const sel = document.getElementById('mp-assoc-select');
    if (!sel) return;
    const prev = sel.value;
    const assocs = [...new Set(
      D_PROD
        .filter(r =>
          (S.month   === 'all' || r.ym === S.month) &&
          (S.manager === 'all' || r.m  === S.manager))
        .map(r => r.a).filter(Boolean)
    )].sort();
    sel.innerHTML = '<option value="all">All Associates</option>';
    assocs.forEach(a => {
      const o = document.createElement('option');
      o.value = a; o.textContent = a;
      if (a === prev) o.selected = true;
      sel.appendChild(o);
    });
    if (!assocs.includes(S.assoc)) S.assoc = 'all';
  }

  /* ── Export CSV ──────────────────────────────────────────── */
  function initExport(getRows) {
    document.getElementById('mp-export-btn')
      ?.addEventListener('click', () => {
        const rows = sortedRows(getRows());
        const hdr  = ['Month','Associate','Manager','Actual','Target','Prod %','QA Score %','Prod Status','QA Status'];
        const lines = rows.map(r => {
          const prodSt = r.prodPct != null ? (r.prodPct >= 1.0 ? 'PASS' : 'FAIL') : '—';
          const qaSt   = r.avgQA   != null ? (r.avgQA >= QA_PASS ? 'PASS' : 'FAIL') : '—';
          return [
            `"${fmtYM(r.ym)}"`,
            `"${(r.a||'').replace(/"/g,'""')}"`,
            `"${(r.m||'').replace(/"/g,'""')}"`,
            r.act || 0, r.tgt || 0,
            r.prodPct != null ? (r.prodPct*100).toFixed(2) : '',
            r.avgQA   != null ? (r.avgQA*100).toFixed(2)   : '',
            prodSt, qaSt,
          ].join(',');
        });
        const csv  = [hdr.join(','), ...lines].join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `ORBIT_Monthly_Performance_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      });
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    buildMonthPills();
    buildManagerSelect();
    buildAssocSelect();
    initDetailSort(() => computeRows());
    initExport(() => computeRows());
    // render() is deferred — called on first activation of #page-monthly
  }

  return { init, render };
})();

document.addEventListener('DOMContentLoaded', () => {
  MP.init();
  // Register lazy first-render: MP charts + grid built only when Monthly Performance tab first opens
  PAGE_NAV.register('monthly', () => MP.render());
});


/* ============================================================
   RICH TOOLTIP — ORBIT_TT namespace
   Power BI-style tooltip driven by data-tt-title / data-tt-body
   and dynamic data-tt keys ('ent', 'ent-var').
   Positions BELOW the host card; flips above if no room.
   ============================================================ */

const ORBIT_TT = (() => {
  let tipEl = null;

  function ensureEl() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'orbit-tooltip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  // Build HTML for dynamic Enterprise cards
  function dynamicHTML(key) {
    if (key === 'ent') {
      const res = ENT.compute(STATE.month);
      if (!res) {
        return `<div class="orbit-tooltip__title">Enterprise Target</div>
          <div class="orbit-tooltip__body">Select a single month in the Timeline to compute the enterprise target.<br><br>
          Formula: ${ENT.RATE} × ${ENT.HEADCOUNT} headcount × business days.</div>`;
      }
      return `<div class="orbit-tooltip__title">Enterprise Target</div>
        <div class="orbit-tooltip__row"><span>Daily Target / Associate</span><b>${ENT.RATE}</b></div>
        <div class="orbit-tooltip__row"><span>Billable Headcount</span><b>${ENT.HEADCOUNT}</b></div>
        <div class="orbit-tooltip__row"><span>Business Days (${STATE.month})</span><b>${res.bizDays}</b></div>
        <div class="orbit-tooltip__formula">
          ${ENT.RATE} × ${ENT.HEADCOUNT} × ${res.bizDays}
          <strong>Enterprise Target: ${fmt.num(res.target)}</strong>
        </div>`;
    }
    if (key === 'ent-var') {
      const res = ENT.compute(STATE.month);
      if (!res) {
        return `<div class="orbit-tooltip__title">Enterprise Variance</div>
          <div class="orbit-tooltip__body">Select a single month in the Timeline to compute variance vs the enterprise target.</div>`;
      }
      const totalAct = filterProd(STATE.month, 'all').reduce((s, r) => s + (r.act || 0), 0);
      const variance = totalAct - res.target;
      const dir      = variance >= 0 ? 'above' : 'below';
      return `<div class="orbit-tooltip__title">Enterprise Variance</div>
        <div class="orbit-tooltip__row"><span>Actual Production</span><b>${fmt.num(totalAct)}</b></div>
        <div class="orbit-tooltip__row"><span>Enterprise Target</span><b>${fmt.num(res.target)}</b></div>
        <div class="orbit-tooltip__formula">
          Actual − Enterprise Target
          <strong>${fmt.sign(variance)} units ${dir} target</strong>
        </div>`;
    }
    return '';
  }

  function show(host) {
    const el = ensureEl();
    const key = host.dataset.tt;
    if (key) {
      el.innerHTML = dynamicHTML(key);
    } else {
      const title = host.dataset.ttTitle || '';
      const body  = host.dataset.ttBody  || '';
      if (!title && !body) return;
      el.innerHTML =
        (title ? `<div class="orbit-tooltip__title">${title}</div>` : '') +
        (body  ? `<div class="orbit-tooltip__body">${body}</div>`   : '');
    }

    // Position below the card, horizontally centered on it
    const r  = host.getBoundingClientRect();
    el.style.visibility = 'hidden';
    el.classList.add('is-visible');
    const tw = el.offsetWidth, th = el.offsetHeight;
    el.style.visibility = '';

    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));

    let top = r.bottom + 10;
    if (top + th > window.innerHeight - 8) {
      top = Math.max(8, r.top - th - 10); // flip above card
    }

    el.style.left = left + 'px';
    el.style.top  = top + 'px';
  }

  function hide() {
    if (tipEl) tipEl.classList.remove('is-visible');
  }

  function init() {
    const sel = '[data-tt-title], [data-tt]';
    document.querySelectorAll(sel).forEach(el => {
      el.addEventListener('mouseenter', () => show(el));
      el.addEventListener('mouseleave', hide);
      el.addEventListener('focus', () => show(el));
      el.addEventListener('blur', hide);
      // Make card focusable for keyboard accessibility
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', ORBIT_TT.init);


/* ============================================================
   AUTHORIZATION — pluggable identity provider
   Phase 1 : domain entry validated against D_LEADERSHIP
             (generated from ORBIT_Leadership.xlsx — source of truth).
   Future  : replace identify() with Microsoft Entra ID / MSAL
             token claims or SharePoint group membership — the rest
             of the portal only ever calls AUTH.role() / AUTH.user().
   ============================================================ */
const AUTH = (() => {
  const STORE_KEY = 'orbit_auth_domain';

  // Returns the signed-in domain ID (uppercase), or ''.
  // FUTURE: return claims.preferred_username / onPremisesSamAccountName.
  function identify() {
    return (localStorage.getItem(STORE_KEY) || '').trim().toUpperCase();
  }

  function lookup(domain) {
    if (!domain || typeof D_LEADERSHIP === 'undefined') return null;
    const d = domain.trim().toUpperCase();
    return D_LEADERSHIP.find(r => (r.domain || '').toUpperCase() === d) || null;
  }

  function user() { return lookup(identify()); }
  function role() { const u = user(); return u ? u.role : null; }   // 'admin' | 'leadership' | null
  function canAccessPortal() { const r = role(); return r === 'admin' || r === 'leadership'; }

  function signIn(domain) {
    const u = lookup(domain);
    if (!u) return null;
    localStorage.setItem(STORE_KEY, u.domain.toUpperCase());
    return u;
  }
  function signOut() { localStorage.removeItem(STORE_KEY); }

  return { identify, lookup, user, role, canAccessPortal, signIn, signOut };
})();


/* ============================================================
   LEADERSHIP PORTAL — LP namespace
   Sections: PIP Watchlist · Recognition Watchlist · Notifications

   Business rules (per associate):
     PIP   : Productivity <100% OR QA <98.50% for 2 consecutive months
     RECOG : Productivity >=110% OR QA = 100.00% for 3 consecutive months
   "Consecutive" = the associate's most recent N months with data
   for that metric (months with no audits/production are skipped).
   ============================================================ */
const LP = (() => {

  /* ── BUSINESS RULES ────────────────────────────────────────
     Single place where every Leadership threshold lives.
     PASS thresholds are approved standards; RECOGNITION
     thresholds are PROVISIONAL pending a business decision.
     To change a rule, edit the `value` below — the watchlists,
     notifications, emails and the Business Rules table all
     read from this object. Nothing is hardcoded downstream. */
  const BUSINESS_RULES = [
    { key: 'PROD_PASS', label: 'Productivity PASS threshold', value: 1.00,
      format: 'pct', approved: true,
      note: 'Approved standard — FAIL below 100%' },
    { key: 'QA_PASS',   label: 'QA PASS threshold',           value: 0.985,
      format: 'pct', approved: true,
      note: 'Approved Payment Integrity standard — 98.50%' },
    { key: 'PIP_MONTHS', label: 'PIP consecutive months',     value: 2,
      format: 'int', approved: true,
      note: 'Consecutive failed months before PIP review' },
    { key: 'REC_PROD',  label: 'Recognition — Productivity',  value: 1.10,
      format: 'pct', approved: true,
      note: 'Productivity Excellence at ≥ 110% — approved standard' },
    { key: 'REC_QA',    label: 'Recognition — QA',            value: 1.00,
      format: 'pct', approved: true,
      note: 'QA Excellence at 100.00% — approved standard (PASS stays 98.50%)' },
    { key: 'REC_MONTHS', label: 'Recognition consecutive months', value: 3,
      format: 'int', approved: true,
      note: 'Consecutive qualifying months for recognition' },
  ];
  const RULE = Object.fromEntries(BUSINESS_RULES.map(r => [r.key, r.value]));

  const QA_PASS   = RULE.QA_PASS;    // approved: 98.50%
  const PROD_PASS = RULE.PROD_PASS;  // approved: 100%
  const REC_PROD  = RULE.REC_PROD;   // recognition productivity
  const REC_QA    = RULE.REC_QA;     // recognition QA — provisional
  const LOB       = 'Dispute & Intake';   // current LOB — expand when new LOBs onboard

  /* ── Filter state + computed data cache ──────────────────── */
  const S = {
    pipReason: 'all',  pipMgr: 'all',  pipSearch: '',
    noteReason: 'all', noteMgr: 'all', noteSearch: '',
  };
  const DATA = { pip: [], rec: [], drafts: [], _rows: null };

  /* ── Cached computeRows — invalidated by renderAll only ─────
     mxRefresh and mxOpenDetail consume the cache rather than
     running a fresh O(N) merge on every filter keystroke.      */
  function cachedRows() {
    if (!DATA._rows) DATA._rows = computeRows();
    return DATA._rows;
  }

  /* ── Shared debounce ─────────────────────────────────────── */
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ── Per-associate × month merged rows ─────────────────────
     { a, m, ym, act, tgt, prodPct, qaCnt, avgQA }
     Same merge logic as Monthly Performance page. */
  function computeRows() {
    const prodMap = {};
    D_PROD.forEach(r => {
      if (!r.a || !r.ym) return;
      const key = r.a + '|' + r.ym;
      if (!prodMap[key]) prodMap[key] = { a: r.a, m: r.m, ym: r.ym, act: 0, tgt: 0 };
      prodMap[key].act += r.act || 0;
      prodMap[key].tgt += r.tgt || 0;
    });

    const qaMap = {};
    D_QA.forEach(r => {
      const name = idToName[r.id] || r.a || r.id;
      if (!name || !r.d) return;
      const ym = r.d.substring(0, 7);
      const key = name + '|' + ym;
      if (!qaMap[key]) qaMap[key] = { a: name, m: r.m, ym, cnt: 0, wScr: 0 };
      qaMap[key].cnt  += r.cnt || 0;
      qaMap[key].wScr += (r.cnt || 0) * (r.scr || 0);
    });

    const merged = { ...prodMap };
    Object.entries(qaMap).forEach(([key, q]) => {
      if (!merged[key]) merged[key] = { a: q.a, m: q.m, ym: q.ym, act: 0, tgt: 0 };
      merged[key].qaCnt = (merged[key].qaCnt || 0) + q.cnt;
      merged[key].qaScr = (merged[key].qaScr || 0) + q.wScr;
    });

    return Object.values(merged).map(r => ({
      ...r,
      prodPct: r.tgt > 0 ? r.act / r.tgt : null,
      avgQA:   r.qaCnt > 0 ? r.qaScr / r.qaCnt : null,
    }));
  }

  /* ── Watchlist engines ───────────────────────────────────── */
  function fmtYM(ym) {
    const [yr, mo] = ym.split('-').map(Number);
    return new Date(yr, mo - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
  }

  // Group rows by associate -> sorted month list
  function byAssoc(rows) {
    const map = {};
    rows.forEach(r => {
      if (!map[r.a]) map[r.a] = [];
      map[r.a].push(r);
    });
    Object.values(map).forEach(list => list.sort((x, y) => x.ym < y.ym ? -1 : 1));
    return map;
  }

  function computePIP(rows) {
    const out = [];
    Object.entries(byAssoc(rows)).forEach(([a, list]) => {
      const m = list[list.length - 1].m;

      // Most recent N months WITH production target
      const prod = list.filter(r => r.tgt > 0).slice(-RULE.PIP_MONTHS);
      const prodFail = prod.length === RULE.PIP_MONTHS && prod.every(r => r.prodPct < PROD_PASS);

      // Most recent N months WITH QA audits
      const qa = list.filter(r => r.qaCnt > 0).slice(-RULE.PIP_MONTHS);
      const qaFail = qa.length === RULE.PIP_MONTHS && qa.every(r => r.avgQA < QA_PASS);

      if (!prodFail && !qaFail) return;

      const reason = prodFail && qaFail ? 'Dual Fail'
                   : prodFail ? 'Productivity Fail' : 'QA Fail';

      // Month 1 / Month 2 result text uses whichever metric(s) failed
      const cellFor = (r, kind) => {
        if (!r) return '—';
        if (kind === 'prod') {
          const st = r.prodPct < PROD_PASS ? 'fail' : 'pass';
          return { label: `${fmtYM(r.ym)} · ${(r.prodPct * 100).toFixed(1)}%`, st };
        }
        const st = r.avgQA < QA_PASS ? 'fail' : 'pass';
        return { label: `${fmtYM(r.ym)} · QA ${(r.avgQA * 100).toFixed(1)}%`, st };
      };
      // Prefer the failing metric for display; fall back to latest month pair
      const kind = prodFail ? 'prod' : 'qa';
      const src  = prodFail ? prod : qa;
      const dual = prodFail && qaFail ? qa : null;

      out.push({
        a, m, lob: LOB, reason,
        m1: cellFor(src[0], kind), m2: cellFor(src[1], kind),
        m1b: dual ? cellFor(dual[0], 'qa') : null,
        m2b: dual ? cellFor(dual[1], 'qa') : null,
        // Structured month values for email bodies (failed metrics only)
        prodMonths: prodFail ? prod.map(r => ({ ym: r.ym, pct: r.prodPct })) : [],
        qaMonths:   qaFail   ? qa.map(r   => ({ ym: r.ym, scr: r.avgQA }))   : [],
        status: 'Review Required',
      });
    });
    return out.sort((x, y) => x.a < y.a ? -1 : 1);
  }

  // Finds the most recent run of >=N consecutive months where
  // every month satisfies `test`. Returns the last N rows of that
  // run (for trend display), or null.
  function bestStreak(list, test, n = RULE.REC_MONTHS) {
    let run = [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (test(list[i])) {
        run.unshift(list[i]);
        if (run.length >= n) return run.slice(0, n);
      } else {
        run = [];
      }
    }
    return null;
  }

  function computeRecognition(rows) {
    const out = [];
    Object.entries(byAssoc(rows)).forEach(([a, list]) => {
      const m = list[list.length - 1].m;

      // Most recent streak of 3 consecutive qualifying months
      const prodRows = list.filter(r => r.tgt > 0);
      const qaRows   = list.filter(r => r.qaCnt > 0);
      const prodRun  = bestStreak(prodRows, r => r.prodPct >= REC_PROD);
      const qaRun    = bestStreak(qaRows,   r => r.avgQA   >= REC_QA);

      if (!prodRun && !qaRun) return;

      const type = prodRun && qaRun ? 'Dual Excellence'
                 : prodRun ? 'Productivity Excellence' : 'QA Excellence';

      const reasons = [];
      if (prodRun) reasons.push(`Productivity ≥ ${(RULE.REC_PROD * 100).toFixed(0)}% for ${RULE.REC_MONTHS} consecutive months`);
      if (qaRun)   reasons.push(`QA ≥ ${(RULE.REC_QA * 100).toFixed(2)}% for ${RULE.REC_MONTHS} consecutive months`);

      const trend = [];
      if (prodRun) trend.push('Prod: ' + prodRun.map(r => (r.prodPct * 100).toFixed(0) + '%').join(' → '));
      if (qaRun)   trend.push('QA: '   + qaRun.map(r => (r.avgQA * 100).toFixed(1) + '%').join(' → '));

      out.push({ a, m, type, reason: reasons.join(' + '), trend: trend.join(' · ') });
    });
    return out.sort((x, y) => x.a < y.a ? -1 : 1);
  }

  /* ── Manager email lookup (fuzzy name match on roster) ───── */
  function normName(s) { return (s || '').toLowerCase().replace(/[^a-z]/g, ''); }
  function managerEmail(mgrName) {
    if (typeof D_LEADERSHIP === 'undefined') return '';
    const n = normName(mgrName);
    const hit = D_LEADERSHIP.find(r => normName(r.am) === n);
    return hit ? hit.email : '';
  }

  /* ── Notification Center: draft generation ───────────────── */
  function buildDrafts(pip, rec) {
    const drafts = [];
    const kindMap = { 'Dual Fail': 'dual', 'Productivity Fail': 'prod', 'QA Fail': 'qa' };
    pip.forEach(p => {
      const subjMap = {
        'Productivity Fail': 'ORBIT Alert - Consecutive Productivity Failure',
        'QA Fail':           'ORBIT Alert - Consecutive QA Failure',
        'Dual Fail':         'ORBIT Alert - Consecutive Productivity & QA Failure',
      };
      const sep = '------------------------------------------------';

      // Merge the two metrics' month lists: union of yms, last two,
      // each mapped to whichever metrics have data that month.
      const prodByYM = Object.fromEntries(p.prodMonths.map(mm => [mm.ym, mm.pct]));
      const qaByYM   = Object.fromEntries(p.qaMonths.map(mm => [mm.ym, mm.scr]));
      const monthYMs = [...new Set([...p.prodMonths, ...p.qaMonths].map(mm => mm.ym))]
        .sort().slice(-2);
      const months = monthYMs.map(ym => ({
        ym,
        prod: ym in prodByYM ? prodByYM[ym] : null,
        qa:   ym in qaByYM   ? qaByYM[ym]   : null,
      }));

      const monthBlocks = months.map((mm, i) => {
        const lines = [`${sep}\n\nMonth ${i + 1} Results\n(${fmtYM(mm.ym)})\n`];
        if (mm.prod != null) lines.push(`Productivity:\n${(mm.prod * 100).toFixed(1)}% (FAIL)\n`);
        if (mm.qa   != null) lines.push(`QA Score:\n${(mm.qa * 100).toFixed(1)}% (FAIL)\n`);
        return lines.join('\n');
      }).join('\n');

      const recLine = p.reason === 'Dual Fail'
        ? 'Associate has failed both Productivity and QA standards across two consecutive months.'
        : p.reason === 'QA Fail'
        ? 'Associate has failed the QA standard across two consecutive months.'
        : 'Associate has failed the Productivity standard across two consecutive months.';

      drafts.push({
        type: 'pip',
        kind: kindMap[p.reason] || 'prod',
        a: p.a, m: p.m,
        reason: p.reason,
        to: managerEmail(p.m),
        subject: `[HIGH IMPORTANCE] ${subjMap[p.reason] || 'ORBIT Alert - Performance Review Required'}`,
        body:
`*** Leadership Review Required ***

Good Day,

ORBIT has identified an associate requiring leadership review based on consecutive performance failures.

${sep}

Associate Information

Associate:
${p.a}

Manager:
${p.m}

LOB:
${p.lob}

Failure Type:
${p.reason}

${monthBlocks}
${sep}

Performance Standards

Productivity Requirement:
100%

QA Requirement:
98.50%

${sep}

Recommendation

${recLine}

Leadership review is recommended.

Regards,

PROJECT ORBIT
Operational Results & Business Intelligence Tracker

Powered by Payment Integrity IGNITE`,
        meta: {
          m1prod: months[0] && months[0].prod != null ? (months[0].prod * 100).toFixed(1) + '%' : '—',
          m1qa:   months[0] && months[0].qa   != null ? (months[0].qa   * 100).toFixed(1) + '%' : '—',
          m1ym:   months[0] ? fmtYM(months[0].ym) : '—',
          m2prod: months[1] && months[1].prod != null ? (months[1].prod * 100).toFixed(1) + '%' : '—',
          m2qa:   months[1] && months[1].qa   != null ? (months[1].qa   * 100).toFixed(1) + '%' : '—',
          m2ym:   months[1] ? fmtYM(months[1].ym) : '—',
        },
      });
    });
    rec.forEach(r => {
      const medal = r.type === 'Dual Excellence' ? '🏆'
                  : r.type === 'Productivity Excellence' ? '🚀' : '🥇';
      const reasonLine = r.type === 'Dual Excellence'
        ? `${r.a} has achieved sustained excellence across BOTH Productivity and Quality — a rare and commendable accomplishment.`
        : r.type === 'Productivity Excellence'
        ? `${r.a} has achieved sustained excellence in Productivity, exceeding the ${(RULE.REC_PROD * 100).toFixed(0)}% mark for ${RULE.REC_MONTHS} consecutive months.`
        : `${r.a} has achieved sustained excellence in Quality, holding QA at or above ${(RULE.REC_QA * 100).toFixed(2)}% for ${RULE.REC_MONTHS} consecutive months.`;
      drafts.push({
        type: 'rec',
        kind: 'rec',
        a: r.a, m: r.m,
        reason: r.type,
        to: managerEmail(r.m),
        subject: `🌟 ORBIT Recognition - ${r.type} - ${r.a}`,
        body:
`🏆  🏆  🏆  🏆  🏆  🏆  🏆  🏆  🏆  🏆

           ORBIT RECOGNITION OF EXCELLENCE

🌟  🌟  🌟  🌟  🌟  🌟  🌟  🌟  🌟  🌟

Good Day,

It is our pleasure to recognize an associate whose sustained
performance sets the standard for the team.

════════════════════════════════════════

${medal}  CATEGORY: ${r.type.toUpperCase()}  ${medal}

Associate:
${r.a}

Manager:
${r.m}

LOB:
${LOB}

════════════════════════════════════════

${reasonLine}

────────────────────────────────────────

PERFORMANCE RECORD

${r.trend.split(' · ').map(t => t.startsWith('Prod:') ? '🚀  Productivity Trend (3 months)\n' + t.slice(6) : '🥇  QA Trend (3 months)\n' + t.slice(4)).join('\n\n')}

────────────────────────────────────────

🎖️  ENDORSEMENT

This level of sustained performance merits formal recognition.
We recommend acknowledging this achievement through your
standard recognition process.

With appreciation,

PROJECT ORBIT
Operational Results & Business Intelligence Tracker
Powered by Payment Integrity IGNITE

🌟  🌟  🌟  🌟  🌟  🌟  🌟  🌟  🌟  🌟`,
        meta: { trend: r.trend },
      });
    });
    return drafts;
  }

  /* ── Rendering ───────────────────────────────────────────── */
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const stPill = st => st === 'fail'
    ? '<span class="mp-status-pill is-fail">&#10006; FAIL</span>'
    : '<span class="mp-status-pill is-pass">&#10004; PASS</span>';
  const kindOf = reason => reason === 'Dual Fail' ? 'dual' : reason.startsWith('QA') ? 'qa' : 'prod';

  /* ── Filter helpers ──────────────────────────────────────── */
  function pipFiltered() {
    return DATA.pip.filter(p =>
      (S.pipReason === 'all' || kindOf(p.reason) === S.pipReason) &&
      (S.pipMgr    === 'all' || p.m === S.pipMgr) &&
      (!S.pipSearch || p.a.toLowerCase().includes(S.pipSearch))
    );
  }
  function notesFiltered() {
    return DATA.drafts.filter(d =>
      (S.noteReason === 'all' || d.kind === S.noteReason) &&
      (S.noteMgr    === 'all' || d.m === S.noteMgr) &&
      (!S.noteSearch || d.a.toLowerCase().includes(S.noteSearch))
    );
  }
  function buildManagerSelect(id, entries) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const keep = sel.value || 'all';
    const mgrs = [...new Set(entries.map(e => e.m))].sort();
    sel.innerHTML = '<option value="all">All Managers</option>' +
      mgrs.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    sel.value = mgrs.includes(keep) ? keep : 'all';
  }

  /* ── Outlook Web compose link (desktop client is blocked) ──
     IMPORTANT: use %20-encoding (encodeURIComponent). OWA does NOT
     decode '+' as a space, so URLSearchParams output shows raw '+'
     characters to the user. */
  function owaLink(d) {
    const base = 'https://outlook.office.com/mail/deeplink/compose';
    const parts = [];
    if (d.to) parts.push('to=' + encodeURIComponent(d.to));
    parts.push('subject=' + encodeURIComponent(d.subject));
    parts.push('body=' + encodeURIComponent(d.body));
    return base + '?' + parts.join('&');
  }

  /* ── Sub-page dirty flags — set by renderAll, cleared on first view ── */
  const LP_DIRTY = { pip: false, rec: false, notes: false, managers: false, alerts: false, matrix: false, ar: false, mynotes: false };
  // currentSub tracks which sub-page is visible so renders can be skipped
  let currentSub = 'summary';

  /* ── Sub-page navigation ─────────────────────────────────── */
  function showSub(name, scroll = true) {
    currentSub = name;
    document.querySelectorAll('.lp-subpage').forEach(p =>
      p.classList.toggle('is-hidden', p.dataset.lpSubpage !== name));
    document.querySelectorAll('.lp-subnav__tab').forEach(t => {
      t.classList.toggle('is-active', t.dataset.lpSub === name);
      t.setAttribute('aria-selected', t.dataset.lpSub === name ? 'true' : 'false');
    });
    // Flush any pending render for this sub-page
    flushDirty(name);
    if (scroll) {
      document.getElementById('page-leadership').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ── Flush a dirty sub-page render ───────────────────────── */
  function flushDirty(name) {
    if (!LP_DIRTY[name]) return;
    LP_DIRTY[name] = false;
    switch (name) {
      case 'pip':      renderPIP(); break;
      case 'rec':      renderRec(); break;
      case 'notes':    renderNotes(); break;
      case 'managers': { const sc = computeScorecard(cachedRows(), DATA.pip, DATA.rec); renderScorecard(sc); break; }
      case 'alerts':   { const sc2 = computeScorecard(cachedRows(), DATA.pip, DATA.rec);
                         renderAlerts(computeAlerts(cachedRows(), DATA.pip, DATA.rec, sc2)); break; }
      case 'matrix':   if (matrixInit) mxRefresh(); break;
      case 'ar':       AR.render(); break;
      case 'mynotes':  NOTES.render(); break;
    }
  }

  /* ── Row → notification navigation ───────────────────────── */
  function openNotification(assoc) {
    // Switch to the Notifications sub-page filtered to this associate
    showSub('notes', false);
    S.noteReason = 'all'; S.noteMgr = 'all'; S.noteSearch = assoc.toLowerCase();
    syncNoteControls();
    renderNotes();
    const idx = DATA.drafts.findIndex(d => d.a === assoc && d.type === 'pip');
    if (idx < 0) return;
    const card = document.getElementById('lp-note-' + idx);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('lp-note--flash');
    void card.offsetWidth;               // restart the flash animation
    card.classList.add('lp-note--flash');
  }

  /* ── Renders ─────────────────────────────────────────────── */
  function renderPIP() {
    const pip = pipFiltered();
    const tb  = document.getElementById('lp-pip-tbody');
    if (!pip.length) {
      tb.innerHTML = '<tr><td colspan="8" class="lp-empty">No associates match the current filters.</td></tr>';
      return;
    }
    tb.innerHTML = pip.map(p => {
      const m2 = p.m2b ? `${esc(p.m2.label)} ${stPill(p.m2.st)}<br>${esc(p.m2b.label)} ${stPill(p.m2b.st)}`
                       : `${esc(p.m2.label)} ${stPill(p.m2.st)}`;
      const m1 = p.m1b ? `${esc(p.m1.label)} ${stPill(p.m1.st)}<br>${esc(p.m1b.label)} ${stPill(p.m1b.st)}`
                       : `${esc(p.m1.label)} ${stPill(p.m1.st)}`;
      return `<tr class="lp-row" data-assoc="${esc(p.a)}" title="View notification draft">
        <td class="col-associate">${esc(p.a)}</td>
        <td class="col-manager">${esc(p.m)}</td>
        <td>${esc(p.lob)}</td>
        <td class="col-num lp-result">${m1}</td>
        <td class="col-num lp-result">${m2}</td>
        <td><button class="lp-reason lp-reason--${kindOf(p.reason)} lp-reason--btn" data-reason="${kindOf(p.reason)}" type="button">${esc(p.reason)}</button></td>
        <td><span class="mp-status-pill is-fail">${esc(p.status)}</span></td>
        <td class="ar-action-cell">
          <button class="orbit-btn orbit-btn--primary lp-open-note" data-assoc="${esc(p.a)}" type="button">Open Notification</button>
          <button class="orbit-btn orbit-btn--ghost lp-ar-add" data-assoc="${esc(p.a)}" type="button" title="Add performance record for ${esc(p.a)}">+ Record</button>
        </td>
      </tr>`;
    }).join('');

    tb.querySelectorAll('.lp-open-note').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); openNotification(btn.dataset.assoc); }));
    tb.querySelectorAll('.lp-ar-add').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); AR.addRecordFor(btn.dataset.assoc); }));
    tb.querySelectorAll('.lp-row').forEach(row =>
      row.addEventListener('click', () => openNotification(row.dataset.assoc)));
    tb.querySelectorAll('.lp-reason--btn').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        S.pipReason = btn.dataset.reason;
        syncPipPills();
        renderPIP();
      }));
  }

  function renderRec() {
    const rec = DATA.rec;
    const tb = document.getElementById('lp-rec-tbody');
    if (!rec.length) {
      tb.innerHTML = '<tr><td colspan="4" class="lp-empty">No associates meet the recognition criteria this period.</td></tr>';
      return;
    }
    tb.innerHTML = rec.map(r => `<tr>
      <td class="col-associate">${esc(r.a)}</td>
      <td class="col-manager">${esc(r.m)}</td>
      <td><button class="lp-reason ${r.type === 'Dual Excellence' ? 'lp-reason--dual-rec' : 'lp-reason--rec'} lp-reason--btn" data-reason="rec" data-assoc="${esc(r.a)}" type="button">${esc(r.type)}</button></td>
      <td class="lp-trend">${esc(r.trend)}</td>
      <td class="ar-action-cell">
        <button class="orbit-btn orbit-btn--ghost lp-ar-add" data-assoc="${esc(r.a)}" type="button" title="Add recognition record for ${esc(r.a)}">+ Record</button>
      </td>
    </tr>`).join('');
    tb.querySelectorAll('.lp-reason--btn').forEach(btn =>
      btn.addEventListener('click', () => {
        // Jump to this associate's recognition draft in Notification Center
        S.noteReason = 'all'; S.noteMgr = 'all'; S.noteSearch = '';
        syncNoteControls();
        renderNotes();
        const idx = DATA.drafts.findIndex(d => d.a === btn.dataset.assoc && d.type === 'rec');
        const card = document.getElementById('lp-note-' + idx);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.remove('lp-note--flash');
          void card.offsetWidth;
          card.classList.add('lp-note--flash');
        }
      }));
    tb.querySelectorAll('.lp-ar-add').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); AR.addRecordFor(btn.dataset.assoc); }));
  }

  function renderNotes() {
    const box = document.getElementById('lp-notes');
    const vis = notesFiltered();
    if (!vis.length) {
      box.innerHTML = '<div class="lp-empty">No notifications match the current filters.</div>';
      return;
    }
    const kindLabel = { dual: 'DUAL FAIL', prod: 'PRODUCTIVITY FAIL', qa: 'QA FAIL', rec: 'RECOGNITION' };
    box.innerHTML = vis.map(d => {
      const i = DATA.drafts.indexOf(d);
      return `
      <div class="lp-note lp-note--${d.type}" id="lp-note-${i}">
        <div class="lp-note__head">
          <button class="lp-note__tag lp-note__tag--btn" data-reason="${d.kind}" type="button">${kindLabel[d.kind]}</button>
          <span class="lp-note__subj">${esc(d.subject)}</span>
        </div>
        <div class="lp-note__meta">
          <div><span>Failure Type</span><b>${esc(d.reason || 'Recognition')}</b></div>
          <div><span>Associate</span><b>${esc(d.a)}</b></div>
          <div><span>Manager</span><b>${esc(d.m)}</b></div>
          ${d.meta && d.meta.m1prod != null ? `<div><span>M1 Prod (${esc(d.meta.m1ym)})</span><b>${esc(d.meta.m1prod)}</b></div>` : ''}
          ${d.meta && d.meta.m1qa   != null ? `<div><span>M1 QA (${esc(d.meta.m1ym)})</span><b>${esc(d.meta.m1qa)}</b></div>` : ''}
          ${d.meta && d.meta.m2prod != null ? `<div><span>M2 Prod (${esc(d.meta.m2ym)})</span><b>${esc(d.meta.m2prod)}</b></div>` : ''}
          ${d.meta && d.meta.m2qa   != null ? `<div><span>M2 QA (${esc(d.meta.m2ym)})</span><b>${esc(d.meta.m2qa)}</b></div>` : ''}
          ${d.meta && d.meta.trend ? `<div><span>Trend</span><b>${esc(d.meta.trend)}</b></div>` : ''}
          <div><span>To</span><b>${d.to ? esc(d.to) : '<em>manager email not in roster</em>'}</b></div>
        </div>
        <pre class="lp-note__body">${esc(d.body)}</pre>
        <div class="lp-note__actions">
          <a class="orbit-btn orbit-btn--primary lp-note__outlook"
             href="${owaLink(d)}" target="_blank" rel="noopener">
            Open in Outlook Web
          </a>
          <button class="orbit-btn orbit-btn--ghost lp-note__copy" data-idx="${i}" type="button">Copy Draft</button>
        </div>
      </div>`;
    }).join('');

    box.querySelectorAll('.lp-note__copy').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = DATA.drafts[+btn.dataset.idx];
        const txt = `To: ${d.to}\nSubject: ${d.subject}\n\n${d.body}`;
        navigator.clipboard.writeText(txt).then(() => {
          btn.textContent = 'Copied';
          setTimeout(() => btn.textContent = 'Copy Draft', 1600);
        });
      });
    });
    box.querySelectorAll('.lp-note__tag--btn').forEach(btn =>
      btn.addEventListener('click', () => {
        S.noteReason = btn.dataset.reason;
        syncNotePills();
        renderNotes();
      }));
  }

  /* ── Manager Scorecard ───────────────────────────────────── */
  function computeScorecard(rows, pip, rec) {
    const byMgr = {};
    rows.forEach(r => {
      if (!r.m) return;
      if (!byMgr[r.m]) byMgr[r.m] = { m: r.m, assoc: new Set(), act: 0, tgt: 0,
        qaCnt: 0, qaScr: 0, prodPass: 0, prodTot: 0, qaPass: 0, qaTot: 0 };
      const g = byMgr[r.m];
      g.assoc.add(r.a);
      g.act += r.act || 0;
      g.tgt += r.tgt || 0;
      if (r.tgt > 0) { g.prodTot++; if (r.prodPct >= PROD_PASS) g.prodPass++; }
      if (r.qaCnt > 0) {
        g.qaCnt += r.qaCnt; g.qaScr += r.qaCnt * r.avgQA;
        g.qaTot++; if (r.avgQA >= QA_PASS) g.qaPass++;
      }
    });
    const pipSet = new Set(pip.map(p => p.a));
    const recSet = new Set(rec.map(r => r.a));
    return Object.values(byMgr).map(g => ({
      m: g.m,
      associates: g.assoc.size,
      prodPct:  g.tgt   > 0 ? g.act / g.tgt : null,
      avgQA:    g.qaCnt > 0 ? g.qaScr / g.qaCnt : null,
      prodPassRate: g.prodTot > 0 ? g.prodPass / g.prodTot : null,
      qaPassRate:   g.qaTot   > 0 ? g.qaPass   / g.qaTot   : null,
      pip: [...pipSet].filter(a => g.assoc.has(a)).length,
      rec: [...recSet].filter(a => g.assoc.has(a)).length,
    })).sort((x, y) => (y.prodPct || 0) - (x.prodPct || 0));
  }

  function renderScorecard(rows) {
    const tb = document.getElementById('lp-score-tbody');
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="8" class="lp-empty">No manager data available.</td></tr>';
      return;
    }
    const ratePill = (v, thr) => v == null ? '<span class="mp-status-pill is-na">—</span>'
      : `<span class="mp-status-pill ${v >= thr ? 'is-pass' : 'is-fail'}">${(v * 100).toFixed(0)}%</span>`;
    tb.innerHTML = rows.map(g => `<tr>
      <td class="col-associate">${esc(g.m)}</td>
      <td class="col-num">${g.associates}</td>
      <td class="col-num ${g.prodPct != null ? (g.prodPct >= PROD_PASS ? 'is-positive' : 'is-negative') : ''}">${g.prodPct != null ? (g.prodPct * 100).toFixed(1) + '%' : '—'}</td>
      <td class="col-num ${g.avgQA != null ? (g.avgQA >= QA_PASS ? 'is-positive' : 'is-negative') : ''}">${g.avgQA != null ? (g.avgQA * 100).toFixed(1) + '%' : '—'}</td>
      <td class="col-num">${ratePill(g.prodPassRate, 0.75)}</td>
      <td class="col-num">${ratePill(g.qaPassRate, 0.75)}</td>
      <td class="col-num">${g.pip ? `<span class="mp-status-pill is-fail">${g.pip}</span>` : '0'}</td>
      <td class="col-num">${g.rec ? `<span class="mp-status-pill is-pass">${g.rec}</span>` : '0'}</td>
    </tr>`).join('');
  }

  /* ── Executive Alerts ────────────────────────────────────── */
  function computeAlerts(rows, pip, rec, scorecard) {
    const alerts = [];

    // HIGH: dual-fail associates need immediate review
    pip.filter(p => p.reason === 'Dual Fail').forEach(p => {
      alerts.push({ sev: 'high', title: `Dual Fail — ${p.a}`,
        detail: `${p.m} · Productivity and QA below standard for ${RULE.PIP_MONTHS} consecutive months. Immediate review recommended.`,
        assoc: p.a });
    });

    // HIGH: managers with 2+ associates on the PIP watchlist
    const pipByMgr = {};
    pip.forEach(p => { pipByMgr[p.m] = (pipByMgr[p.m] || 0) + 1; });
    Object.entries(pipByMgr).filter(([, n]) => n >= 2).forEach(([m, n]) => {
      alerts.push({ sev: 'high', title: `${n} PIP cases under ${m}`,
        detail: `Multiple associates below standard — team-level coaching or workload review may be needed.` });
    });

    // MEDIUM: latest month team performance below standard
    const yms = [...new Set(rows.map(r => r.ym))].sort();
    const lastYM = yms[yms.length - 1];
    if (lastYM) {
      const latest = rows.filter(r => r.ym === lastYM);
      const act = latest.reduce((s, r) => s + (r.act || 0), 0);
      const tgt = latest.reduce((s, r) => s + (r.tgt || 0), 0);
      if (tgt > 0 && act / tgt < PROD_PASS) {
        alerts.push({ sev: 'medium', title: `Team productivity below target in ${fmtYM(lastYM)}`,
          detail: `Blended productivity ${(act / tgt * 100).toFixed(1)}% vs 100% target.` });
      }
      const qc = latest.reduce((s, r) => s + (r.qaCnt || 0), 0);
      const qs = latest.reduce((s, r) => s + (r.qaCnt || 0) * (r.avgQA || 0), 0);
      if (qc > 0 && qs / qc < QA_PASS) {
        alerts.push({ sev: 'medium', title: `Team QA below standard in ${fmtYM(lastYM)}`,
          detail: `Blended QA ${(qs / qc * 100).toFixed(1)}% vs ${(QA_PASS * 100).toFixed(2)}% standard.` });
      }
    }

    // MEDIUM: managers whose blended QA is below standard
    scorecard.filter(g => g.avgQA != null && g.avgQA < QA_PASS).forEach(g => {
      alerts.push({ sev: 'medium', title: `${g.m} — team QA below standard`,
        detail: `Blended QA ${(g.avgQA * 100).toFixed(1)}% across ${g.associates} associates.` });
    });

    // INFO: recognition pipeline health
    if (rec.length) {
      alerts.push({ sev: 'info', title: `${rec.length} associate${rec.length > 1 ? 's' : ''} eligible for recognition`,
        detail: 'Sustained excellence detected — see Recognition Watchlist.' });
    }
    if (pip.length) {
      alerts.push({ sev: 'info', title: `${pip.length} associate${pip.length > 1 ? 's' : ''} on PIP Watchlist`,
        detail: 'Review drafts in the Notification Center.' });
    }

    const order = { high: 0, medium: 1, info: 2 };
    return alerts.sort((a, b) => order[a.sev] - order[b.sev]);
  }

  function renderAlerts(alerts) {
    const box = document.getElementById('lp-alerts');
    if (!alerts.length) {
      box.innerHTML = '<div class="lp-empty">No alerts — all metrics within standard.</div>';
      return;
    }
    const label = { high: 'HIGH', medium: 'MEDIUM', info: 'INFO' };
    box.innerHTML = alerts.map(al => `
      <div class="lp-alert lp-alert--${al.sev}"${al.assoc ? ` data-assoc="${esc(al.assoc)}"` : ''}>
        <span class="lp-alert__sev">${label[al.sev]}</span>
        <div class="lp-alert__text">
          <div class="lp-alert__title">${esc(al.title)}</div>
          <div class="lp-alert__detail">${esc(al.detail)}</div>
        </div>
        ${al.assoc ? '<button class="orbit-btn orbit-btn--ghost lp-alert__open" type="button">Open Notification</button>' : ''}
      </div>`).join('');
    box.querySelectorAll('.lp-alert__open').forEach(btn =>
      btn.addEventListener('click', () => {
        const assoc = btn.closest('.lp-alert').dataset.assoc;
        if (assoc) openNotification(assoc);
      }));
  }

  function renderRules() {
    const tb = document.getElementById('lp-rules-tbody');
    if (!tb) return;
    tb.innerHTML = BUSINESS_RULES.map(r => `<tr>
      <td class="col-associate">${esc(r.label)}</td>
      <td class="col-num lp-rule-value">${r.format === 'pct' ? (r.value * 100).toFixed(2).replace(/\.?0+$/, '') + '%' : r.value}</td>
      <td><span class="mp-status-pill ${r.approved ? 'is-pass' : 'lp-rule-pending'}">${r.approved ? 'Approved' : 'Pending Decision'}</span></td>
      <td class="lp-trend">${esc(r.note)}</td>
    </tr>`).join('');
  }

  /* ══════════════════════════════════════════════════════════
     PERFORMANCE MATRIX — Quarterly scatter plot
     Axes: X = Quarterly Productivity %, Y = Quarterly QA %
     Business thresholds: Prod ≥ 100%, QA ≥ 98.50%
     ══════════════════════════════════════════════════════════ */

  // Quarter → month set helper
  const QTR_MONTHS = {
    Q1: ['01','02','03'],
    Q2: ['04','05','06'],
    Q3: ['07','08','09'],
    Q4: ['10','11','12'],
  };

  // Matrix-specific filter state
  const MX = {
    quarter: 'all',   // 'all'|'Q1'|'Q2'|'Q3'|'Q4'
    year: 'all',      // 'all'|'yyyy' — derived from data
    manager: 'all',
    search: '',
    selected: null,   // associate name currently pinned in detail panel
  };

  // Returns year strings present in the data
  function mxYears(rows) {
    return [...new Set(rows.map(r => r.ym.substring(0, 4)))].sort();
  }

  // Filter rows to the selected quarter (and optionally year)
  function mxFilterRows(rows) {
    return rows.filter(r => {
      const yr = r.ym.substring(0, 4);
      const mo = r.ym.substring(5, 7);
      const yearOk = MX.year === 'all' || yr === MX.year;
      const qtrOk  = MX.quarter === 'all' || QTR_MONTHS[MX.quarter].includes(mo);
      const mgrOk  = MX.manager === 'all' || r.m === MX.manager;
      return yearOk && qtrOk && mgrOk;
    });
  }

  // Aggregate filtered rows → one point per associate
  function mxAssocPoints(rows) {
    const map = {};
    rows.forEach(r => {
      if (!r.a) return;
      if (!map[r.a]) map[r.a] = { a: r.a, m: r.m, act: 0, tgt: 0, qaCnt: 0, qaScr: 0 };
      const g = map[r.a];
      g.act   += r.act   || 0;
      g.tgt   += r.tgt   || 0;
      g.qaCnt += r.qaCnt || 0;
      g.qaScr += r.qaCnt ? (r.qaCnt * (r.avgQA || 0)) : 0;
      // keep most-recent manager
      if (!g.m) g.m = r.m;
    });
    return Object.values(map).map(g => {
      const prodPct = g.tgt > 0 ? g.act / g.tgt : null;
      const avgQA   = g.qaCnt > 0 ? g.qaScr / g.qaCnt : null;

      // Quadrant classification (only when both axes available)
      let quad = null;
      if (prodPct != null && avgQA != null) {
        const pPass = prodPct >= PROD_PASS;
        const qPass = avgQA   >= QA_PASS;
        if (pPass  && qPass)  quad = 'dual';      // Top-Right
        if (!pPass && qPass)  quad = 'qa-only';   // Top-Left
        if (pPass  && !qPass) quad = 'prod-only'; // Bottom-Right
        if (!pPass && !qPass) quad = 'none';      // Bottom-Left
      }

      // Recognition status
      const recRow = DATA.rec ? DATA.rec.find(r => r.a === g.a) : null;
      const recStatus = recRow ? recRow.type : null;

      return { ...g, prodPct, avgQA, quad, recStatus };
    });
  }

  // Color per quadrant category
  const MX_COLORS = {
    'dual':      { fill: 'rgba(0,187,186,0.75)',   stroke: '#00BBBA' },   // teal — Dual Excellence
    'qa-only':   { fill: 'rgba(130,100,220,0.70)', stroke: '#7C5CBF' },   // purple — Prod Opportunity
    'prod-only': { fill: 'rgba(250,159,67,0.80)',  stroke: '#F59E0B' },   // amber — QA Opportunity
    'none':      { fill: 'rgba(250,128,114,0.75)', stroke: '#FA8072' },   // red — Critical Attention
    'null':      { fill: 'rgba(120,120,140,0.40)', stroke: '#888' },      // grey — incomplete data
  };
  function mxColor(pt) { return MX_COLORS[pt.quad ?? 'null']; }

  /* ── SVG scatter render ────────────────────────────────────
     Coordinate system:
       X axis = Quarterly Productivity % (0–160%+)
       Y axis = Quarterly QA %  (90–100%+)
     The threshold lines at X=100% and Y=98.5% divide the chart
     into the four quadrants.  ──────────────────────────────── */

  let mxTooltipVisible = false;

  function mxRenderPlot(points) {
    const wrap = document.getElementById('mx-plot-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';          // clear previous

    // Canvas dimensions
    const W = wrap.clientWidth  || 680;
    const H = Math.max(380, Math.round(W * 0.58));

    // Margins for axes labels
    const ML = 56, MR = 18, MT = 18, MB = 44;
    const PW = W - ML - MR;
    const PH = H - MT - MB;

    // Axis ranges — auto-fit but always include the threshold lines
    const prodVals = points.filter(p => p.prodPct != null).map(p => p.prodPct);
    const qaVals   = points.filter(p => p.avgQA   != null).map(p => p.avgQA);

    const xMin = Math.min(0.60, ...prodVals) - 0.02;
    const xMax = Math.max(1.50, ...prodVals) + 0.04;
    const yMin = Math.min(0.88, ...qaVals)   - 0.005;
    const yMax = Math.max(1.001,...qaVals)   + 0.005;

    // Mapping helpers
    const xPx = v => ML + ((v - xMin) / (xMax - xMin)) * PW;
    const yPx = v => MT + PH - ((v - yMin) / (yMax - yMin)) * PH;

    // Build SVG
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Performance matrix scatter plot');
    svg.style.cssText = 'display:block;width:100%;height:auto;font-family:var(--font-ui,"Inter",sans-serif)';

    const mk = tag => document.createElementNS(ns, tag);
    const set = (el, attrs) => { Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v)); return el; };

    // ── Background quadrant fills ─────────────────────────────
    const xThr = xPx(PROD_PASS);   // 100%
    const yThr = yPx(QA_PASS);     // 98.5%

    // Top-Right: dual pass (teal tint)
    svg.appendChild(set(mk('rect'), { x: xThr, y: MT, width: PW - (xThr - ML), height: yThr - MT,
      fill: 'rgba(0,187,186,0.04)', stroke: 'none' }));
    // Top-Left: qa pass only (purple tint)
    svg.appendChild(set(mk('rect'), { x: ML, y: MT, width: xThr - ML, height: yThr - MT,
      fill: 'rgba(92,0,189,0.03)', stroke: 'none' }));
    // Bottom-Right: prod pass only (amber tint)
    svg.appendChild(set(mk('rect'), { x: xThr, y: yThr, width: PW - (xThr - ML), height: PH - (yThr - MT),
      fill: 'rgba(250,159,67,0.04)', stroke: 'none' }));
    // Bottom-Left: dual fail (red tint)
    svg.appendChild(set(mk('rect'), { x: ML, y: yThr, width: xThr - ML, height: PH - (yThr - MT),
      fill: 'rgba(250,128,114,0.06)', stroke: 'none' }));

    // ── Quadrant labels ───────────────────────────────────────
    const qlabel = (txt, x, y, col) => {
      const el = set(mk('text'), { x, y, 'text-anchor': 'middle',
        fill: col, 'font-size': '9.5', 'font-weight': '600',
        opacity: '0.55', 'pointer-events': 'none' });
      el.textContent = txt; return el;
    };
    const midLeft  = ML + (xThr - ML) / 2;
    const midRight = xThr + (ML + PW - xThr) / 2;
    const midTop   = MT + (yThr - MT) / 2;
    const midBot   = yThr + (MT + PH - yThr) / 2;

    svg.appendChild(qlabel('TOP PERFORMERS',          midRight, midTop + 6,  '#00BBBA'));
    svg.appendChild(qlabel('PRODUCTIVITY OPPORTUNITY', midLeft,  midTop + 6,  '#7C5CBF'));
    svg.appendChild(qlabel('QUALITY OPPORTUNITY',      midRight, midBot + 6,  '#F59E0B'));
    svg.appendChild(qlabel('CRITICAL ATTENTION',       midLeft,  midBot + 6,  '#FA8072'));

    // ── Grid lines ────────────────────────────────────────────
    const gridXs = [];
    for (let v = Math.ceil(xMin * 10) / 10; v <= xMax + 0.001; v = Math.round((v + 0.10) * 100) / 100) {
      gridXs.push(v);
    }
    const gridYs = [];
    for (let v = Math.ceil(yMin * 200) / 200; v <= yMax + 0.0001; v = Math.round((v + 0.005) * 1000) / 1000) {
      gridYs.push(v);
    }

    gridXs.forEach(v => {
      const x = xPx(v);
      svg.appendChild(set(mk('line'), { x1: x, y1: MT, x2: x, y2: MT + PH,
        stroke: '#E2DEEF', 'stroke-width': '0.7' }));
    });
    gridYs.forEach(v => {
      const y = yPx(v);
      svg.appendChild(set(mk('line'), { x1: ML, y1: y, x2: ML + PW, y2: y,
        stroke: '#E2DEEF', 'stroke-width': '0.7' }));
    });

    // ── Threshold lines ───────────────────────────────────────
    svg.appendChild(set(mk('line'), { x1: xThr, y1: MT, x2: xThr, y2: MT + PH,
      stroke: '#5A2FBF', 'stroke-width': '1.5', 'stroke-dasharray': '5,3' }));
    svg.appendChild(set(mk('line'), { x1: ML, y1: yThr, x2: ML + PW, y2: yThr,
      stroke: '#5A2FBF', 'stroke-width': '1.5', 'stroke-dasharray': '5,3' }));

    // ── Axes ──────────────────────────────────────────────────
    // X axis
    svg.appendChild(set(mk('line'), { x1: ML, y1: MT + PH, x2: ML + PW, y2: MT + PH,
      stroke: '#C8C0DE', 'stroke-width': '1' }));
    // Y axis
    svg.appendChild(set(mk('line'), { x1: ML, y1: MT, x2: ML, y2: MT + PH,
      stroke: '#C8C0DE', 'stroke-width': '1' }));

    // X tick labels
    gridXs.forEach(v => {
      const x = xPx(v);
      const el = set(mk('text'), { x, y: MT + PH + 14, 'text-anchor': 'middle',
        fill: '#8B85A5', 'font-size': '8.5' });
      el.textContent = Math.round(v * 100) + '%';
      svg.appendChild(el);
    });

    // Y tick labels
    gridYs.forEach(v => {
      const y = yPx(v);
      const el = set(mk('text'), { x: ML - 5, y: y + 3, 'text-anchor': 'end',
        fill: '#8B85A5', 'font-size': '8.5' });
      el.textContent = (v * 100).toFixed(1) + '%';
      svg.appendChild(el);
    });

    // Axis titles
    const xTitle = set(mk('text'), { x: ML + PW / 2, y: H - 3, 'text-anchor': 'middle',
      fill: '#5A5470', 'font-size': '10', 'font-weight': '600' });
    xTitle.textContent = 'Quarterly Productivity %';
    svg.appendChild(xTitle);

    const yTitle = set(mk('text'), { x: 12, y: MT + PH / 2, 'text-anchor': 'middle',
      fill: '#5A5470', 'font-size': '10', 'font-weight': '600',
      transform: `rotate(-90,12,${MT + PH / 2})` });
    yTitle.textContent = 'Quarterly QA %';
    svg.appendChild(yTitle);

    // ── Data points ───────────────────────────────────────────
    const tooltip = document.getElementById('mx-tooltip');

    points.forEach(pt => {
      if (pt.prodPct == null || pt.avgQA == null) return;
      const cx = xPx(pt.prodPct);
      const cy = yPx(pt.avgQA);
      const col = mxColor(pt);

      // Highlight selected associate
      const isSelected = MX.selected && MX.selected === pt.a;
      const r = isSelected ? 9 : 6;

      const g = mk('g');
      g.setAttribute('class', 'mx-point');
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', `${pt.a} — Productivity ${(pt.prodPct*100).toFixed(1)}%, QA ${(pt.avgQA*100).toFixed(1)}%`);

      // Outer ring for selected
      if (isSelected) {
        g.appendChild(set(mk('circle'), { cx, cy, r: r + 4,
          fill: 'none', stroke: col.stroke, 'stroke-width': '2', opacity: '0.5' }));
      }

      const circle = set(mk('circle'), { cx, cy, r,
        fill: col.fill, stroke: col.stroke, 'stroke-width': '1.5',
        style: 'cursor:pointer;transition:r .1s' });
      g.appendChild(circle);

      // Label for points near thresholds or selected
      if (isSelected) {
        const lbl = set(mk('text'), { x: cx, y: cy - r - 4, 'text-anchor': 'middle',
          fill: col.stroke, 'font-size': '8', 'font-weight': '700',
          'pointer-events': 'none' });
        lbl.textContent = pt.a.split(' ')[0];   // first name only to avoid clutter
        g.appendChild(lbl);
      }

      // Search filter: dim non-matching
      const searchMatch = !MX.search || pt.a.toLowerCase().includes(MX.search);
      if (!searchMatch) g.style.opacity = '0.15';

      // Tooltip show/hide
      const showTip = (e) => {
        if (!tooltip) return;
        const recLabel = pt.recStatus ? ` · ${pt.recStatus}` : '';
        tooltip.innerHTML = `
          <div class="mx-tip__name">${esc(pt.a)}</div>
          <div class="mx-tip__mgr">Manager: ${esc(pt.m || '—')}</div>
          <div class="mx-tip__row">
            <span>Productivity</span>
            <strong class="${pt.prodPct >= PROD_PASS ? 'mx-tip--pass' : 'mx-tip--fail'}">${(pt.prodPct*100).toFixed(1)}%</strong>
          </div>
          <div class="mx-tip__row">
            <span>QA Score</span>
            <strong class="${pt.avgQA >= QA_PASS ? 'mx-tip--pass' : 'mx-tip--fail'}">${(pt.avgQA*100).toFixed(1)}%</strong>
          </div>
          <div class="mx-tip__rec">${pt.recStatus ? '★ ' + esc(pt.recStatus) : (pt.quad === 'dual' ? '✓ Dual Pass' : pt.quad === 'qa-only' ? 'Productivity Opportunity' : pt.quad === 'prod-only' ? 'Quality Opportunity' : 'Critical Attention')}</div>
          <div class="mx-tip__hint">Click to view monthly detail</div>`;
        tooltip.style.display = 'block';
        mxPositionTip(e, tooltip);
        mxTooltipVisible = true;
      };
      const hideTip = () => {
        if (tooltip) { tooltip.style.display = 'none'; mxTooltipVisible = false; }
      };

      g.addEventListener('mouseenter', showTip);
      g.addEventListener('mousemove',  e => mxPositionTip(e, tooltip));
      g.addEventListener('mouseleave', hideTip);
      g.addEventListener('focus',      showTip);
      g.addEventListener('blur',       hideTip);

      // Click → open monthly detail panel
      g.addEventListener('click', () => mxOpenDetail(pt, points));
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mxOpenDetail(pt, points); } });

      svg.appendChild(g);
    });

    wrap.appendChild(svg);
  }

  function mxPositionTip(e, tip) {
    if (!tip) return;
    const rect = tip.closest('.lp-subpage')?.getBoundingClientRect?.() ||
                 { left: 0, top: 0 };
    const x = e.clientX - rect.left + 14;
    const y = e.clientY - rect.top  - 10;
    tip.style.left = x + 'px';
    tip.style.top  = y + 'px';
  }

  /* ── Detail panel (replaces side panel) ─────────────────── */
  function mxOpenDetail(pt, allPoints) {
    MX.selected = pt.a;
    const panel = document.getElementById('mx-detail');
    if (!panel) return;

    // Get monthly rows for this associate — use cache (no extra O(N) merge)
    const assocRows = cachedRows().filter(r => r.a === pt.a).sort((a,b) => a.ym < b.ym ? -1 : 1);

    const rows = assocRows.map(r => {
      const pSt = r.prodPct != null ? (r.prodPct >= PROD_PASS ? 'is-pass' : 'is-fail') : 'is-na';
      const qSt = r.avgQA   != null ? (r.avgQA   >= QA_PASS   ? 'is-pass' : 'is-fail') : 'is-na';
      return `<tr>
        <td>${fmtYM(r.ym)}</td>
        <td class="col-num"><span class="mp-status-pill ${pSt}">${r.prodPct != null ? (r.prodPct*100).toFixed(1)+'%' : '—'}</span></td>
        <td class="col-num"><span class="mp-status-pill ${qSt}">${r.avgQA   != null ? (r.avgQA*100).toFixed(1)+'%'   : '—'}</span></td>
      </tr>`;
    }).join('');

    const colClass = { dual:'mx-detail--dual', 'qa-only':'mx-detail--qa', 'prod-only':'mx-detail--prod', none:'mx-detail--none' };
    panel.className = 'mx-detail ' + (colClass[pt.quad] || '');

    panel.innerHTML = `
      <div class="mx-detail__head">
        <div>
          <div class="mx-detail__name">${esc(pt.a)}</div>
          <div class="mx-detail__mgr">Manager: ${esc(pt.m || '—')}</div>
        </div>
        <button class="mx-detail__close" id="mx-close-btn" type="button" aria-label="Close detail panel">&times;</button>
      </div>
      <div class="mx-detail__kpis">
        <div class="mx-detail__kpi">
          <span class="mx-detail__kpi-label">Quarterly Productivity</span>
          <span class="mx-detail__kpi-val ${pt.prodPct != null ? (pt.prodPct >= PROD_PASS ? 'is-positive' : 'is-negative') : ''}">${pt.prodPct != null ? (pt.prodPct*100).toFixed(1)+'%' : '—'}</span>
        </div>
        <div class="mx-detail__kpi">
          <span class="mx-detail__kpi-label">Quarterly QA</span>
          <span class="mx-detail__kpi-val ${pt.avgQA != null ? (pt.avgQA >= QA_PASS ? 'is-positive' : 'is-negative') : ''}">${pt.avgQA != null ? (pt.avgQA*100).toFixed(1)+'%' : '—'}</span>
        </div>
        <div class="mx-detail__kpi">
          <span class="mx-detail__kpi-label">Status</span>
          <span class="mx-detail__kpi-val">${pt.recStatus ? '★ ' + esc(pt.recStatus) : (pt.quad === 'dual' ? 'Dual Pass' : pt.quad === 'qa-only' ? 'Prod Opportunity' : pt.quad === 'prod-only' ? 'QA Opportunity' : pt.quad === 'none' ? 'Critical Attention' : '—')}</span>
        </div>
      </div>
      <div class="mx-detail__table-wrap">
        <table class="orbit-table lp-table mx-detail__table" aria-label="Monthly performance for ${esc(pt.a)}">
          <thead><tr><th>Month</th><th class="col-num">Productivity</th><th class="col-num">QA</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" class="lp-empty">No monthly data.</td></tr>'}</tbody>
        </table>
      </div>`;

    panel.classList.remove('is-hidden');

    document.getElementById('mx-close-btn').addEventListener('click', () => {
      panel.classList.add('is-hidden');
      MX.selected = null;
      mxRefresh();
    });

    // Re-render to show selection ring
    mxRefresh();
  }

  /* ── Quadrant summary counts ─────────────────────────────── */
  function mxRenderSummary(points) {
    const counts = { dual: 0, 'qa-only': 0, 'prod-only': 0, none: 0, total: 0 };
    points.forEach(p => {
      if (p.quad) { counts[p.quad] = (counts[p.quad] || 0) + 1; counts.total++; }
    });
    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    s('mx-count-dual',     counts.dual);
    s('mx-count-qa-only',  counts['qa-only']);
    s('mx-count-prod-only',counts['prod-only']);
    s('mx-count-none',     counts.none);
    s('mx-count-total',    counts.total);
  }

  /* ── Main refresh entry point ────────────────────────────── */
  function mxRefresh() {
    const allRows = cachedRows();
    const filtered = mxFilterRows(allRows);
    const points   = mxAssocPoints(filtered);
    mxRenderPlot(points);
    mxRenderSummary(points);
  }

  /* ── Populate year selector from data ───────────────────── */
  function mxBuildYearSelect(rows) {
    const sel = document.getElementById('mx-year');
    if (!sel) return;
    const years = mxYears(rows);
    sel.innerHTML = '<option value="all">All Years</option>' +
      years.map(y => `<option value="${y}">${y}</option>`).join('');
    // Default to most recent year that has data
    if (years.length) sel.value = years[years.length - 1];
    MX.year = sel.value;
  }

  function mxBuildManagerSelect(rows) {
    const sel = document.getElementById('mx-manager');
    if (!sel) return;
    const mgrs = [...new Set(rows.map(r => r.m))].filter(Boolean).sort();
    sel.innerHTML = '<option value="all">All Managers</option>' +
      mgrs.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    sel.value = MX.manager;
  }

  /* ── Wire up Performance Matrix controls ─────────────────── */
  function initMatrix() {
    const allRows = cachedRows();
    mxBuildYearSelect(allRows);
    mxBuildManagerSelect(allRows);

    // Quarter pills
    document.querySelectorAll('#mx-qtr-pills .orbit-pill').forEach(b =>
      b.addEventListener('click', () => {
        MX.quarter = b.dataset.mxQtr;
        document.querySelectorAll('#mx-qtr-pills .orbit-pill')
          .forEach(x => x.classList.toggle('is-active', x.dataset.mxQtr === MX.quarter));
        mxRefresh();
      }));

    // Year select
    const ySel = document.getElementById('mx-year');
    if (ySel) ySel.addEventListener('change', () => { MX.year = ySel.value; mxRefresh(); });

    // Manager select
    const mSel = document.getElementById('mx-manager');
    if (mSel) mSel.addEventListener('change', () => { MX.manager = mSel.value; mxRefresh(); });

    // Associate search — debounced so SVG is not rebuilt on every keystroke
    const srch = document.getElementById('mx-search');
    if (srch) srch.addEventListener('input', debounce(() => {
      MX.search = srch.value.trim().toLowerCase();
      mxRefresh();
    }, 160));

    // Initial render
    mxRefresh();

    // Re-render on window resize (SVG is width-driven)
    window.addEventListener('resize', debounce(mxRefresh, 160));
  }

  /* ── Filter control wiring ───────────────────────────────── */
  function syncPipPills() {
    document.querySelectorAll('#lp-pip-pills .orbit-pill').forEach(b =>
      b.classList.toggle('is-active', b.dataset.pipReason === S.pipReason));
  }
  function syncNotePills() {
    document.querySelectorAll('#lp-note-pills .orbit-pill').forEach(b =>
      b.classList.toggle('is-active', b.dataset.noteReason === S.noteReason));
  }
  function syncNoteControls() {
    syncNotePills();
    const mgr = document.getElementById('lp-note-manager'); if (mgr) mgr.value = S.noteMgr;
    const srch = document.getElementById('lp-note-search'); if (srch) srch.value = S.noteSearch;
  }

  function initFilters() {
    document.querySelectorAll('#lp-pip-pills .orbit-pill').forEach(b =>
      b.addEventListener('click', () => { S.pipReason = b.dataset.pipReason; syncPipPills(); renderPIP(); }));
    document.querySelectorAll('#lp-note-pills .orbit-pill').forEach(b =>
      b.addEventListener('click', () => { S.noteReason = b.dataset.noteReason; syncNotePills(); renderNotes(); }));

    const wire = (selId, key, fn) => {
      const el = document.getElementById(selId);
      if (el) el.addEventListener('change', () => { S[key] = el.value; fn(); });
    };
    const wireSearch = (id, key, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', debounce(() => { S[key] = el.value.trim().toLowerCase(); fn(); }, 180));
    };
    wire('lp-pip-manager', 'pipMgr', renderPIP);
    wire('lp-note-manager', 'noteMgr', renderNotes);
    wireSearch('lp-pip-search', 'pipSearch', renderPIP);
    wireSearch('lp-note-search', 'noteSearch', renderNotes);
  }

  /* ── Access gate + sign-in UI ────────────────────────────── */
  function applyAccess() {
    const tab  = document.getElementById('tab-leadership');
    const page = document.getElementById('page-leadership');
    const chip = document.getElementById('orbit-auth-chip');
    const lbl  = document.getElementById('orbit-auth-chip-label');
    const roleBadge = document.getElementById('lp-role-badge');
    const u = AUTH.user();

    if (AUTH.canAccessPortal()) {
      tab.classList.remove('is-hidden');
      lbl.textContent = `${u.am} · ${u.role === 'admin' ? 'Admin' : 'Leadership'}`;
      chip.classList.add('is-authed');
      chip.setAttribute('aria-label', `Signed in as ${u.am} (${u.role}). Click to sign out.`);
      roleBadge.textContent = u.role === 'admin' ? 'Admin Access' : 'Leadership Access';
      roleBadge.className = 'lp-hero__role lp-hero__role--' + u.role;
      renderAll();
    } else {
      const wasVisible = !page.classList.contains('is-hidden');
      tab.classList.add('is-hidden');
      page.classList.add('is-hidden');
      lbl.textContent = 'Leadership Sign-In';
      chip.classList.remove('is-authed');
      chip.setAttribute('aria-label', 'Leadership sign in');
      // If the portal was somehow visible, bounce back to Overview
      if (wasVisible) document.getElementById('tab-overview').click();
    }
  }

  let rendered = false;
  let filtersInit = false;
  let matrixInit = false;
  function renderAll() {
    DATA._rows = null;              // invalidate the row cache
    const rows = cachedRows();
    DATA.pip    = computePIP(rows);
    DATA.rec    = computeRecognition(rows);
    DATA.drafts = buildDrafts(DATA.pip, DATA.rec);
    buildManagerSelect('lp-pip-manager', DATA.pip);
    buildManagerSelect('lp-note-manager', DATA.drafts);
    if (!filtersInit) { initFilters(); filtersInit = true; }

    // Mark all non-summary sub-pages dirty; render only the currently visible one.
    // The summary page always renders (it's the default landing view).
    Object.keys(LP_DIRTY).forEach(k => { LP_DIRTY[k] = true; });
    // Always refresh the My Notes badge immediately (lightweight — just reads localStorage)
    NOTES.updateBadge();

    // Always update the Summary KPI strip + tiles (lightweight DOM writes)
    const scorecard = computeScorecard(rows, DATA.pip, DATA.rec);
    const alerts    = computeAlerts(rows, DATA.pip, DATA.rec, scorecard);
    renderRules();
    if (!matrixInit) { initMatrix(); matrixInit = true; }
    const mgrBelow = scorecard.filter(g =>
      (g.prodPct != null && g.prodPct < PROD_PASS) ||
      (g.avgQA   != null && g.avgQA   < QA_PASS)).length;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    renderEnterpriseKPIs();   // Enterprise Target + Variance (month-scoped planning metrics)
    set('lp-kpi-pip', DATA.pip.length);
    set('lp-kpi-rec', DATA.rec.length);
    set('lp-kpi-alerts', alerts.filter(a => a.sev === 'high').length);
    set('lp-kpi-mgrbelow', mgrBelow);
    set('lp-kpi-notes', DATA.drafts.length);
    set('lp-tile-pip', DATA.pip.length);
    set('lp-tile-rec', DATA.rec.length);
    set('lp-tile-mgr', scorecard.length);
    set('lp-tile-alerts', alerts.length);
    set('lp-tile-notes', DATA.drafts.length);
    set('lp-tile-matrix', rows.reduce((s, r) => r.a ? s.add(r.a) : s, new Set()).size);
    AR.updateSummaryTile();

    // Flush the currently active sub-page immediately
    flushDirty(currentSub);
    rendered = true;
  }

  function initModal() {
    const modal   = document.getElementById('orbit-auth-modal');
    const chip    = document.getElementById('orbit-auth-chip');
    const input   = document.getElementById('orbit-auth-domain');
    const errEl   = document.getElementById('orbit-auth-error');
    const btnGo   = document.getElementById('orbit-auth-submit');
    const btnCancel = document.getElementById('orbit-auth-cancel');

    const open  = () => {
      modal.classList.remove('is-hidden');
      errEl.classList.add('is-hidden');
      input.value = '';
      setTimeout(() => input.focus(), 30);
    };
    const close = () => modal.classList.add('is-hidden');

    chip.addEventListener('click', () => {
      if (AUTH.user()) {
        if (confirm(`Signed in as ${AUTH.user().am} (${AUTH.user().role}).\n\nSign out?`)) {
          AUTH.signOut();
          applyAccess();
        }
      } else {
        open();
      }
    });
    btnCancel.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    const trySignIn = () => {
      const u = AUTH.signIn(input.value);
      if (!u) {
        errEl.textContent = 'Domain ID not found in the ORBIT Leadership roster.';
        errEl.classList.remove('is-hidden');
        return;
      }
      close();
      applyAccess();
      document.getElementById('tab-leadership').click();
    };
    btnGo.addEventListener('click', trySignIn);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') trySignIn(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  function initSubNav() {
    document.querySelectorAll('.lp-subnav__tab').forEach(t =>
      t.addEventListener('click', () => showSub(t.dataset.lpSub)));
    document.querySelectorAll('.lp-tile').forEach(t =>
      t.addEventListener('click', () => showSub(t.dataset.lpGoto)));
  }

  function init() {
    initModal();
    initSubNav();
    applyAccess();           // restores session + shows/hides portal tab
  }

  return { init, applyAccess };
})();

/* ═══════════════════════════════════════════════════════════════════════
   ASSOCIATE RECORDS (AR) MODULE
   ─────────────────────────────────────────────────────────────────────
   Storage  : localStorage key 'orbit_ar_records' (JSON array).
              Exported to ORBIT_Associate_Records.xlsx via CSV download.
   Auth     : write access requires AUTH.role() === 'admin' | 'leadership'
              read-only view available without auth (hides Add button).
   Schema   : { id, assoc, manager, type, category, date, notes,
                enteredBy, enteredAt,
                modifiedBy, modifiedAt }   ← added for audit trail
   ═══════════════════════════════════════════════════════════════════════ */
const AR = (() => {
  const STORE_KEY = 'orbit_ar_records';
  const CATS = ['Productivity','Quality','Attendance','Recognition','Behavior','Leadership','Other'];

  /* ── helpers ── */
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const today = () => new Date().toISOString().slice(0,10);   // YYYY-MM-DD

  /* ── persistence ── */
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
  }
  function save(recs) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(recs)); } catch { /* quota */ }
  }
  function addRecord(rec) {
    const recs = load();
    recs.push(rec);
    save(recs);
  }
  function updateRecord(id, patch) {
    // Merges patch fields into the existing record; preserves enteredBy/At.
    const recs = load();
    const idx  = recs.findIndex(r => r.id === id);
    if (idx === -1) return false;
    recs[idx] = { ...recs[idx], ...patch };
    save(recs);
    return true;
  }
  function deleteRecord(id) {
    const recs = load().filter(r => r.id !== id);
    save(recs);
  }

  /* ── filter state ── */
  const S = { type: 'all', month: 'all', manager: 'all', category: 'all', search: '' };
  let expandedAssoc = null;   // currently open timeline

  /* ── access helpers ── */
  function canWrite() {
    const r = AUTH.role();
    return r === 'admin' || r === 'leadership';
  }
  // Admin can edit/delete any record; leadership can only edit/delete their own.
  function canEditRecord(rec) {
    const u = AUTH.user();
    if (!u) return false;
    if (u.role === 'admin') return true;
    return u.role === 'leadership' && rec.enteredBy === u.am;
  }
  function canDeleteRecord(rec) { return canEditRecord(rec); }

  /* ── Period-aware associate roster ─────────────────────────────────
     Returns one { a, m } entry per associate, where m = the manager
     who managed them during S.month (or, when S.month === 'all', the
     most-recent manager across the full dataset — matching the logic
     in computeAssocTable() used everywhere else in the codebase).

     This is the ONLY correct way to build the roster: D_PROD already
     carries the manager-at-time-of-production on every row, so we
     simply filter to the selected month window and pick the latest ym.
  ── */
  function allAssocs() {
    // Step 1: filter D_PROD to the selected month (or all months)
    const rows = S.month === 'all'
      ? D_PROD.filter(r => r.a)
      : D_PROD.filter(r => r.a && r.ym === S.month);

    // Step 2: group by associate; for each group pick the most-recent ym's manager
    // (handles 'all' correctly when an associate has transferred mid-year)
    const byAssoc = {};
    rows.forEach(r => {
      if (!byAssoc[r.a]) byAssoc[r.a] = [];
      byAssoc[r.a].push(r);
    });

    return Object.entries(byAssoc)
      .map(([a, assocRows]) => {
        const latest = assocRows.reduce((best, r) =>
          (!best || r.ym > best.ym) ? r : best, null);
        return { a, m: latest ? (latest.m || '') : '' };
      })
      .sort((x, y) => x.a.localeCompare(y.a));
  }

  /* ── roster: one row per associate with merit/demerit counts ── */
  function buildRoster() {
    const recs   = load();
    const assocs = allAssocs();

    // Apply filters
    const q = S.search.toLowerCase().trim();
    return assocs
      .map(({ a, m }) => {
        const mine = recs.filter(r => r.assoc === a);
        return {
          a, m,
          merits:   mine.filter(r => r.type === 'merit').length,
          demerits: mine.filter(r => r.type === 'demerit').length,
          last:     mine.length ? mine.sort((x,y) => y.date.localeCompare(x.date))[0].date : null,
        };
      })
      .filter(row => {
        if (S.manager  !== 'all' && row.m !== S.manager) return false;
        if (S.type === 'merit'   && row.merits   === 0)  return false;
        if (S.type === 'demerit' && row.demerits === 0)  return false;
        if (q && !row.a.toLowerCase().includes(q))        return false;
        return true;
      });
  }

  /* ── render the roster table ── */
  function renderRoster() {
    const tbody = document.getElementById('ar-roster-tbody');
    if (!tbody) return;
    const rows = buildRoster();

    // Read-only banner
    const banner = document.getElementById('ar-readonly-banner');
    if (banner) banner.classList.toggle('is-hidden', canWrite());

    // Add-record button visibility
    const addBtn = document.getElementById('ar-add-btn');
    if (addBtn) addBtn.classList.toggle('is-hidden', !canWrite());

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="lp-empty">No associates match the current filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(row => {
      const isExpanded = expandedAssoc === row.a;
      const lastStr    = row.last
        ? new Date(row.last + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
        : '—';
      return `<tr class="ar-roster-row${isExpanded ? ' is-expanded' : ''}" data-assoc="${esc(row.a)}" tabindex="0"
                  title="View timeline for ${esc(row.a)}">
        <td class="col-associate">${esc(row.a)}</td>
        <td class="col-manager">${esc(row.m || '—')}</td>
        <td class="col-num">
          ${row.merits > 0
            ? `<span class="ar-badge ar-badge--merit">${row.merits}</span>`
            : `<span class="ar-badge ar-badge--zero">0</span>`}
        </td>
        <td class="col-num">
          ${row.demerits > 0
            ? `<span class="ar-badge ar-badge--demerit">${row.demerits}</span>`
            : `<span class="ar-badge ar-badge--zero">0</span>`}
        </td>
        <td class="ar-col-last">${esc(lastStr)}</td>
        <td><button class="orbit-btn orbit-btn--ghost ar-view-btn" data-assoc="${esc(row.a)}"
                    type="button">View Record</button></td>
      </tr>`;
    }).join('');

    // Row click / View Record button — both open the timeline
    tbody.querySelectorAll('.ar-roster-row').forEach(tr => {
      tr.addEventListener('click', e => {
        if (e.target.classList.contains('ar-view-btn')) return;  // handled below
        openTimeline(tr.dataset.assoc);
      });
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') openTimeline(tr.dataset.assoc); });
    });
    tbody.querySelectorAll('.ar-view-btn').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); openTimeline(btn.dataset.assoc); }));
  }

  /* ── timeline panel ── */
  function openTimeline(assocName) {
    expandedAssoc = assocName;
    const recs   = load().filter(r => r.assoc === assocName).sort((a,b) => b.date.localeCompare(a.date));
    const assocs = allAssocs();
    const info   = assocs.find(x => x.a === assocName) || { m: '—' };

    const panel    = document.getElementById('ar-timeline-panel');
    const nameEl   = document.getElementById('ar-timeline-name');
    const mgrEl    = document.getElementById('ar-timeline-mgr');
    const meritsEl = document.getElementById('ar-timeline-merits');
    const demeEl   = document.getElementById('ar-timeline-demerits');
    const tl       = document.getElementById('ar-timeline');

    if (!panel) return;
    nameEl.textContent   = assocName;
    mgrEl.textContent    = info.m;
    meritsEl.textContent = recs.filter(r => r.type === 'merit').length   + ' Merits';
    demeEl.textContent   = recs.filter(r => r.type === 'demerit').length + ' Demerits';

    if (!recs.length) {
      tl.innerHTML = '<div class="ar-timeline__empty">No records on file for this associate yet.</div>';
    } else {
      tl.innerHTML = recs.map(r => {
        const dateStr = new Date(r.date + 'T00:00:00').toLocaleDateString('en-US',
          { weekday:'short', month:'long', day:'numeric', year:'numeric' });

        // Audit trail: created / modified lines
        const createdStr = r.enteredAt
          ? new Date(r.enteredAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
          : '—';
        const modStr = r.modifiedBy
          ? `<span class="ar-timeline__audit ar-timeline__audit--mod">Modified by ${esc(r.modifiedBy)} on ${
              new Date(r.modifiedAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
            }</span>`
          : '';

        // Per-record action buttons — only shown if signed in with permission
        const editBtn = canEditRecord(r)
          ? `<button class="orbit-btn orbit-btn--ghost ar-item-edit" data-rec-id="${esc(r.id)}"
                     type="button" aria-label="Edit this record">Edit</button>`
          : '';
        const delBtn = canDeleteRecord(r)
          ? `<button class="orbit-btn ar-item-delete" data-rec-id="${esc(r.id)}"
                     type="button" aria-label="Delete this record">Delete</button>`
          : '';
        const actBar = (editBtn || delBtn)
          ? `<div class="ar-timeline__actions">${editBtn}${delBtn}</div>`
          : '';

        return `<div class="ar-timeline__item ar-timeline__item--${esc(r.type)}" role="listitem"
                     data-rec-id="${esc(r.id)}">
          <div class="ar-timeline__dot" aria-hidden="true"></div>
          <div class="ar-timeline__content">
            <div class="ar-timeline__head">
              <span class="ar-badge ar-badge--${esc(r.type)}">${r.type === 'merit' ? 'Merit' : 'Demerit'}</span>
              <span class="ar-timeline__cat">${esc(r.category)}</span>
              <span class="ar-timeline__date">${esc(dateStr)}</span>
            </div>
            <p class="ar-timeline__notes">${esc(r.notes)}</p>
            <div class="ar-timeline__audit-row">
              <span class="ar-timeline__audit">Created by ${esc(r.enteredBy)} &middot; ${esc(createdStr)}</span>
              ${modStr}
            </div>
            ${actBar}
          </div>
        </div>`;
      }).join('');

      // Wire Edit/Delete buttons after DOM insertion
      tl.querySelectorAll('.ar-item-edit').forEach(btn =>
        btn.addEventListener('click', () => openEditModal(btn.dataset.recId)));
      tl.querySelectorAll('.ar-item-delete').forEach(btn =>
        btn.addEventListener('click', () => confirmDelete(btn.dataset.recId)));
    }

    // "Add Record for This Associate" — pre-fills modal
    const addForBtn = document.getElementById('ar-add-for-btn');
    if (addForBtn) {
      addForBtn.classList.toggle('is-hidden', !canWrite());
      addForBtn.onclick = () => openModal(assocName);
    }

    panel.classList.remove('is-hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Highlight the expanded row
    renderRoster();
  }

  /* ── modal ── */
  let modalContext = null;   // assoc pre-fill if launched from PIP/Rec
  let editingId    = null;   // non-null when editing an existing record

  /* Shared helper: populate and show the modal.
     mode = 'add' | 'edit'
     rec  = existing record object when mode === 'edit', else null  */
  function _openModal(mode, rec, preAssoc) {
    if (!canWrite()) return;
    const modal = document.getElementById('ar-modal');
    if (!modal) return;

    editingId = mode === 'edit' ? rec.id : null;

    // Title
    const titleEl = document.getElementById('ar-modal-title');
    if (titleEl) titleEl.textContent = mode === 'edit' ? 'Edit Performance Record' : 'Add Performance Record';

    // Associate dropdown — locked in edit mode (can't change who the record belongs to)
    const sel    = document.getElementById('ar-modal-assoc');
    const assocs = allAssocs();
    sel.innerHTML = '<option value="">Select associate&hellip;</option>' +
      assocs.map(x => `<option value="${esc(x.a)}">${esc(x.a)}</option>`).join('');
    if (mode === 'edit') {
      sel.value    = rec.assoc;
      sel.disabled = true;
      sel.title    = 'Associate cannot be changed when editing a record.';
    } else {
      sel.disabled = false;
      sel.title    = '';
      if (preAssoc) sel.value = preAssoc;
    }

    // Type
    document.querySelectorAll('input[name="ar-type"]').forEach(r => {
      r.checked = mode === 'edit' ? r.value === rec.type : false;
    });

    // Category, date, notes
    document.getElementById('ar-modal-cat').value   = mode === 'edit' ? (rec.category || '') : '';
    document.getElementById('ar-modal-date').value  = mode === 'edit' ? rec.date : today();
    document.getElementById('ar-modal-notes').value = mode === 'edit' ? (rec.notes || '') : '';
    const notes = document.getElementById('ar-modal-notes');
    document.getElementById('ar-modal-char').textContent = (notes.value.length) + ' / 1000';

    // Audit trail — "Entered By"
    const u = AUTH.user();
    if (mode === 'edit') {
      document.getElementById('ar-modal-enteredby').textContent =
        rec.enteredBy + ' on ' + new Date(rec.enteredAt).toLocaleDateString('en-US',
          { month:'short', day:'numeric', year:'numeric' });
    } else {
      document.getElementById('ar-modal-enteredby').textContent = u ? `${u.am} (${u.role})` : '—';
    }

    // Modified By row — show only in edit mode (or if previously modified)
    const modRow = document.getElementById('ar-modal-modified-row');
    if (modRow) {
      if (mode === 'edit' && rec.modifiedBy) {
        modRow.classList.remove('is-hidden');
        document.getElementById('ar-modal-modifiedby').textContent =
          rec.modifiedBy + ' on ' + new Date(rec.modifiedAt).toLocaleDateString('en-US',
            { month:'short', day:'numeric', year:'numeric' });
      } else {
        modRow.classList.add('is-hidden');
      }
    }

    document.getElementById('ar-modal-error').classList.add('is-hidden');
    modalContext = preAssoc || null;
    modal.classList.remove('is-hidden');
    setTimeout(() => (mode === 'edit' ? document.getElementById('ar-modal-cat') : sel).focus(), 30);
  }

  function openModal(preAssoc = null)   { _openModal('add',  null, preAssoc); }
  function openEditModal(recId) {
    const rec = load().find(r => r.id === recId);
    if (!rec) return;
    if (!canEditRecord(rec)) {
      alert('You do not have permission to edit this record.');
      return;
    }
    _openModal('edit', rec, null);
  }

  function closeModal() {
    const modal = document.getElementById('ar-modal');
    if (modal) modal.classList.add('is-hidden');
    editingId = null;
    // Re-enable associate select in case it was locked
    const sel = document.getElementById('ar-modal-assoc');
    if (sel) { sel.disabled = false; sel.title = ''; }
  }

  function saveModal() {
    const assocEl  = document.getElementById('ar-modal-assoc');
    const assoc    = assocEl.value.trim();
    const typeEl   = document.querySelector('input[name="ar-type"]:checked');
    const type     = typeEl ? typeEl.value : '';
    const category = document.getElementById('ar-modal-cat').value;
    const date     = document.getElementById('ar-modal-date').value;
    const notes    = document.getElementById('ar-modal-notes').value.trim();
    const errEl    = document.getElementById('ar-modal-error');
    const u        = AUTH.user();

    // Validation
    const errs = [];
    if (!assoc)    errs.push('Please select an associate.');
    if (!type)     errs.push('Please choose Merit or Demerit.');
    if (!category) errs.push('Please select a category.');
    if (!date)     errs.push('Please enter a date.');
    if (!notes)    errs.push('Please enter a write-up.');

    if (errs.length) {
      errEl.textContent = errs[0];
      errEl.classList.remove('is-hidden');
      return;
    }
    errEl.classList.add('is-hidden');

    if (editingId) {
      /* ── EDIT PATH ── patch mutable fields; preserve enteredBy/At */
      updateRecord(editingId, {
        type, category, date, notes,
        modifiedBy: u ? u.am : 'Unknown',
        modifiedAt: new Date().toISOString(),
      });
      closeModal();
      renderRoster();
      updateSummaryTile();
      if (expandedAssoc) openTimeline(expandedAssoc);
    } else {
      /* ── ADD PATH ── create brand new record */
      const assocInfo = allAssocs().find(x => x.a === assoc);
      addRecord({
        id:          uid(),
        assoc,
        manager:     assocInfo ? assocInfo.m : '',
        type, category, date, notes,
        enteredBy:   u ? u.am : 'Unknown',
        enteredAt:   new Date().toISOString(),
        modifiedBy:  null,
        modifiedAt:  null,
      });
      closeModal();
      renderRoster();
      updateSummaryTile();
      if (expandedAssoc === assoc || modalContext === assoc) openTimeline(assoc);
    }
  }

  /* ── delete with confirmation dialog ── */
  function confirmDelete(recId) {
    const recs = load();
    const rec  = recs.find(r => r.id === recId);
    if (!rec) return;
    if (!canDeleteRecord(rec)) {
      alert('You do not have permission to delete this record.');
      return;
    }
    // Show inline confirmation overlay on the timeline item
    const itemEl = document.querySelector(`[data-rec-id="${CSS.escape(recId)}"]`);
    if (itemEl) {
      // If already showing confirmation, cancel it
      const existing = itemEl.querySelector('.ar-del-confirm');
      if (existing) { existing.remove(); return; }

      const bar = document.createElement('div');
      bar.className = 'ar-del-confirm';
      bar.setAttribute('role', 'alert');
      bar.innerHTML = `<span class="ar-del-confirm__msg">Delete this record? This cannot be undone.</span>
        <button class="orbit-btn orbit-btn--primary ar-del-confirm__ok"  type="button">Delete</button>
        <button class="orbit-btn orbit-btn--ghost   ar-del-confirm__no"  type="button">Cancel</button>`;
      itemEl.appendChild(bar);

      bar.querySelector('.ar-del-confirm__ok').addEventListener('click', () => {
        deleteRecord(recId);
        renderRoster();
        updateSummaryTile();
        if (expandedAssoc) openTimeline(expandedAssoc);
      });
      bar.querySelector('.ar-del-confirm__no').addEventListener('click', () => bar.remove());
    } else {
      // Fallback if element not found (shouldn't happen)
      if (!confirm('Delete this record? This cannot be undone.')) return;
      deleteRecord(recId);
      renderRoster();
      updateSummaryTile();
      if (expandedAssoc) openTimeline(expandedAssoc);
    }
  }

  /* ── CSV export to ORBIT_Associate_Records.xlsx (CSV download) ── */
  function exportRecords() {
    const recs = load();
    if (!recs.length) { alert('No records to export.'); return; }
    const header = ['ID','Associate','Manager','Type','Category','Date','Notes',
                    'Created By','Created At','Modified By','Modified At'];
    const rows   = recs.map(r => [r.id, r.assoc, r.manager, r.type, r.category, r.date,
      '"' + (r.notes || '').replace(/"/g,'""') + '"',
      r.enteredBy, r.enteredAt,
      r.modifiedBy || '', r.modifiedAt || ''].join(','));
    const csv  = [header.join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a    = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: 'ORBIT_Associate_Records.csv'
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /* ── summary tile count ── */
  function updateSummaryTile() {
    const recs   = load();
    const assocs = new Set(recs.map(r => r.assoc));
    const el     = document.getElementById('lp-tile-ar');
    if (el) el.textContent = assocs.size;
  }

  /* ── filter controls sync ── */
  function syncFilters() {
    document.querySelectorAll('#ar-type-pills [data-ar-type]').forEach(btn =>
      btn.classList.toggle('is-active', btn.dataset.arType === S.type));
    const mo  = document.getElementById('ar-month');
    if (mo)  mo.value  = S.month;
    const mgr = document.getElementById('ar-manager');
    if (mgr) mgr.value = S.manager;
    const cat = document.getElementById('ar-category');
    if (cat) cat.value = S.category;
    const srch = document.getElementById('ar-search');
    if (srch) srch.value = S.search;
  }

  function populateMonthSelect() {
    const sel = document.getElementById('ar-month');
    if (!sel) return;
    // Derive available months from D_PROD (same source of truth as Overview pills)
    const months = [...new Set(D_PROD.map(r => r.ym).filter(Boolean))].sort();
    const keep   = sel.value || 'all';
    sel.innerHTML = '<option value="all">All Months</option>' +
      months.map(ym => `<option value="${esc(ym)}">${esc(ym)}</option>`).join('');
    sel.value = months.includes(keep) ? keep : 'all';
  }

  function populateManagerSelect() {
    const sel = document.getElementById('ar-manager');
    if (!sel) return;
    // allAssocs() already respects S.month, so managers shown are only those
    // active in the selected month — prevents stale manager names from appearing.
    const mgrs = [...new Set(allAssocs().map(x => x.m).filter(Boolean))].sort();
    const keep = sel.value || 'all';
    sel.innerHTML = '<option value="all">All Managers</option>' +
      mgrs.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    // If previously-selected manager is no longer active in the new month, reset to 'all'
    sel.value = mgrs.includes(keep) ? keep : 'all';
    S.manager = sel.value;
  }

  /* ── wire controls (called once on first subpage visit) ── */
  let filtersWired = false;
  function wireControls() {
    if (filtersWired) return;
    filtersWired = true;

    // Type pills
    document.querySelectorAll('#ar-type-pills [data-ar-type]').forEach(btn =>
      btn.addEventListener('click', () => {
        S.type = btn.dataset.arType;
        syncFilters(); renderRoster();
      }));

    // Month select — changing month re-derives the manager list, then re-renders
    const moSel = document.getElementById('ar-month');
    if (moSel) moSel.addEventListener('change', () => {
      S.month = moSel.value;
      // Re-populate manager dropdown to show only managers active in the new month
      populateManagerSelect();
      syncFilters();
      renderRoster();
    });

    // Manager select
    const mgrSel = document.getElementById('ar-manager');
    if (mgrSel) mgrSel.addEventListener('change', () => { S.manager = mgrSel.value; renderRoster(); });

    // Category select
    const catSel = document.getElementById('ar-category');
    if (catSel) catSel.addEventListener('change', () => { S.category = catSel.value; renderRoster(); });

    // Search (debounced)
    const srch = document.getElementById('ar-search');
    if (srch) {
      let t; srch.addEventListener('input', () => {
        clearTimeout(t); t = setTimeout(() => { S.search = srch.value; renderRoster(); }, 220);
      });
    }

    // Add Record button
    const addBtn = document.getElementById('ar-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => openModal());

    // Timeline close
    const closeBtn = document.getElementById('ar-timeline-close');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      expandedAssoc = null;
      document.getElementById('ar-timeline-panel').classList.add('is-hidden');
      renderRoster();
    });

    // Modal controls
    const modal    = document.getElementById('ar-modal');
    const saveBtn  = document.getElementById('ar-modal-save');
    const cancelBtn = document.getElementById('ar-modal-cancel');
    const closeX   = document.getElementById('ar-modal-close');
    if (saveBtn)   saveBtn.addEventListener('click',   saveModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    if (closeX)    closeX.addEventListener('click',    closeModal);
    if (modal)     modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal && !modal.classList.contains('is-hidden')) closeModal();
    });

    // Character counter
    const notesTA = document.getElementById('ar-modal-notes');
    const charEl  = document.getElementById('ar-modal-char');
    if (notesTA && charEl) {
      notesTA.addEventListener('input', () => {
        charEl.textContent = notesTA.value.length + ' / 1000';
      });
    }

    populateManagerSelect();
  }

  /* ── public entry: called by LP flushDirty / first visit ── */
  function render() {
    wireControls();
    populateMonthSelect();
    populateManagerSelect();
    renderRoster();
    updateSummaryTile();
  }

  /* ── public: open modal pre-filled for a specific associate (from PIP/Rec) ── */
  function addRecordFor(assocName) {
    if (!canWrite()) return;
    // Navigate to AR subpage first
    document.querySelector('[data-lp-sub="ar"]')?.click();
    setTimeout(() => openModal(assocName), 80);
  }

  return { render, addRecordFor, exportRecords, updateSummaryTile };
})();

/* ═══════════════════════════════════════════════════════════════════════
   MY NOTES (NOTES) MODULE
   ─────────────────────────────────────────────────────────────────────
   Purpose  : Personal leadership workspace — private per logged-in DOMAIN.
   Storage  : localStorage key 'orbit_notes_<DOMAIN>' (JSON array).
              Scoped per domain — users only ever see their own tasks.
              Exported to ORBIT_Notes.csv on demand.
   Auth     : Requires AUTH.role() === 'admin' | 'leadership'.
   Schema   : { id, domain, task, priority, due, status, notes,
                createdBy, createdAt, modifiedBy, modifiedAt }
   Future   : createdBy/modifiedBy/email fields ready for reminder emails.
   ═══════════════════════════════════════════════════════════════════════ */
const NOTES = (() => {

  /* ── helpers ── */
  const esc    = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const uid    = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const todayY = () => new Date().toISOString().slice(0,10);   // YYYY-MM-DD
  const fmtDate = iso => {
    if (!iso) return '—';
    const [y,m,d] = iso.split('-');
    return `${+m}/${+d}/${y}`;
  };

  /* ── storage key — scoped per domain ── */
  function storeKey() {
    const u = AUTH.user();
    return u ? `orbit_notes_${u.domain.toUpperCase()}` : null;
  }

  /* ── persistence ── */
  function load() {
    const k = storeKey();
    if (!k) return [];
    try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; }
  }
  function save(tasks) {
    const k = storeKey();
    if (!k) return;
    try { localStorage.setItem(k, JSON.stringify(tasks)); } catch { /* quota */ }
  }
  function addTask(t) {
    const tasks = load(); tasks.push(t); save(tasks);
  }
  function updateTask(id, patch) {
    const tasks = load();
    const idx   = tasks.findIndex(t => t.id === id);
    if (idx === -1) return false;
    tasks[idx] = { ...tasks[idx], ...patch };
    save(tasks); return true;
  }
  function deleteTask(id) {
    save(load().filter(t => t.id !== id));
  }

  /* ── overdue logic ── */
  function isOverdue(t) {
    if (!t.due || t.status === 'completed' || t.status === 'archived') return false;
    return t.due < todayY();
  }

  /* ── filter state ── */
  const S = { status: 'all', priority: 'all', search: '' };
  let editingId = null;

  /* ── filter + sort ── */
  function filtered() {
    const q = S.search.toLowerCase().trim();
    return load().filter(t => {
      if (S.status   !== 'all' && t.status   !== S.status)   return false;
      if (S.priority !== 'all' && t.priority !== S.priority) return false;
      if (q && !(t.task + ' ' + (t.notes||'')).toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      // Overdue first, then by due date ascending, then by priority weight
      const aOvr = isOverdue(a) ? 0 : 1;
      const bOvr = isOverdue(b) ? 0 : 1;
      if (aOvr !== bOvr) return aOvr - bOvr;
      const priW = { high: 0, medium: 1, low: 2 };
      const aP = priW[a.priority] ?? 1;
      const bP = priW[b.priority] ?? 1;
      if (aP !== bP) return aP - bP;
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return  1;
      return 0;
    });
  }

  /* ── build overdue count across ALL tasks (not just filtered) ── */
  function overdueCount() {
    return load().filter(isOverdue).length;
  }

  /* ── badge + banner ── */
  function updateBadge() {
    const n      = overdueCount();
    const badge  = document.getElementById('mn-tab-badge');
    const banner = document.getElementById('mn-overdue-banner');
    const text   = document.getElementById('mn-overdue-text');
    const hdrSub = document.getElementById('mn-header-sub');
    const total  = load().length;

    if (badge) {
      badge.textContent = n > 0 ? n : '';
      badge.classList.toggle('is-hidden', n === 0);
    }
    if (banner) banner.classList.toggle('is-hidden', n === 0);
    if (text)   text.textContent = n === 1
      ? '1 task is overdue.'
      : `${n} tasks are overdue.`;
    if (hdrSub) {
      const u = AUTH.user();
      const name = u ? u.am : 'You';
      const open = load().filter(t => t.status === 'open').length;
      hdrSub.textContent = `${name} · ${open} open · ${n} overdue`;
    }
  }

  /* ── render task list ── */
  function priorityLabel(p) {
    return { high: 'High', medium: 'Medium', low: 'Low' }[p] || p;
  }
  function statusLabel(s) {
    return { open: 'Open', completed: 'Completed', archived: 'Archived' }[s] || s;
  }

  function taskCardHtml(t) {
    const overdue = isOverdue(t);
    const classes = [
      'mn-card',
      `mn-card--${t.priority || 'medium'}`,
      `mn-card--${t.status || 'open'}`,
      overdue ? 'mn-card--overdue' : ''
    ].filter(Boolean).join(' ');

    const dueLine = t.due
      ? `<span class="mn-card__due ${overdue ? 'mn-card__due--overdue' : ''}">
           ${overdue ? '<span class="mn-overdue-flag" aria-label="Overdue">&#x26A0;</span> Overdue &mdash; ' : ''}Due ${fmtDate(t.due)}
         </span>`
      : '';

    const notesLine = t.notes
      ? `<div class="mn-card__notes">${esc(t.notes)}</div>`
      : '';

    return `
    <div class="${classes}" role="listitem" data-mn-id="${esc(t.id)}">
      <div class="mn-card__head">
        <span class="mn-pri-badge mn-pri-badge--${t.priority || 'medium'}">${priorityLabel(t.priority)}</span>
        <span class="mn-status-chip mn-status-chip--${t.status || 'open'}">${statusLabel(t.status)}</span>
        ${dueLine}
      </div>
      <div class="mn-card__task">${esc(t.task)}</div>
      ${notesLine}
      <div class="mn-card__footer">
        <span class="mn-card__meta">Added ${fmtDate(t.createdAt ? t.createdAt.slice(0,10) : '')}</span>
        <div class="mn-card__actions">
          ${t.status !== 'completed'
            ? `<button class="mn-action-btn mn-action-btn--complete" data-mn-action="complete" data-mn-id="${esc(t.id)}" title="Mark Complete">&#10003; Complete</button>`
            : `<button class="mn-action-btn mn-action-btn--reopen"   data-mn-action="reopen"   data-mn-id="${esc(t.id)}" title="Reopen">&#8635; Reopen</button>`}
          ${t.status !== 'archived'
            ? `<button class="mn-action-btn mn-action-btn--archive"  data-mn-action="archive"  data-mn-id="${esc(t.id)}" title="Archive">&#x1F4C2; Archive</button>`
            : ''}
          <button class="mn-action-btn mn-action-btn--edit"   data-mn-action="edit"   data-mn-id="${esc(t.id)}" title="Edit">&#9998; Edit</button>
          <button class="mn-action-btn mn-action-btn--delete" data-mn-action="delete" data-mn-id="${esc(t.id)}" title="Delete">&#x2715; Delete</button>
        </div>
      </div>
    </div>`;
  }

  function render() {
    const list = document.getElementById('mn-list');
    if (!list) return;
    const tasks = filtered();
    if (!tasks.length) {
      const u = AUTH.user();
      if (!u) {
        list.innerHTML = '<div class="mn-empty">Sign in to the Leadership Portal to view your tasks.</div>';
      } else {
        list.innerHTML = '<div class="mn-empty">No tasks match the current filters.</div>';
      }
    } else {
      list.innerHTML = tasks.map(taskCardHtml).join('');
    }
    updateBadge();
    wireCardActions();
  }

  /* ── wire card action buttons ── */
  function wireCardActions() {
    const list = document.getElementById('mn-list');
    if (!list) return;
    list.querySelectorAll('[data-mn-action]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id     = btn.dataset.mnId;
        const action = btn.dataset.mnAction;
        const u      = AUTH.user();
        const by     = u ? u.am : '—';
        const now    = new Date().toISOString();
        if (action === 'complete') {
          updateTask(id, { status: 'completed', modifiedBy: by, modifiedAt: now });
          render();
        } else if (action === 'reopen') {
          updateTask(id, { status: 'open', modifiedBy: by, modifiedAt: now });
          render();
        } else if (action === 'archive') {
          updateTask(id, { status: 'archived', modifiedBy: by, modifiedAt: now });
          render();
        } else if (action === 'edit') {
          openEditModal(id);
        } else if (action === 'delete') {
          confirmDeleteTask(id);
        }
      });
    });
  }

  /* ── inline delete confirmation ── */
  function confirmDeleteTask(id) {
    const card = document.querySelector(`[data-mn-id="${id}"].mn-card`);
    if (!card) return;
    if (card.querySelector('.mn-del-confirm')) return;   // already open

    const bar = document.createElement('div');
    bar.className = 'mn-del-confirm';
    bar.innerHTML =
      '<span>Delete this task? This cannot be undone.</span>' +
      `<button class="mn-del-yes orbit-btn orbit-btn--danger" type="button">Delete</button>` +
      `<button class="mn-del-no  orbit-btn orbit-btn--ghost"  type="button">Cancel</button>`;
    card.appendChild(bar);

    bar.querySelector('.mn-del-yes').addEventListener('click', () => {
      deleteTask(id); render();
    });
    bar.querySelector('.mn-del-no').addEventListener('click', () => {
      bar.remove();
    });
  }

  /* ── modal ── */
  function openModal() {
    editingId = null;
    const u = AUTH.user();
    if (!u) return;

    document.getElementById('mn-modal-title').textContent = 'New Task';
    document.getElementById('mn-task').value    = '';
    document.getElementById('mn-priority').value = 'medium';
    document.getElementById('mn-due').value      = '';
    document.getElementById('mn-status').value   = 'open';
    document.getElementById('mn-notes').value    = '';
    document.getElementById('mn-audit-row').classList.add('is-hidden');
    document.getElementById('mn-modal-meta').textContent = '';
    document.getElementById('mn-modal').classList.remove('is-hidden');
    document.getElementById('mn-task').focus();
  }

  function openEditModal(id) {
    const t = load().find(x => x.id === id);
    if (!t) return;
    editingId = id;

    document.getElementById('mn-modal-title').textContent = 'Edit Task';
    document.getElementById('mn-task').value     = t.task    || '';
    document.getElementById('mn-priority').value = t.priority || 'medium';
    document.getElementById('mn-due').value      = t.due     || '';
    document.getElementById('mn-status').value   = t.status  || 'open';
    document.getElementById('mn-notes').value    = t.notes   || '';

    // Audit trail
    const auditRow = document.getElementById('mn-audit-row');
    auditRow.classList.remove('is-hidden');
    document.getElementById('mn-audit-created-by').textContent = t.createdBy || '—';
    document.getElementById('mn-audit-created-at').textContent = t.createdAt ? t.createdAt.slice(0,10) : '—';
    const modWrap = document.getElementById('mn-audit-modified-wrap');
    if (t.modifiedBy) {
      modWrap.classList.remove('is-hidden');
      document.getElementById('mn-audit-modified-by').textContent = t.modifiedBy;
      document.getElementById('mn-audit-modified-at').textContent = t.modifiedAt ? t.modifiedAt.slice(0,10) : '—';
    } else {
      modWrap.classList.add('is-hidden');
    }

    document.getElementById('mn-modal-meta').textContent = '';
    document.getElementById('mn-modal').classList.remove('is-hidden');
    document.getElementById('mn-task').focus();
  }

  function closeModal() {
    document.getElementById('mn-modal').classList.add('is-hidden');
    editingId = null;
  }

  function saveModal() {
    const taskVal = (document.getElementById('mn-task').value || '').trim();
    if (!taskVal) {
      document.getElementById('mn-modal-meta').textContent = 'Task description is required.';
      document.getElementById('mn-task').focus();
      return;
    }
    const u   = AUTH.user();
    const by  = u ? u.am : '—';
    const now = new Date().toISOString();

    if (editingId) {
      updateTask(editingId, {
        task:       taskVal,
        priority:   document.getElementById('mn-priority').value,
        due:        document.getElementById('mn-due').value,
        status:     document.getElementById('mn-status').value,
        notes:      document.getElementById('mn-notes').value.trim(),
        modifiedBy: by,
        modifiedAt: now,
      });
    } else {
      addTask({
        id:        uid(),
        domain:    u ? u.domain.toUpperCase() : '—',
        task:      taskVal,
        priority:  document.getElementById('mn-priority').value,
        due:       document.getElementById('mn-due').value,
        status:    document.getElementById('mn-status').value,
        notes:     document.getElementById('mn-notes').value.trim(),
        createdBy: by,
        createdAt: now,
        modifiedBy: '',
        modifiedAt: '',
        // Future: email field for reminder integration
        email:     u ? (u.email || '') : '',
      });
    }
    closeModal();
    render();
  }

  /* ── CSV export ── */
  function exportTasks() {
    const tasks = load();
    if (!tasks.length) { alert('No tasks to export.'); return; }
    const header = ['ID','Domain','Task','Priority','Due Date','Status','Notes',
                    'Created By','Created At','Modified By','Modified At','Email'];
    const rows = tasks.map(t => [
      t.id, t.domain,
      `"${(t.task   ||'').replace(/"/g,'""')}"`,
      t.priority, t.due || '', t.status,
      `"${(t.notes  ||'').replace(/"/g,'""')}"`,
      t.createdBy  || '', t.createdAt  ? t.createdAt.slice(0,10)  : '',
      t.modifiedBy || '', t.modifiedAt ? t.modifiedAt.slice(0,10) : '',
      t.email || '',
    ].join(','));
    const csv  = [header.join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a    = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `ORBIT_Notes_${(AUTH.user()||{domain:'unknown'}).domain}_${todayY()}.csv`,
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /* ── wire controls ── */
  function initControls() {
    // Add button
    const addBtn = document.getElementById('mn-add-btn');
    if (addBtn) addBtn.addEventListener('click', openModal);

    // Export
    const expBtn = document.getElementById('mn-export-btn');
    if (expBtn) expBtn.addEventListener('click', exportTasks);

    // Modal close
    document.getElementById('mn-modal-close')?.addEventListener('click', closeModal);
    document.getElementById('mn-modal-cancel')?.addEventListener('click', closeModal);
    document.getElementById('mn-modal-save')?.addEventListener('click', saveModal);

    // Backdrop click closes
    document.getElementById('mn-modal')?.addEventListener('click', e => {
      if (e.target === document.getElementById('mn-modal')) closeModal();
    });

    // Escape closes modal
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !document.getElementById('mn-modal')?.classList.contains('is-hidden')) {
        closeModal();
      }
    });

    // Filter controls
    document.getElementById('mn-filter-status')?.addEventListener('change', e => {
      S.status = e.target.value; render();
    });
    document.getElementById('mn-filter-priority')?.addEventListener('change', e => {
      S.priority = e.target.value; render();
    });
    let searchTimer;
    document.getElementById('mn-search')?.addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { S.search = e.target.value; render(); }, 220);
    });
  }

  /* ── public init ── */
  function init() {
    initControls();
    render();
  }

  return { init, render, updateBadge };
})();

document.addEventListener('DOMContentLoaded', () => {
  LP.init();
  NOTES.init();   // My Notes module — wires controls, renders badge from localStorage
});


