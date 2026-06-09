/* Mongi admin dashboard — fetches aggregated BigQuery data via the
 * getDashboardData cloud function and renders it as Chart.js charts.
 *
 * Token is stored in localStorage. No real auth — purely an
 * obscurity gate against random visitors. If the token leaks, rotate it
 * via `firebase functions:secrets:set DASHBOARD_TOKEN` and the old one
 * stops working on next deploy.
 */

const ENDPOINT = 'https://europe-west1-mongi-1ed14.cloudfunctions.net/getDashboardData';
const TOKEN_KEY = 'mongi_dashboard_token';

const COLORS = {
  mint: '#14B8A6',
  mintLight: '#5EEAD4',
  rose: '#FF6B9D',
  amber: '#F59E0B',
  ink: '#0F172A',
  muted: '#94A3B8',
  border: '#E2E8F0',
  ios: '#0F172A',          // ink — Apple-y
  android: '#22C55E',      // forest — Android-y
  harmonyos: '#3B82F6',    // ocean blue — Huawei-y
  unknown: '#94A3B8',
};

const PLATFORM_LABEL = {
  ios: 'iOS',
  android: 'Android',
  harmonyos: 'HarmonyOS',
  unknown: 'Unknown',
};

// Chart.js global defaults — match site typography
Chart.defaults.font.family = '-apple-system, "SF Pro Display", "Segoe UI", Inter, Roboto, system-ui, sans-serif';
Chart.defaults.color = '#475569';
Chart.defaults.borderColor = COLORS.border;

const $ = (sel) => document.querySelector(sel);

// For horizontal bar charts: size the canvas based on row count so every
// label gets enough vertical space, but CAP at 700px to keep the backing
// pixel buffer (canvas memory × devicePixelRatio²) from blowing up the tab
// on high-DPI displays. 700px ÷ 30 rows ≈ 23px per label which is enough
// to read game names without scrolling forever.
function fitHorizontalBars(canvasId, rowCount, perRow = 22, minHeight = 220, maxHeight = 700) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const desired = Math.min(maxHeight, Math.max(minHeight, rowCount * perRow + 60));
  canvas.style.height = `${desired}px`;
  // Set max-height explicitly to the same value (rather than 'none') so the
  // card CSS doesn't lift the cap globally on subsequent re-renders.
  canvas.style.maxHeight = `${desired}px`;
}

// ─── Token gate ──────────────────────────────────────────────────────

function showGate() { $('#gate').style.display = 'flex'; }
function hideGate() { $('#gate').style.display = 'none'; }

$('#tokenSubmit').addEventListener('click', () => {
  const t = $('#tokenInput').value.trim();
  if (!t) return;
  localStorage.setItem(TOKEN_KEY, t);
  $('#tokenError').style.display = 'none';
  hideGate();
  loadAndRender();
});

$('#tokenInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#tokenSubmit').click();
});

$('#logoutBtn').addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
});

$('#refreshBtn').addEventListener('click', () => {
  loadAndRender();
});

// Time-window toggle handler — each .window-toggle has data-toggle naming
// the chart it controls. Clicking a button updates state and re-renders.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.window-toggle button');
  if (!btn) return;
  const toggle = btn.parentElement;
  const which = toggle.dataset.toggle;
  const win = btn.dataset.win;
  if (!which || !win || !(which in windowState)) return;

  windowState[which] = win;
  toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));

  if (which === 'plays')     renderPlays(null);
  if (which === 'scoreEff')  renderScoreEfficiency(null);
  if (which === 'cat')       renderCategoryActivity(null);
  if (which === 'newPlayers') renderNewPlayers(null);
  if (which === 'platform')   renderPlatform(null);
});

// ─── Data fetch ──────────────────────────────────────────────────────

