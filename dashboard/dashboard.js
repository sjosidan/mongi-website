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

  // Per-platform player counts for the unique-players subtitle.
  const byPlatform = Object.fromEntries(
    (platformSplit || []).map(p => [p.platform, p.unique_players])
  );
  const ios = byPlatform.ios ?? 0;
  const android = byPlatform.android ?? 0;
  const hmos = byPlatform.harmonyos ?? 0;

  $('#tiles').innerHTML = `
    <div class="tile">
      <div class="label">Total plays</div>
      <div class="value">${totalPlays.toLocaleString()}</div>
      <div class="sub">all time, all platforms</div>
    </div>
    <div class="tile">
      <div class="label">Unique players</div>
      <div class="value">${uniquePlayers.toLocaleString()}</div>
      <div class="sub">${ios} iOS · ${android} Android · ${hmos} HMOS</div>
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

function renderPlays(rows) {
  destroyChart('plays');
  charts.plays = new Chart($('#chartPlays').getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.game),
      datasets: [
        {
          label: 'Daily',
          data: rows.map(r => r.daily_plays),
          backgroundColor: COLORS.mint,
          borderRadius: 4,
          stack: 'plays',
        },
        {
          label: 'Unlimited',
          data: rows.map(r => r.unlimited_plays),
          backgroundColor: COLORS.amber,
          borderRadius: 4,
          stack: 'plays',
        },
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
  destroyChart('platform');
  // Order: iOS, Android, HarmonyOS, Unknown (consistent across refreshes)
  const order = ['ios', 'android', 'harmonyos', 'unknown'];
  const byKey = Object.fromEntries(rows.map(r => [r.platform, r]));
  const ordered = order
    .filter(k => byKey[k])
    .map(k => ({ key: k, ...byKey[k] }));

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
  destroyChart('scoreEff');
  const sorted = [...rows].sort((a, b) => b.plays - a.plays);
  charts.scoreEff = new Chart($('#chartScoreEff').getContext('2d'), {
    type: 'bar',
    data: {
      labels: sorted.map(r => r.game),
      datasets: [
        {
          label: 'Plays',
          data: sorted.map(r => r.plays),
          backgroundColor: COLORS.mint,
          borderRadius: 4,
          yAxisID: 'y1',
          order: 2,
        },
        {
          label: 'Avg score % of max',
          data: sorted.map(r => r.avg_score_pct_of_max),
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
        y:  { beginAtZero: true, max: 100, position: 'left',  title: { display: true, text: 'Avg score % of max' }, grid: { color: COLORS.border } },
        y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Plays' }, grid: { display: false } },
        x: { grid: { display: false } },
      },
      plugins: { legend: { position: 'top', align: 'end' } },
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

function renderNewPlayers(rows) {
  destroyChart('newPlayers');
  // rows arrive ASC by date from the query.
  charts.newPlayers = new Chart($('#chartNewPlayers').getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.created_date),
      datasets: [{
        label: 'New players',
        data: rows.map(r => r.new_users),
        backgroundColor: COLORS.mint,
        borderRadius: 4,
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

function renderGeo(rows) {
  destroyChart('geo');
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

// ─── Orchestration ───────────────────────────────────────────────────

async function loadAndRender() {
  $('#tiles').innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await fetchDashboard();
    $('#stamp').textContent = `Last refreshed: ${new Date(data.generatedAt).toLocaleString()}`;

    renderTiles(data.summary, data.platformSplit);
    renderDaily(data.dailyTrend);
    renderPlays(data.playsPerGame);
    renderPlatform(data.platformSplit);
    renderScoreEfficiency(data.scoreEfficiencyPerGame);
    renderFunnel(data.funnelByGame || []);
    renderNewPlayers(data.newPlayersPerDay || []);
    renderGeo(data.geoDistribution || []);

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
