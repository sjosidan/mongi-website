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
  fitHorizontalBars('chartPlays', rows.length);
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
  charts.streaks = new Chart($('#chartStreaks').getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.bucket),
      datasets: [{ label: 'Players', data: rows.map(r => r.users), backgroundColor: COLORS.mint, borderRadius: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, grid: { color: COLORS.border } }, x: { grid: { display: false } } },
      plugins: { legend: { display: false } },
    },
  });
}

function renderLastPlay(rows) {
  destroyChart('lastPlay');
  // Heat-gradient: green for recently active, fading to rose for churned
  const colors = [COLORS.mint, '#5EEAD4', '#A7F3D0', '#FBBF24', '#F59E0B', '#FB7185', COLORS.rose];
  charts.lastPlay = new Chart($('#chartLastPlay').getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r.bucket),
      datasets: [{
        label: 'Players',
        data: rows.map(r => r.users),
        backgroundColor: rows.map((_, i) => colors[Math.min(i, colors.length - 1)]),
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

// ─── Scoring health section ──────────────────────────────────────────

function renderScoreDistribution(rows) {
  // Render as a TABLE, sorted by spread asc (narrow spread first — those need tuning)
  const enriched = rows.map(r => ({
    ...r,
    spread: r.p90 - r.p10,
  })).sort((a, b) => a.spread - b.spread);

  const maxSpread = Math.max(...enriched.map(r => r.spread), 1);

  const rowsHtml = enriched.map(r => {
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

  $('#scoreDistTable').innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>Game</th><th>Plays</th><th>Min</th><th>p10</th><th>Median</th><th>p90</th><th>Max</th><th>Spread (p90-p10)</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
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
    renderNewPlayers(data.newPlayersPerDay || []);
    renderPlatform(data.platformSplit);
    // Scoring health
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