async function fetchDashboard() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) throw new Error('NO_TOKEN');
  const res = await fetch(ENDPOINT, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    throw new Error('UNAUTHORIZED');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Render ──────────────────────────────────────────────────────────

const charts = {};

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

function renderTiles(summary, platformSplit) {
  const totalPlays = summary?.total_plays ?? 0;
  const uniquePlayers = summary?.unique_players ?? 0;
  const playsLast7d = summary?.plays_last_7d ?? 0;
  const dailySharePct = summary?.daily_share_pct ?? 0;
  // "Profiles" = users that have a Firestore /users/{uid} doc. That doc is
  // only created on the first getProfile call from the client. A user can
  // play (anon login → submit score) without ever calling getProfile, so
  // unique_players can exceed total_profiles. We surface both directions:
  //   - silent: profile exists but no score → registered-but-never-played
  //   - anonymous: scored but no profile doc → never-registered players
  // Previously the dashboard clamped silent to max(0, …) which hid the
  // anonymous case entirely.
  const totalProfiles = summary?.total_registered ?? 0;
  const silent = Math.max(0, totalProfiles - uniquePlayers);
  const anonymous = Math.max(0, uniquePlayers - totalProfiles);
  // Activation only makes sense when more profiles than players — otherwise
  // it would round to "more than 100%" which is meaningless.
  const activationRate = totalProfiles > 0 && uniquePlayers <= totalProfiles
    ? Math.round((uniquePlayers / totalProfiles) * 1000) / 10
    : null;

  // Per-platform player counts for the players-breakdown tile. Tiles
  // always show all-time so the subtitle stays stable regardless of the
  // Platform Split chart's window toggle. Note: a user who plays on
  // multiple platforms is counted in each per-platform bucket, so these
  // numbers can sum to MORE than the all-platforms unique_players total.
  const byPlatform = Object.fromEntries(
    (platformSplit || []).map(p => [p.platform, p.all_players ?? 0])
  );
  const ios = byPlatform.ios ?? 0;
  const android = byPlatform.android ?? 0;
  const hmos = byPlatform.harmonyos ?? 0;
  const platformSum = ios + android + hmos;
  const crossPlatform = Math.max(0, platformSum - uniquePlayers);

  // Activation tile body — different copy depending on which side has more.
  const activationBody = activationRate !== null
    ? `<div class="value">${activationRate}%</div>
       <div class="sub">${uniquePlayers.toLocaleString()} of ${totalProfiles.toLocaleString()} profiles played</div>`
    : `<div class="value">${anonymous.toLocaleString()}</div>
       <div class="sub">anonymous players (scored without a profile doc)</div>`;

  $('#tiles').innerHTML = `
    <div class="tile">
      <div class="label">Total plays</div>
      <div class="value">${totalPlays.toLocaleString()}</div>
      <div class="sub">all time, all platforms</div>
    </div>
    <div class="tile">
      <div class="label">Profiles</div>
      <div class="value">${totalProfiles.toLocaleString()}</div>
      <div class="sub">${silent.toLocaleString()} profile created but never played</div>
    </div>
    <div class="tile">
      <div class="label">${activationRate !== null ? 'Activation rate' : 'Anonymous players'}</div>
      ${activationBody}
    </div>
    <div class="tile">
      <div class="label">Players · breakdown</div>
      <div class="value">${uniquePlayers.toLocaleString()}</div>
      <div class="sub">${ios} iOS · ${android} Android · ${hmos} HMOS${crossPlatform > 0 ? ` <span title="multi-platform users counted in each">(+${crossPlatform} cross-platform)</span>` : ''}</div>
    </div>
    <div class="tile">
      <div class="label">Plays · last 7d</div>
      <div class="value">${playsLast7d.toLocaleString()}</div>
      <div class="sub">rolling weekly</div>
    </div>
    <div class="tile">
      <div class="label">Daily mode share</div>
      <div class="value">${dailySharePct}%</div>
      <div class="sub">${(100 - dailySharePct).toFixed(1)}% unlimited</div>
    </div>
  `;
}

function renderDaily(rows) {
  destroyChart('daily');
  const sorted = [...rows].sort((a, b) => a.play_date.localeCompare(b.play_date));
  const labels = sorted.map(r => r.play_date);
  charts.daily = new Chart($('#chartDaily').getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Plays',
          data: sorted.map(r => r.plays),
          borderColor: COLORS.mint,
          backgroundColor: COLORS.mintLight + '40',
          fill: true,
          tension: 0.3,
          yAxisID: 'y',
        },
        {
          label: 'Unique players',
          data: sorted.map(r => r.unique_players),
          borderColor: COLORS.rose,
          backgroundColor: 'transparent',
          tension: 0.3,
          yAxisID: 'y',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { beginAtZero: true, grid: { color: COLORS.border } },
        x: { grid: { display: false } },
      },
      plugins: { legend: { position: 'top', align: 'end' } },
    },
  });
}

// Active window state for the toggle-driven charts. Default 7d.
const windowState = { plays: 'd7', scoreEff: 'd7', cat: 'd7', newPlayers: 'd7', platform: 'd7' };
// Last-fetched data — kept so the toggle can re-render without refetching.
const lastData = { plays: [], scoreEff: [], cat: [], newPlayers: [], registrations: [], platform: [] };

function renderPlays(rows) {
  if (rows) lastData.plays = rows;
  const data = lastData.plays;
  const win = windowState.plays;
  // Map window key → (daily, unlimited) field names
  const fields = {
    today: ['today_daily', 'today_unlimited'],
    d7:    ['d7_daily',    'd7_unlimited'],
    d30:   ['d30_daily',   'd30_unlimited'],
    all:   ['all_daily',   'all_unlimited'],
  }[win];

  // Filter out games with zero plays in the selected window
  const visible = data
    .map(r => ({ game: r.game, daily: r[fields[0]] || 0, unlimited: r[fields[1]] || 0 }))
    .filter(r => r.daily + r.unlimited > 0)
    .sort((a, b) => (b.daily + b.unlimited) - (a.daily + a.unlimited));

  destroyChart('plays');
  fitHorizontalBars('chartPlays', visible.length);
  charts.plays = new Chart($('#chartPlays').getContext('2d'), {
    type: 'bar',
    data: {
      labels: visible.map(r => r.game),
      datasets: [
        { label: 'Daily',     data: visible.map(r => r.daily),     backgroundColor: COLORS.mint,  borderRadius: 4, stack: 'plays' },
        { label: 'Unlimited', data: visible.map(r => r.unlimited), backgroundColor: COLORS.amber, borderRadius: 4, stack: 'plays' },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero: true, stacked: true, grid: { color: COLORS.border } },
        y: { stacked: true, grid: { display: false } },
      },
      plugins: { legend: { position: 'top', align: 'end' } },
    },
  });
}

