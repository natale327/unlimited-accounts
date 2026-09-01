const dashboardList = document.getElementById('dashboard-list');
const statsRefreshAllBtn = document.getElementById('stats-refresh-all');
const statsUpdatedEl = document.getElementById('stats-updated');
const unreadRefreshBtn = document.getElementById('unread-refresh');
const messageEl = document.getElementById('message');

let sessions = [];
let statsCache = {};
let unreadCounts = {};
let unreadRefreshInFlight = false;

function showMessage(text, type = 'success') {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  setTimeout(() => { messageEl.className = 'message hidden'; }, 3000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getSessionDisplayName(session) {
  return session.displayName || session.label || session.username || 'Unknown';
}

function formatCount(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString();
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + 'mo';
  return Math.floor(mo / 12) + 'y';
}

function getDashboardHealth(session, stats) {
  if (session.expired) return 'yellow';
  if (!stats) return 'gray';
  if (stats.error) return 'red';
  if (stats.suspended) return 'red';
  return 'green';
}

function renderDashboard() {
  if (!sessions.length) {
    dashboardList.innerHTML = '<div class="empty-state"><p>No accounts saved</p></div>';
    return;
  }
  dashboardList.innerHTML = sessions.map((session, index) => {
    const stats = statsCache[session.id];
    const health = getDashboardHealth(session, stats);
    const displayName = getSessionDisplayName(session);
    const unread = unreadCounts[session.id];
    const unreadBadge = (typeof unread === 'number' && unread > 0)
      ? `<span class="dash-unread" title="Unread notifications">${icon('bell', 'icon-sm')}${unread > 99 ? '99+' : unread}</span>`
      : '';
    const avatarHtml = session.avatarUrl
      ? `<img class="dash-avatar" src="${escapeHtml(session.avatarUrl)}" alt="">`
      : `<div class="dash-avatar dash-avatar-placeholder">${escapeHtml((displayName[0] || '?').toUpperCase())}</div>`;
    const handle = session.username ? '@' + escapeHtml(session.username) : '—';
    const errorLine = stats?.error
      ? `<div class="dash-error" title="${escapeHtml(stats.error)}">${escapeHtml(stats.error)}</div>`
      : '';
    return `
      <div class="dash-card" data-id="${session.id}">
        <span class="dash-slot">${String(index + 1).padStart(2, '0')}</span>
        ${unreadBadge}
        <div class="dash-main">
          ${avatarHtml}
          <div class="dash-info">
            <div class="dash-name">${escapeHtml(displayName)}</div>
            <div class="dash-handle">${handle}</div>
          </div>
          <span class="dash-health dash-health-${health}" title="Health: ${health}${stats?.error ? ' — ' + escapeHtml(stats.error) : ''}"></span>
        </div>
        <div class="dash-stats">
          <span class="dash-stat"><span class="dash-stat-label">Followers</span>${formatCount(stats?.followers ?? null)}</span>
          <span class="dash-stat"><span class="dash-stat-label">Following</span>${formatCount(stats?.following ?? null)}</span>
          <span class="dash-stat"><span class="dash-stat-label">Posts</span>${formatCount(stats?.tweets ?? null)}</span>
        </div>
        ${errorLine}
        <button class="btn btn-ghost stats-refresh" data-id="${session.id}">${icon('refresh', 'icon-sm')}Refresh</button>
      </div>
    `;
  }).join('');

  dashboardList.querySelectorAll('.stats-refresh').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      refreshCardStats(btn.dataset.id);
    });
  });
}

function updateStatsUpdated() {
  let latest = 0;
  for (const id in statsCache) {
    const entry = statsCache[id];
    if (entry && entry.fetchedAt && entry.fetchedAt > latest) latest = entry.fetchedAt;
  }
  statsUpdatedEl.textContent = latest ? 'Updated ' + formatRelativeTime(latest) : 'No stats yet';
}

async function loadDashboard() {
  try {
    const [sessionsResult, statsResult] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getSessions' }),
      chrome.runtime.sendMessage({ action: 'getAccountStats' })
    ]);
    sessions = sessionsResult || [];
    statsCache = statsResult || {};
    renderDashboard();
    updateStatsUpdated();
  } catch {
    dashboardList.innerHTML = '<div class="empty-state"><p>Failed to load dashboard</p></div>';
  }
}

async function refreshCardStats(id) {
  const btn = dashboardList.querySelector(`.stats-refresh[data-id="${id}"]`);
  if (btn) { btn.disabled = true; }
  try {
    const result = await chrome.runtime.sendMessage({ action: 'refreshAccountStats', sessionId: id });
    const statsResult = await chrome.runtime.sendMessage({ action: 'getAccountStats' });
    statsCache = statsResult || {};
    renderDashboard();
    updateStatsUpdated();
    if (!result || !result.success) {
      showMessage(result?.error || 'Refresh failed', 'error');
    }
  } catch {
    showMessage('Refresh failed', 'error');
  }
}

statsRefreshAllBtn.addEventListener('click', async () => {
  statsRefreshAllBtn.disabled = true;
  statsRefreshAllBtn.innerHTML = 'Refreshing...';
  try {
    await chrome.runtime.sendMessage({ action: 'refreshAllStats' });
    const statsResult = await chrome.runtime.sendMessage({ action: 'getAccountStats' });
    statsCache = statsResult || {};
    renderDashboard();
    updateStatsUpdated();
  } catch {
    showMessage('Refresh failed', 'error');
  }
  statsRefreshAllBtn.disabled = false;
  statsRefreshAllBtn.innerHTML = icon('refresh', 'icon-sm') + 'Refresh All';
});

unreadRefreshBtn.addEventListener('click', async () => {
  if (unreadRefreshInFlight) return;
  unreadRefreshInFlight = true;
  unreadRefreshBtn.disabled = true;
  unreadRefreshBtn.innerHTML = 'Refreshing...';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'fetchUnreadCounts' });
    if (result?.success) {
      unreadCounts = result.counts || {};
      renderDashboard();
      showMessage('Unread counts updated');
    } else {
      showMessage('Unread fetch failed', 'error');
    }
  } catch {
    showMessage('Unread fetch failed', 'error');
  } finally {
    unreadRefreshInFlight = false;
    unreadRefreshBtn.disabled = false;
    unreadRefreshBtn.innerHTML = icon('bell', 'icon-sm') + 'Refresh Unread';
  }
});

// ─── Init ───

async function init() {
  try {
    const { unreadCounts: cachedUnread, unreadCountsAt } = await chrome.storage.local.get(['unreadCounts', 'unreadCountsAt']);
    unreadCounts = cachedUnread || {};
    await loadDashboard();

    // Auto-refresh when stale, aligned with user activity
    // (fire-and-forget; storage.onChanged re-renders)
    const stale = !unreadCountsAt || (Date.now() - unreadCountsAt) > 300000;
    if (stale && sessions.length) {
      chrome.runtime.sendMessage({ action: 'fetchUnreadCounts' }).catch(() => {});
    }
  } catch (err) {
    console.error('Dashboard init error:', err);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.unreadCounts) {
      unreadCounts = changes.unreadCounts.newValue || {};
      renderDashboard();
    }
    if (changes.accountStats) {
      statsCache = changes.accountStats.newValue || {};
      renderDashboard();
      updateStatsUpdated();
    }
  });
}

init();