function renderPlatform(rows) {
  if (rows) lastData.platform = rows;
  const data = lastData.platform;
  const playsField = { today: 'today_plays', d7: 'd7_plays', d30: 'd30_plays', all: 'all_plays' }[windowState.platform];

  // Order: iOS, Android, HarmonyOS, Unknown (consistent across refreshes)
  const order = ['ios', 'android', 'harmonyos', 'unknown'];
  const byKey = Object.fromEntries(data.map(r => [r.platform, r]));
  const ordered = order
    .filter(k => byKey[k] && (byKey[k][playsField] || 0) > 0)
    .map(k => ({ key: k, plays: byKey[k][playsField] }));

  destroyChart('platform');
  charts.platform = new Chart($('#chartPlatform').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ordered.map(r => PLATFORM_LABEL[r.key] ?? r.key),
      datasets: [{
        data: ordered.map(r => r.plays),
        backgroundColor: ordered.map(r => COLORS[r.key] ?? COLORS.unknown),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'right' } },
    },
  });
}

function renderScoreEfficiency(rows) {
  if (rows) lastData.scoreEff = rows;
  const data = lastData.scoreEff;
  const win = windowState.scoreEff;
  const fields = {
    today: ['today_plays', 'today_avg_score'],
    d7:    ['d7_plays',    'd7_avg_score'],
    d30:   ['d30_plays',   'd30_avg_score'],
    all:   ['all_plays',   'all_avg_score'],
  }[win];

  const visible = data
    .map(r => ({
      game: r.game,
      plays: r[fields[0]] || 0,
      avg_score: r[fields[1]] || 0,
      pct: r.max_score && r[fields[1]] ? Math.round(1000 * r[fields[1]] / r.max_score) / 10 : 0,
    }))
    .filter(r => r.plays > 0)
    .sort((a, b) => b.plays - a.plays);

  destroyChart('scoreEff');
  charts.scoreEff = new Chart($('#chartScoreEff').getContext('2d'), {
    type: 'bar',
    data: {
      labels: visible.map(r => r.game),
      datasets: [
        { label: 'Plays',              data: visible.map(r => r.plays), backgroundColor: COLORS.mint, borderRadius: 4, yAxisID: 'y1', order: 2 },
        { label: 'Avg score % of max', data: visible.map(r => r.pct),   type: 'line', borderColor: COLORS.rose, backgroundColor: 'transparent', tension: 0.3, yAxisID: 'y', order: 1, pointBackgroundColor: COLORS.rose },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y:  { beginAtZero: true, max: 100, position: 'left',  title: { display: true, text: 'Avg score % of max' }, grid: { color: COLORS.border } },
        y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Plays' }, grid: { display: false } },
        x: { grid: { display: false } },
      },
      plugins: { legend: { position: 'top', align: 'end' } },
    },
  });
}

const CATEGORY_LABEL = { en: 'English', math: 'Numbers', colors: 'Colors' };
const CATEGORY_COLOR = { en: COLORS.mint, math: COLORS.amber, colors: COLORS.rose };

function renderCategoryActivity(rows) {
  if (rows) lastData.cat = rows;
  const data = lastData.cat;
  const win = windowState.cat;
  const winField = { today: 'today', d7: 'last_7d', d30: 'last_30d', all: 'all_time' }[win];

  // Stable category order: English → Numbers → Colors
  const order = ['en', 'math', 'colors'];
  const byCat = Object.fromEntries(data.map(r => [r.category, r]));
  const ordered = order.map(k => ({ category: k, plays: byCat[k]?.[winField] || 0 }));

  destroyChart('cat');
  charts.cat = new Chart($('#chartCategory').getContext('2d'), {
    type: 'bar',
    data: {
      labels: ordered.map(r => CATEGORY_LABEL[r.category]),
      datasets: [{
        label: 'Plays',
        data: ordered.map(r => r.plays),
        backgroundColor: ordered.map(r => CATEGORY_COLOR[r.category]),
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, grid: { color: COLORS.border } },
        x: { grid: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderFunnel(rows) {
  destroyChart('funnel');
  const sorted = [...rows].sort((a, b) => b.started - a.started);
  charts.funnel = new Chart($('#chartFunnel').getContext('2d'), {
    type: 'bar',
    data: {
      labels: sorted.map(r => r.game),
      datasets: [
        {
          label: 'Started',
          data: sorted.map(r => r.started),
          backgroundColor: COLORS.muted,
          borderRadius: 4,
          yAxisID: 'y1',
          order: 3,
        },
        {
          label: 'Completed',
          data: sorted.map(r => r.completed),
          backgroundColor: COLORS.mint,
          borderRadius: 4,
          yAxisID: 'y1',
          order: 2,
        },
        {
          label: 'Completion %',
          data: sorted.map(r => r.completion_pct),
          type: 'line',
          borderColor: COLORS.rose,
          backgroundColor: 'transparent',
          tension: 0.3,
          yAxisID: 'y',
          order: 1,
          pointBackgroundColor: COLORS.rose,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y:  { beginAtZero: true, max: 100, position: 'left',  title: { display: true, text: 'Completion %' }, grid: { color: COLORS.border } },
        y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Event count' }, grid: { display: false } },
        x: { grid: { display: false } },
      },
      plugins: { legend: { position: 'top', align: 'end' } },
    },
  });
}

// rows is the response payload {firstPlays, registrations} OR null on toggle re-render
function renderNewPlayers(payload) {
  if (payload) {
    lastData.newPlayers = payload.firstPlays || [];
    lastData.registrations = payload.registrations || [];
  }
  const playsData = lastData.newPlayers;
  const regsData = lastData.registrations;
  const daysBack = { d7: 7, d30: 30, d60: 60 }[windowState.newPlayers] || 7;

  // Build a continuous date series for the selected window. For each day,
  // look up both registrations and first-plays, defaulting to 0. Gap
  // between bars = users who registered but didn't play (silent installs).
  const playsByDate = Object.fromEntries(playsData.map(r => [r.created_date, r.new_users]));
  const regsByDate = Object.fromEntries(regsData.map(r => [r.created_date, r.new_users]));
  const series = [];
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(todayUtc);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    series.push({
      date: iso,
      registered: regsByDate[iso] || 0,
      firstPlay: playsByDate[iso] || 0,
    });
  }

  destroyChart('newPlayers');
  charts.newPlayers = new Chart($('#chartNewPlayers').getContext('2d'), {
    type: 'bar',
    data: {
      labels: series.map(r => r.date),
      datasets: [
        { label: 'Registered',  data: series.map(r => r.registered), backgroundColor: COLORS.amber, borderRadius: 4 },
        { label: 'First play',  data: series.map(r => r.firstPlay),  backgroundColor: COLORS.mint,  borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: COLORS.border } },
        x: { grid: { display: false } },
      },
      plugins: { legend: { position: 'top', align: 'end' } },
    },
  });
}

function renderGeo(rows) {
  destroyChart('geo');
  fitHorizontalBars('chartGeo', rows.length);
  charts.geo = new Chart($('#chartGeo').getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.country),
      datasets: [{
        label: 'Players',
        data: rows.map(r => r.players),
        backgroundColor: COLORS.ios,
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero: true, grid: { color: COLORS.border } },
        y: { grid: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

// ─── Engagement section ──────────────────────────────────────────────

function renderRetentionTiles(retention) {
  function pct(returned, cohort) {
    if (!cohort) return '—';
    return (Math.round(1000 * returned / cohort) / 10).toFixed(1) + '%';
  }
  const r = retention || {};
  $('#retentionTiles').innerHTML = `
    <div class="tile">
      <div class="label">D1 retention</div>
      <div class="value">${pct(r.d1_returned, r.d1_cohort)}</div>
      <div class="sub">${r.d1_returned ?? 0} of ${r.d1_cohort ?? 0} new players returned</div>
    </div>
    <div class="tile">
      <div class="label">D7 retention</div>
      <div class="value">${pct(r.d7_returned, r.d7_cohort)}</div>
      <div class="sub">${r.d7_returned ?? 0} of ${r.d7_cohort ?? 0} returned in days 7-13</div>
    </div>
    <div class="tile">
      <div class="label">D30 retention</div>
      <div class="value">${pct(r.d30_returned, r.d30_cohort)}</div>
      <div class="sub">${r.d30_returned ?? 0} of ${r.d30_cohort ?? 0} returned in days 30-36</div>
    </div>
    <div class="tile">
      <div class="label">Cohort note</div>
      <div class="value" style="font-size: 14px; line-height: 1.4; font-weight: 500; color: var(--muted);">All new signups, last 180 days.</div>
      <div class="sub">Healthy daily-game: D1 &gt; 30%, D7 &gt; 15%, D30 &gt; 5%</div>
    </div>
  `;
}

function renderActiveUsers(rows) {
  destroyChart('activeUsers');
  charts.activeUsers = new Chart($('#chartActiveUsers').getContext('2d'), {
    type: 'line',
    data: {
      labels: rows.map(r => r.day),
      datasets: [
        { label: 'DAU', data: rows.map(r => r.dau), borderColor: COLORS.mint, backgroundColor: COLORS.mintLight + '40', fill: true, tension: 0.3 },
        { label: 'WAU', data: rows.map(r => r.wau), borderColor: COLORS.rose, backgroundColor: 'transparent', tension: 0.3 },
        { label: 'MAU', data: rows.map(r => r.mau), borderColor: COLORS.amber, backgroundColor: 'transparent', tension: 0.3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { y: { beginAtZero: true, grid: { color: COLORS.border } }, x: { grid: { display: false } } },
      plugins: { legend: { position: 'top', align: 'end' } },
    },
  });
}

function renderStreaks(rows) {
  destroyChart('streaks');
  // The SQL GROUP BY drops empty buckets, so a chart with rows
  //   ['1-3': 13, '4-7': 3, '31-100': 1]
  // would render as three bars with no visual hint that 8-14 and 15-30
  // are zero. Pad with the full bucket list so the gaps are explicit.
  const ALL_BUCKETS = [
    { bucket: '1-3',    sort_order: 1 },
    { bucket: '4-7',    sort_order: 2 },
    { bucket: '8-14',   sort_order: 3 },
    { bucket: '15-30',  sort_order: 4 },
    { bucket: '31-100', sort_order: 5 },
    { bucket: '100+',   sort_order: 6 },
  ];
  const byBucket = Object.fromEntries(rows.map(r => [r.bucket, r.users]));
  const padded = ALL_BUCKETS.map(b => ({ bucket: b.bucket, users: byBucket[b.bucket] ?? 0 }));
  charts.streaks = new Chart($('#chartStreaks').getContext('2d'), {
    type: 'bar',
    data: {
      labels: padded.map(r => r.bucket),
      datasets: [{ label: 'Players', data: padded.map(r => r.users), backgroundColor: COLORS.mint, borderRadius: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: COLORS.border } }, x: { grid: { display: false } } },
      plugins: { legend: { display: false } },
    },
  });
}

function renderLastPlay(rows) {
  destroyChart('lastPlay');
  // Heat-gradient: green for recently active, fading to rose for churned
  const colors = [COLORS.mint, '#5EEAD4', '#A7F3D0', '#FBBF24', '#F59E0B', '#FB7185', COLORS.rose];
  // Pad zero-count buckets so the gradient stays meaningful end-to-end
  // (same SQL-GROUP-BY-drops-empty-rows problem as renderStreaks).
  const ALL_BUCKETS = [
    'Today', '1-2 days', '3-7 days', '1-2 weeks', '2-4 weeks', '1-3 months', '3+ months',
  ];
  const byBucket = Object.fromEntries(rows.map(r => [r.bucket, r.users]));
  const padded = ALL_BUCKETS.map(b => ({ bucket: b, users: byBucket[b] ?? 0 }));
  charts.lastPlay = new Chart($('#chartLastPlay').getContext('2d'), {
    type: 'bar',
    data: {
      labels: padded.map(r => r.bucket),
      datasets: [{
        label: 'Players',
        data: padded.map(r => r.users),
        backgroundColor: padded.map((_, i) => colors[Math.min(i, colors.length - 1)]),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: COLORS.border } }, x: { grid: { display: false } } },
      plugins: { legend: { display: false } },
    },
  });
}

// ─── Scoring health section ──────────────────────────────────────────

// Score-distribution sort state. Defaults to spread ascending (narrow
// spread first — these are the scoring algos that need tuning).
const scoreDistSort = { col: 'spread', dir: 'asc' };
let scoreDistData = [];

function renderScoreDistribution(rows) {
  if (rows) {
    scoreDistData = rows.map(r => ({ ...r, spread: r.p90 - r.p10 }));
  }
  paintScoreDistribution();
}

function paintScoreDistribution() {
  const sorted = [...scoreDistData].sort((a, b) => {
    const av = a[scoreDistSort.col];
    const bv = b[scoreDistSort.col];
    if (typeof av === 'string') {
      return scoreDistSort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return scoreDistSort.dir === 'asc' ? av - bv : bv - av;
  });

  const maxSpread = Math.max(...scoreDistData.map(r => r.spread), 1);

  const rowsHtml = sorted.map(r => {
    const barWidth = Math.max(8, Math.round((r.spread / maxSpread) * 120));
    return `
      <tr>
        <td>${r.game}</td>
        <td>${r.plays.toLocaleString()}</td>
        <td>${r.min_score}</td>
        <td>${r.p10}</td>
        <td><strong>${r.p50}</strong></td>
        <td>${r.p90}</td>
        <td>${r.max_score}</td>
        <td><span class="spread-bar" style="width:${barWidth}px"></span> ${r.spread}</td>
      </tr>
    `;
  }).join('');

  // sortable header — each th carries the field name + active arrow
  function arrow(col) {
    if (col !== scoreDistSort.col) return '';
    return scoreDistSort.dir === 'asc' ? ' sort-asc' : ' sort-desc';
  }
  const cols = [
    ['game', 'Game'], ['plays', 'Plays'], ['min_score', 'Min'], ['p10', 'p10'],
    ['p50', 'Median'], ['p90', 'p90'], ['max_score', 'Max'], ['spread', 'Spread (p90-p10)'],
  ];
  const headHtml = cols.map(([c, label]) =>
    `<th class="sortable${arrow(c)}" data-col="${c}">${label}</th>`
  ).join('');

  $('#scoreDistTable').innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>${headHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;

  // Wire header clicks
  document.querySelectorAll('#scoreDistTable th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (scoreDistSort.col === col) {
        scoreDistSort.dir = scoreDistSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        scoreDistSort.col = col;
        // First click on a new column: numeric cols start descending (high
        // values first feels natural), string cols start ascending.
        scoreDistSort.dir = col === 'game' ? 'asc' : 'desc';
      }
      paintScoreDistribution();
    });
  });
}

// ─── Game difficulty health ──────────────────────────────────────────
//
// Sortable table that combines five signals per game so it's easy to
// spot games that need tuning. Difficulty tag mirrors the rule in
// game-analytics.ts: scorePct > 85 = too_easy, 60-85 = balanced,
// 40-60 = hard, < 40 = too_hard. Default sort puts games most likely
// to need attention first (highest avg_score_pct — the easy ones —
// then sortable to anything else).
const difficultySort = { col: 'avg_score_pct', dir: 'desc' };
let difficultyData = [];

function difficultyTag(pct) {
  if (pct == null) return { label: '—', cls: 'unknown' };
  if (pct > 85) return { label: 'too easy',  cls: 'too-easy' };
  if (pct >= 60) return { label: 'balanced', cls: 'balanced' };
  if (pct >= 40) return { label: 'hard',     cls: 'hard' };
  return { label: 'too hard', cls: 'too-hard' };
}

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function renderGameDifficultyHealth(rows) {
  if (rows) difficultyData = rows.slice();
  paintGameDifficultyHealth();
}

function paintGameDifficultyHealth() {
  const sorted = [...difficultyData].sort((a, b) => {
    const av = a[difficultySort.col];
    const bv = b[difficultySort.col];
    if (typeof av === 'string') {
      return difficultySort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return difficultySort.dir === 'asc' ? (av ?? 0) - (bv ?? 0) : (bv ?? 0) - (av ?? 0);
  });

  const rowsHtml = sorted.map(r => {
    const tag = difficultyTag(r.avg_score_pct);
    return `
      <tr>
        <td>${r.game}</td>
        <td>${(r.plays ?? 0).toLocaleString()}</td>
        <td>${r.win_rate ?? 0}%</td>
        <td>${r.perfect_rate ?? 0}%</td>
        <td>${r.loss_rate ?? 0}%</td>
        <td>${r.avg_score_pct ?? 0}%</td>
        <td>${fmtTime(r.p50_time_sec)}</td>
        <td><span class="diff-tag diff-${tag.cls}">${tag.label}</span></td>
      </tr>
    `;
  }).join('');

  function arrow(col) {
    if (col !== difficultySort.col) return '';
    return difficultySort.dir === 'asc' ? ' sort-asc' : ' sort-desc';
  }
  const cols = [
    ['game',          'Game'],
    ['plays',         'Plays'],
    ['win_rate',      'Win %'],
    ['perfect_rate',  'Perfect %'],
    ['loss_rate',     'Loss %'],
    ['avg_score_pct', 'Avg % of max'],
    ['p50_time_sec',  'Median time'],
    ['avg_score_pct', 'Difficulty'],
  ];
  // Two columns use avg_score_pct as their sort key (the % column and the
  // Difficulty tag); de-dupe so the second one becomes the literal label.
  // Simplest: emit the % column as sortable and the Difficulty column as
  // non-sortable (it's a derived label, redundant to sort by).
  const headHtml = cols.map(([c, label], i) => {
    if (i === cols.length - 1) {
      return `<th>${label}</th>`;
    }
    return `<th class="sortable${arrow(c)}" data-col="${c}">${label}</th>`;
  }).join('');

  $('#difficultyTable').innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>${headHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;

  document.querySelectorAll('#difficultyTable th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (difficultySort.col === col) {
        difficultySort.dir = difficultySort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        difficultySort.col = col;
        difficultySort.dir = col === 'game' ? 'asc' : 'desc';
      }
      paintGameDifficultyHealth();
    });
  });
}

function renderTimeToComplete(rows) {
  destroyChart('ttc');
  fitHorizontalBars('chartTimeToComplete', rows.length);
  charts.ttc = new Chart($('#chartTimeToComplete').getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.game),
      datasets: [
        { label: 'Median (s)', data: rows.map(r => r.p50_seconds), backgroundColor: COLORS.mint, borderRadius: 4 },
        { label: 'p90 (s)',    data: rows.map(r => r.p90_seconds), backgroundColor: COLORS.amber, borderRadius: 4 },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, grid: { color: COLORS.border } }, y: { grid: { display: false } } },
      plugins: { legend: { position: 'top', align: 'end' } },
    },
  });
}

function renderHints(rows) {
  destroyChart('hints');
  fitHorizontalBars('chartHints', rows.length);
  charts.hints = new Chart($('#chartHints').getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.game),
      datasets: [
        { label: 'Avg hints', data: rows.map(r => r.avg_hints), backgroundColor: COLORS.mint, borderRadius: 4 },
        { label: 'p90 hints', data: rows.map(r => r.p90_hints), backgroundColor: COLORS.rose, borderRadius: 4 },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, grid: { color: COLORS.border } }, y: { grid: { display: false } } },
      plugins: { legend: { position: 'top', align: 'end' } },
    },
  });
}

function renderDifficulty(rows) {
  destroyChart('difficulty');
  // Show as percentage stacked bars per game.
  const labels = rows.map(r => r.game);
  const easyPct = rows.map(r => r.total_plays ? Math.round(1000 * r.easy_plays / r.total_plays) / 10 : 0);
  const normalPct = rows.map((r, i) => Math.max(0, 100 - easyPct[i]));
  charts.difficulty = new Chart($('#chartDifficulty').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Easy %',   data: easyPct,   backgroundColor: COLORS.rose,  borderRadius: 4, stack: 'mix' },
        { label: 'Normal %', data: normalPct, backgroundColor: COLORS.mint,  borderRadius: 4, stack: 'mix' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, max: 100, stacked: true, grid: { color: COLORS.border }, title: { display: true, text: '%' } },
        x: { stacked: true, grid: { display: false } },
      },
      plugins: { legend: { position: 'top', align: 'end' } },
    },
  });
}

// ─── Behavioral patterns section ─────────────────────────────────────

function renderHourOfDay(rows) {
  destroyChart('hourOfDay');
  // Ensure all 24 hours are represented even if some are empty
  const byHour = Object.fromEntries(rows.map(r => [r.hour, r.plays]));
  const allHours = Array.from({ length: 24 }, (_, h) => ({ hour: h, plays: byHour[h] ?? 0 }));
  charts.hourOfDay = new Chart($('#chartHourOfDay').getContext('2d'), {
    type: 'bar',
    data: {
      labels: allHours.map(r => String(r.hour).padStart(2, '0')),
      datasets: [{ label: 'Plays', data: allHours.map(r => r.plays), backgroundColor: COLORS.mint, borderRadius: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, grid: { color: COLORS.border } }, x: { grid: { display: false } } },
      plugins: { legend: { display: false } },
    },
  });
}

function renderDayOfWeek(rows) {
  destroyChart('dayOfWeek');
  charts.dayOfWeek = new Chart($('#chartDayOfWeek').getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.day_name),
      datasets: [{
        label: 'Plays',
        data: rows.map(r => r.plays),
        backgroundColor: rows.map(r => (r.day_num === 1 || r.day_num === 7) ? COLORS.amber : COLORS.mint),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, grid: { color: COLORS.border } }, x: { grid: { display: false } } },
      plugins: { legend: { display: false } },
    },
  });
}

// Naive semver compare: split on '.', compare numerically segment by
// segment. Good enough for our X.Y.Z tags (where 1.0.10 > 1.0.4). Returns
// negative if a < b, positive if a > b, 0 if equal. Non-numeric segments
// fall back to a localeCompare so '1.0.4-rc1' lands somewhere stable.
function compareVersions(a, b) {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? '0';
    const bi = pb[i] ?? '0';
    const an = parseInt(ai, 10);
    const bn = parseInt(bi, 10);
    if (!isNaN(an) && !isNaN(bn) && String(an) === ai && String(bn) === bi) {
      if (an !== bn) return an - bn;
    } else {
      const cmp = ai.localeCompare(bi);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

function renderAppVersionDistribution(rows) {
  destroyChart('appVersion');
  // Group rows by platform → { version: users }, then build a stacked
  // horizontal bar per platform with one segment per version. Each
  // platform's segments sum to 100% so you can compare adoption shape
  // side-by-side even when one platform has 10× the users.
  const byPlatform = {};
  for (const r of rows) {
    if (!byPlatform[r.platform]) byPlatform[r.platform] = [];
    byPlatform[r.platform].push({ version: r.version, users: r.users });
  }

  // All unique versions across platforms — sorted newest-first so the
  // stacked bar segments line up consistently. Newest version = the
  // colourful end of the gradient, oldest = grey.
  const allVersionsSet = new Set();
  Object.values(byPlatform).forEach(arr => arr.forEach(r => allVersionsSet.add(r.version)));
  const allVersions = [...allVersionsSet].sort(compareVersions).reverse();
  // Mint at the top (newest) fading to rose-y for older builds.
  const palette = ['#14B8A6', '#2DD4BF', '#5EEAD4', '#F59E0B', '#FB7185', '#FF6B9D', '#94A3B8'];
  const versionColor = Object.fromEntries(allVersions.map((v, i) => [v, palette[Math.min(i, palette.length - 1)]]));

  // Order platforms iOS → Android → HMOS so the chart reads consistently
  // across refreshes. Drop platforms with no version data so we don't
  // render an empty row.
  const platformOrder = ['ios', 'android', 'harmonyos'];
  const platforms = platformOrder.filter(p => byPlatform[p] && byPlatform[p].length > 0);

  // Each version is its own dataset (so legend filtering works). Convert
  // raw user counts to percentages per platform so bars are comparable.
  const datasets = allVersions.map(v => ({
    label: v,
    data: platforms.map(p => {
      const entries = byPlatform[p] || [];
      const total = entries.reduce((s, e) => s + e.users, 0);
      if (!total) return 0;
      const found = entries.find(e => e.version === v);
      return found ? Math.round(1000 * found.users / total) / 10 : 0;
    }),
    backgroundColor: versionColor[v],
    borderRadius: 4,
    stack: 'version',
  }));

  charts.appVersion = new Chart($('#chartAppVersion').getContext('2d'), {
    type: 'bar',
    data: {
      labels: platforms.map(p => PLATFORM_LABEL[p] ?? p),
      datasets,
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          beginAtZero: true, max: 100, stacked: true,
          grid: { color: COLORS.border },
          ticks: { callback: v => `${v}%` },
        },
        y: { stacked: true, grid: { display: false } },
      },
      plugins: {
        legend: { position: 'top', align: 'end' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const platform = platforms[ctx.dataIndex];
              const entries = byPlatform[platform] || [];
              const total = entries.reduce((s, e) => s + e.users, 0);
              const found = entries.find(e => e.version === ctx.dataset.label);
              const users = found ? found.users : 0;
              return `v${ctx.dataset.label}: ${ctx.parsed.x}% (${users} of ${total})`;
            },
          },
        },
      },
    },
  });
}

function renderPlatformByCountry(rows) {
  destroyChart('platformByCountry');
  fitHorizontalBars('chartPlatformByCountry', rows.length);
  charts.platformByCountry = new Chart($('#chartPlatformByCountry').getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.country),
      datasets: [
        { label: 'iOS',     data: rows.map(r => r.ios),     backgroundColor: COLORS.ios,     borderRadius: 4, stack: 'plat' },
        { label: 'Android', data: rows.map(r => r.android), backgroundColor: COLORS.android, borderRadius: 4, stack: 'plat' },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true, beginAtZero: true, grid: { color: COLORS.border } }, y: { stacked: true, grid: { display: false } } },
      plugins: { legend: { position: 'top', align: 'end' } },
    },
  });
}

// ─── Orchestration ───────────────────────────────────────────────────

async function loadAndRender() {
  $('#tiles').innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await fetchDashboard();
    $('#stamp').textContent = `Last refreshed: ${new Date(data.generatedAt).toLocaleString()}`;

    renderTiles(data.summary, data.platformSplit);
    // Engagement
    renderRetentionTiles(data.retention);
    renderActiveUsers(data.activeUsers || []);
    renderStreaks(data.streakDistribution || []);
    renderLastPlay(data.timeSinceLastPlay || []);
    // Trends
    renderDaily(data.dailyTrend);
    renderNewPlayers({
      firstPlays:    data.newPlayersPerDay   || [],
      registrations: data.registrationsPerDay || [],
    });
    renderPlatform(data.platformSplit);
    renderCategoryActivity(data.categoryActivity || []);
    // Scoring health
    renderGameDifficultyHealth(data.gameDifficultyHealth || []);
    renderScoreDistribution(data.scoreDistribution || []);
    renderTimeToComplete(data.timeToComplete || []);
    renderPlays(data.playsPerGame);
    renderScoreEfficiency(data.scoreEfficiencyPerGame);
    renderFunnel(data.funnelByGame || []);
    // Behavioral patterns
    renderHourOfDay(data.hourOfDay || []);
    renderDayOfWeek(data.dayOfWeek || []);
    renderGeo(data.geoDistribution || []);
    renderPlatformByCountry(data.platformByCountry || []);
    renderAppVersionDistribution(data.appVersionDistribution || []);

    if (Object.keys(data.errors || {}).length > 0) {
      console.warn('Some queries failed:', data.errors);
    }
  } catch (err) {
    if (err.message === 'NO_TOKEN' || err.message === 'UNAUTHORIZED') {
      showGate();
      if (err.message === 'UNAUTHORIZED') $('#tokenError').style.display = 'block';
    } else {
      $('#tiles').innerHTML = `<div class="empty">Failed to load: ${err.message}</div>`;
    }
  }
}

// Boot
if (!localStorage.getItem(TOKEN_KEY)) {
  showGate();
} else {
  loadAndRender();
}
