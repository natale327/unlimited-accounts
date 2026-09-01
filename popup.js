const accountsList = document.getElementById('accounts-list');
const saveBtn = document.getElementById('save-btn');
const currentName = document.getElementById('current-name');
const currentAvatar = document.getElementById('current-avatar');
const messageEl = document.getElementById('message');
const ioModal = document.getElementById('io-modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');
const accountCount = document.getElementById('account-count');
const groupTabs = document.getElementById('group-tabs');
const addGroupBtn = document.getElementById('add-group-btn');
const editGroupBtn = document.getElementById('edit-group-btn');
const deleteGroupBtn = document.getElementById('delete-group-btn');
const searchInput = document.getElementById('search-input');
const settingsBtn = document.getElementById('settings-btn');
const dashboardBtn = document.getElementById('dashboard-btn');

let currentSession = null;
let sessions = [];
let groups = [];
let activeGroup = 'all';
let searchQuery = '';
let isLoggedIn = false;
let currentUserId = null;
let currentUserInfo = null;
let unreadCounts = {};

const GROUP_COLORS = ['#1d9bf0', '#f91880', '#7856ff', '#00ba7c', '#ff7a00', '#ffd400', '#ef4444', '#8b5cf6', '#06b6d4', '#10b981', '#f97316', '#eab308', '#ec4899', '#a855f7', '#14b8a6', '#64748b', '#0ea5e9', '#d946ef'];

function showMessage(text, type = 'success') {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  setTimeout(() => { messageEl.className = 'message hidden'; }, 3000);
}

function getSessionDisplayName(session) {
  return session.displayName || session.label || session.username || 'Unknown';
}

function renderAccounts() {
  let filteredSessions = activeGroup === 'all'
    ? sessions
    : sessions.filter(s => s.groupId === activeGroup);

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredSessions = filteredSessions.filter(s => {
      const name = getSessionDisplayName(s).toLowerCase();
      const user = (s.username || '').toLowerCase();
      return name.includes(q) || user.includes(q);
    });
  }

  accountCount.textContent = filteredSessions.length > 0 ? filteredSessions.length : '';

  if (filteredSessions.length === 0) {
    accountsList.innerHTML = `
      <div class="empty-state">
        <p>${activeGroup === 'all' ? 'No accounts saved' : 'No accounts in this group'}</p>
      </div>
    `;
    return;
  }

  accountsList.innerHTML = filteredSessions.map((session) => {
    const globalIndex = sessions.findIndex(s => s.id === session.id);
    const isActive = currentSession && currentSession.id === session.id;
    const displayName = getSessionDisplayName(session);
    const avatarHtml = session.avatarUrl
      ? `<img class="avatar ${!isActive ? 'avatar-clickable' : ''}" src="${escapeHtml(session.avatarUrl)}" alt="" ${!isActive ? 'data-action="switch"' : ''}>`
      : `<div class="avatar avatar-placeholder ${!isActive ? 'avatar-clickable' : ''}" ${!isActive ? 'data-action="switch"' : ''}>${displayName[0].toUpperCase()}</div>`;

    const isFirst = globalIndex === 0;
    const isLast = globalIndex === sessions.length - 1;
    const group = groups.find(g => g.id === session.groupId);
    const groupIndicator = group ? `<span class="group-indicator" style="background: ${group.color}"></span>` : '';
    const dateText = session.username ? '@' + escapeHtml(session.username) : '';
    const bannerStyle = session.profileBannerUrl
      ? `style="--banner: url('${escapeHtml(session.profileBannerUrl).replace(/'/g, '%27')}')"`
      : '';
    const unreadCount = unreadCounts[session.id] || 0;
    const unreadBadge = unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : '';

    return `
      <div class="account-item ${isActive ? 'active' : ''} ${session.profileBannerUrl ? 'has-banner' : ''}" data-id="${session.id}" data-index="${globalIndex}" draggable="true" ${bannerStyle}>
        <span class="account-slot">${String(globalIndex + 1).padStart(2, '0')}</span>
        ${avatarHtml}
        <div class="account-info ${!isActive ? 'account-info-clickable' : ''}" ${!isActive ? 'data-action="switch"' : ''}>
          <div class="account-name"><span class="name-text">${groupIndicator}${escapeHtml(displayName)}</span></div>
          <div class="account-date">${dateText}</div>
        </div>
        ${unreadBadge}
        <div class="account-actions">
          <button class="btn-icon group-assign" title="Assign Group" data-action="assignGroup">${icon('plus')}</button>
          <div class="menu-container">
            <button class="btn-icon menu-toggle" title="More" data-action="toggleMenu">${icon('dots')}</button>
            <div class="menu-dropdown hidden">
              <button class="menu-item" data-action="rename">Rename</button>
              ${!session.profileBannerUrl ? `<button class="menu-item" data-action="fetchBanner">Get Banner</button>` : ''}
              <hr class="menu-separator">
              <button class="menu-item" data-action="moveUp" ${isFirst ? 'disabled' : ''}>Move Up</button>
              <button class="menu-item" data-action="moveDown" ${isLast ? 'disabled' : ''}>Move Down</button>
              <hr class="menu-separator">
              <button class="menu-item menu-item-danger" data-action="delete">Delete</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  accountsList.querySelectorAll('.btn-icon, .menu-item').forEach(btn => {
    btn.addEventListener('click', handleAccountAction);
  });
  accountsList.querySelectorAll('.avatar-clickable, .account-info-clickable').forEach(el => {
    el.addEventListener('click', handleAccountAction);
  });
}

function renderGroupTabs() {
  if (!Array.isArray(groups)) return;
  groupTabs.innerHTML = groups.map(group => `
    <button class="group-tab ${activeGroup === group.id ? 'active' : ''}" data-group="${group.id}">
      <span class="group-indicator" style="background: ${group.color}"></span>${escapeHtml(group.name)}
    </button>
  `).join('');
  document.querySelector('.group-tab[data-group="all"]').classList.toggle('active', activeGroup === 'all');
  groupTabs.querySelectorAll('.group-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeGroup = tab.dataset.group;
      chrome.storage.local.set({ uiLastGroup: activeGroup });
      renderGroupTabs();
      renderAccounts();
    });
  });
  const hasActiveGroup = activeGroup !== 'all' && groups.some(g => g.id === activeGroup);
  editGroupBtn.disabled = !hasActiveGroup;
  deleteGroupBtn.disabled = !hasActiveGroup;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function handleAccountAction(e) {
  const actionEl = e.target.closest('[data-action]');
  const action = actionEl ? actionEl.dataset.action : null;
  const item = e.target.closest('.account-item');
  if (!action || !item) return;
  const id = item.dataset.id;

  if (action === 'toggleMenu') {
    e.stopPropagation();
    const menuContainer = e.target.closest('.menu-container');
    const dropdown = menuContainer.querySelector('.menu-dropdown');
    const isHidden = dropdown.classList.contains('hidden');
    document.querySelectorAll('.menu-dropdown').forEach(d => d.classList.add('hidden'));
    if (isHidden) {
      const rect = menuContainer.getBoundingClientRect();
      const menuWidth = 130, menuHeight = 160, vh = window.innerHeight;
      let left = rect.right - menuWidth;
      if (left < 0) left = 4;
      let top = rect.bottom + 4;
      if (rect.bottom + menuHeight > vh) top = rect.top - menuHeight - 4;
      if (top < 0) top = 4;
      dropdown.style.position = 'fixed';
      dropdown.style.left = left + 'px';
      dropdown.style.top = top + 'px';
      dropdown.classList.remove('hidden');
    }
    return;
  } else if (action === 'switch') {
    const isButton = e.target.tagName === 'BUTTON' || e.target.tagName === 'IMG';
    if (isButton) {
      e.target.disabled = true;
      e.target.textContent = '...';
    }
    const result = await chrome.runtime.sendMessage({ action: 'switchSession', id, source: 'popup' });
    if (result.success) {
      showMessage('Account switched');
      setTimeout(() => window.close(), 1000);
    } else {
      showMessage(result.error || 'Switch failed', 'error');
      renderAccounts();
    }
  } else if (action === 'delete') {
    if (confirm('Delete this account?')) {
      await chrome.runtime.sendMessage({ action: 'deleteSession', id });
      sessions = sessions.filter(s => s.id !== id);
      renderAccounts();
      showMessage('Account deleted');
    }
  } else if (action === 'rename') {
    const session = sessions.find(s => s.id === id);
    const currentLabel = getSessionDisplayName(session);
    const nameEl = item.querySelector('.account-name');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = currentLabel;
    input.maxLength = 30;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const finishRename = async () => {
      const newLabel = input.value.trim();
      if (newLabel && newLabel !== currentLabel) {
        await chrome.runtime.sendMessage({ action: 'renameSession', id, label: newLabel });
        session.displayName = newLabel;
        session.label = newLabel;
      }
      renderAccounts();
    };
    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finishRename();
      if (e.key === 'Escape') renderAccounts();
    });
  } else if (action === 'moveUp') {
    const index = sessions.findIndex(s => s.id === id);
    if (index > 0) {
      [sessions[index - 1], sessions[index]] = [sessions[index], sessions[index - 1]];
      await saveOrder();
      renderAccounts();
    }
  } else if (action === 'moveDown') {
    const index = sessions.findIndex(s => s.id === id);
    if (index < sessions.length - 1) {
      [sessions[index], sessions[index + 1]] = [sessions[index + 1], sessions[index]];
      await saveOrder();
      renderAccounts();
    }
  } else if (action === 'assignGroup') {
    const session = sessions.find(s => s.id === id);
    openGroupAssignModal(session);
  } else if (action === 'fetchBanner') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || (!tab.url.includes('x.com') && !tab.url.includes('twitter.com'))) {
      showMessage('Open a Twitter tab first', 'error');
      return;
    }
    // Only allow fetching when on the logged-in user's own profile
    if (currentSession) {
      const currentPath = new URL(tab.url).pathname.replace(/^\//, '').split('/')[0];
      if (currentPath !== currentSession.username) {
        showMessage('Open your own profile page first', 'error');
        return;
      }
    }
    try {
      const userInfo = await chrome.tabs.sendMessage(tab.id, { action: 'getUserInfo' });
      if (!userInfo || !userInfo.profileBannerUrl) {
        showMessage('Banner not found — open your profile page', 'error');
        return;
      }
      const result = await chrome.runtime.sendMessage({ action: 'updateSessionInfo', id, userInfo });
      if (result.success && result.session) {
        const index = sessions.findIndex(s => s.id === id);
        if (index !== -1) sessions[index] = result.session;
        renderAccounts();
        showMessage('Banner updated');
      }
    } catch {
      showMessage('Could not read the page', 'error');
    }
  }
}

async function saveOrder() {
  await chrome.runtime.sendMessage({ action: 'reorderSessions', orderedIds: sessions.map(s => s.id) });
}

function openGroupAssignModal(session) {
  const groupOptions = groups.map(g => `
    <button class="group-option ${session.groupId === g.id ? 'selected' : ''}" data-group-id="${g.id}">
      <span class="group-indicator" style="background: ${g.color}"></span>${escapeHtml(g.name)}
    </button>
  `).join('');
  openModal('Assign Group', `
    <p class="modal-desc">Select a group for <strong>${escapeHtml(getSessionDisplayName(session))}</strong></p>
    <div class="group-selector">
      <button class="group-option ${!session.groupId ? 'selected' : ''}" data-group-id="">None</button>
      ${groupOptions}
    </div>
  `, () => closeModal());
  modalConfirm.textContent = 'Close';
  modalBody.querySelectorAll('.group-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'assignGroup', sessionId: session.id, groupId: btn.dataset.groupId || null });
      session.groupId = btn.dataset.groupId || null;
      renderAccounts();
      closeModal();
      showMessage('Group assigned');
    });
  });
}

function openGroupModal(group) {
  const isEdit = !!group;
  const name = group?.name || '';
  const color = group?.color || GROUP_COLORS[0];
  openModal(isEdit ? 'Edit Group' : 'Add Group', `
    <p class="modal-desc">${isEdit ? 'Edit group name and color.' : 'Create a new group to organize accounts.'}</p>
    <input type="text" id="group-name" class="modal-input" placeholder="Group name" value="${escapeHtml(name)}" autofocus>
    <div class="color-picker">
      ${GROUP_COLORS.map(c => `<div class="color-option ${c === color ? 'selected' : ''}" data-color="${c}" style="background: ${c}"></div>`).join('')}
    </div>
    <div class="color-custom-row">
      <input type="color" id="group-color-custom" class="color-input" value="${color}" title="Custom color">
      <span class="color-custom-label">Custom</span>
    </div>
  `, async () => {
    const nameInput = modalBody.querySelector('#group-name').value.trim();
    const selectedSwatch = modalBody.querySelector('.color-option.selected')?.dataset.color;
    const selectedColor = selectedSwatch || modalBody.querySelector('#group-color-custom').value || GROUP_COLORS[0];
    if (!nameInput) { showMessage('Enter a group name', 'error'); return; }
    const result = isEdit
      ? await chrome.runtime.sendMessage({ action: 'updateGroup', id: group.id, name: nameInput, color: selectedColor })
      : await chrome.runtime.sendMessage({ action: 'addGroup', name: nameInput, color: selectedColor });
    if (result.success) {
      const index = groups.findIndex(g => g.id === result.group.id);
      if (index !== -1) groups[index] = result.group;
      else groups.push(result.group);
      renderGroupTabs();
      renderAccounts();
      closeModal();
      showMessage(isEdit ? 'Group updated' : 'Group created');
    } else {
      showMessage(result.error || 'Failed', 'error');
    }
  });
  modalBody.querySelectorAll('.color-option').forEach(opt => {
    opt.addEventListener('click', () => {
      modalBody.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      const custom = modalBody.querySelector('#group-color-custom');
      if (custom) custom.value = opt.dataset.color;
    });
  });
  const customInput = modalBody.querySelector('#group-color-custom');
  if (customInput) {
    customInput.addEventListener('input', () => {
      modalBody.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
    });
  }
}

addGroupBtn.addEventListener('click', () => openGroupModal(null));

editGroupBtn.addEventListener('click', () => {
  const group = groups.find(g => g.id === activeGroup);
  if (group) openGroupModal(group);
});

deleteGroupBtn.addEventListener('click', async () => {
  const group = groups.find(g => g.id === activeGroup);
  if (!group) return;
  if (confirm(`Delete group "${group.name}"? Accounts will be unassigned.`)) {
    const result = await chrome.runtime.sendMessage({ action: 'deleteGroup', id: group.id });
    if (result.success) {
      groups = groups.filter(g => g.id !== group.id);
      activeGroup = 'all';
      renderGroupTabs();
      renderAccounts();
      showMessage('Group deleted');
    } else {
      showMessage(result.error || 'Failed', 'error');
    }
  }
});

document.querySelector('.group-tab[data-group="all"]').addEventListener('click', () => {
  activeGroup = 'all';
  chrome.storage.local.set({ uiLastGroup: 'all' });
  renderGroupTabs();
  renderAccounts();
});

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  const result = await chrome.runtime.sendMessage({ action: 'saveSession', userInfo: currentUserInfo });
  if (result.success) {
    sessions.push(result.session);
    renderAccounts();
    showMessage('Account saved');
  } else {
    showMessage(result.error || 'Save failed', 'error');
  }
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save Current';
});

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderAccounts();
});

settingsBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'openSettings' });
});

dashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

function openModal(title, bodyHtml, onConfirm) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  ioModal.classList.remove('hidden');
  modalConfirm.onclick = onConfirm;
  modalCancel.onclick = closeModal;
  ioModal.querySelector('.modal-backdrop').onclick = closeModal;
  const firstInput = modalBody.querySelector('input');
  if (firstInput) setTimeout(() => firstInput.focus(), 100);
}

function closeModal() {
  ioModal.classList.add('hidden');
  modalBody.innerHTML = '';
}

async function refreshMissingSessionInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || (!tab.url.includes('x.com') && !tab.url.includes('twitter.com'))) return;
  try {
    const userInfo = await chrome.tabs.sendMessage(tab.id, { action: 'getUserInfo' });
    if (!userInfo || !userInfo.username) return;
    if (currentSession) {
      // Only update banner if we're on the logged-in user's own profile
      const currentPath = new URL(tab.url).pathname.replace(/^\//, '').split('/')[0];
      const isOwnProfile = currentPath === currentSession.username;
      const needsUpdate = !currentSession.avatarUrl || !currentSession.username
        || (isOwnProfile && (!currentSession.profileBannerUrl || currentSession.avatarUrl !== userInfo.avatarUrl));
      if (needsUpdate) {
        const updateInfo = { ...userInfo };
        if (!isOwnProfile) updateInfo.profileBannerUrl = undefined; // don't overwrite banner when on someone else's profile
        const result = await chrome.runtime.sendMessage({ action: 'updateSessionInfo', id: currentSession.id, userInfo: updateInfo });
        if (result.success && result.session) {
          Object.assign(currentSession, result.session);
          const index = sessions.findIndex(s => s.id === currentSession.id);
          if (index !== -1) sessions[index] = currentSession;
          if (currentSession.avatarUrl) {
            currentAvatar.src = currentSession.avatarUrl;
            currentAvatar.classList.remove('hidden');
          }
          currentName.textContent = getSessionDisplayName(currentSession);
        }
      }
      renderAccounts();
    }
  } catch {}
}

const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
const statusSlot = document.getElementById('status-slot');

function updateStatusBar() {
  const savedIndex = currentSession
    ? sessions.findIndex(s => s.id === currentSession.id)
    : -1;

  if (!isLoggedIn) {
    statusDot.className = 'status-dot logged-out';
    statusLabel.textContent = 'Logged out';
    statusSlot.classList.add('hidden');
  } else if (savedIndex !== -1) {
    statusDot.className = 'status-dot saved';
    statusLabel.textContent = 'Slot ' + String(savedIndex + 1).padStart(2, '0');
    statusSlot.textContent = '#' + String(savedIndex + 1).padStart(2, '0');
    statusSlot.classList.remove('hidden');
  } else {
    statusDot.className = 'status-dot unsaved';
    statusLabel.textContent = 'Unsaved';
    statusSlot.classList.add('hidden');
  }
}

// ── View mode (list / tile) ──
const viewListBtn = document.getElementById('view-list-btn');
const viewTileBtn = document.getElementById('view-tile-btn');
let viewMode = 'list';

function applyViewMode() {
  accountsList.classList.toggle('tile-view', viewMode === 'tile');
  viewListBtn.classList.toggle('active', viewMode === 'list');
  viewTileBtn.classList.toggle('active', viewMode === 'tile');
}

viewListBtn.addEventListener('click', () => {
  viewMode = 'list';
  applyViewMode();
  chrome.storage.local.set({ uiViewMode: viewMode });
});

viewTileBtn.addEventListener('click', () => {
  viewMode = 'tile';
  applyViewMode();
  chrome.storage.local.set({ uiViewMode: viewMode });
});

// ── Accent color ──
function applyAccent(c) {
  if (!c) return;
  const r = document.documentElement.style;
  r.setProperty('--color-accent', c);
  r.setProperty('--color-accent-strong', `color-mix(in srgb, ${c} 82%, white)`);
  r.setProperty('--color-accent-soft', `color-mix(in srgb, ${c} 22%, transparent)`);
}

// ── Drag & Drop reorder ──
let dragId = null;

function clearDragMarks() {
  document.querySelectorAll('.account-item.drag-over, .account-item.dragging')
    .forEach(el => el.classList.remove('drag-over', 'dragging'));
}

accountsList.addEventListener('dragstart', (e) => {
  const item = e.target.closest('.account-item');
  if (!item) return;
  dragId = item.dataset.id;
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragId); } catch {}
});

accountsList.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const item = e.target.closest('.account-item');
  if (!item || item.dataset.id === dragId) return;
  clearDragMarks();
  item.classList.add('drag-over');
});

accountsList.addEventListener('drop', async (e) => {
  e.preventDefault();
  const item = e.target.closest('.account-item');
  if (!item || !dragId || item.dataset.id === dragId) { clearDragMarks(); return; }
  const fromIdx = sessions.findIndex(s => s.id === dragId);
  const toIdx = sessions.findIndex(s => s.id === item.dataset.id);
  if (fromIdx !== -1 && toIdx !== -1) {
    const [moved] = sessions.splice(fromIdx, 1);
    sessions.splice(toIdx, 0, moved);
    await saveOrder();
    renderAccounts();
  }
  clearDragMarks();
});

accountsList.addEventListener('dragleave', (e) => {
  const item = e.target.closest('.account-item');
  if (item) item.classList.remove('drag-over');
});

accountsList.addEventListener('dragend', clearDragMarks);

// ── Live unread counts ──
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.unreadCounts) return;
  unreadCounts = changes.unreadCounts.newValue || {};
  renderAccounts();
});

// ─── Init ───

async function init() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getCurrentSession' });
    sessions = await chrome.runtime.sendMessage({ action: 'getSessions' });
    groups = await chrome.runtime.sendMessage({ action: 'getGroups' }) || [];

    const prefs = await chrome.storage.local.get(['accentColor', 'uiViewMode', 'uiLastGroup', 'uiRememberGroup', 'unreadCounts', 'unreadCountsAt']);
    applyAccent(prefs.accentColor);
    if (prefs.accentColor) { try { localStorage.setItem('accentColor', prefs.accentColor); } catch {} }
    viewMode = prefs.uiViewMode === 'tile' ? 'tile' : 'list';
    applyViewMode();
    if (prefs.uiRememberGroup !== false && prefs.uiLastGroup &&
        (prefs.uiLastGroup === 'all' || groups.some(g => g.id === prefs.uiLastGroup))) {
      activeGroup = prefs.uiLastGroup;
    }
    unreadCounts = prefs.unreadCounts || {};

    // Auto-refresh unread counts when stale, aligned with user activity
    // (fire-and-forget; storage.onChanged updates badges)
    const unreadStale = !prefs.unreadCountsAt || (Date.now() - prefs.unreadCountsAt) > 300000;
    if (unreadStale && groups !== null) {
      chrome.runtime.sendMessage({ action: 'fetchUnreadCounts' }).catch(() => {});
    }

    isLoggedIn = status.isLoggedIn;
    currentUserId = status.userId;
    currentSession = status.savedSession;

    if (!isLoggedIn) {
      currentName.textContent = 'Not logged in';
      currentName.classList.add('not-logged-in');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Log in to Twitter';
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && (tab.url.includes('x.com') || tab.url.includes('twitter.com'))) {
        try { currentUserInfo = await chrome.tabs.sendMessage(tab.id, { action: 'getUserInfo' }); } catch {}
      }
      if (currentSession) {
        currentName.textContent = getSessionDisplayName(currentSession);
        if (currentSession.avatarUrl) {
          currentAvatar.src = currentSession.avatarUrl;
          currentAvatar.classList.remove('hidden');
        }
      } else if (currentUserInfo) {
        currentName.textContent = currentUserInfo.displayName || currentUserInfo.username;
        if (currentUserInfo.avatarUrl) {
          currentAvatar.src = currentUserInfo.avatarUrl;
          currentAvatar.classList.remove('hidden');
        }
        currentName.style.color = 'var(--color-warning)';
      } else {
        currentName.textContent = currentUserId ? `ID: ${currentUserId}` : 'Logged in';
        currentName.style.color = 'var(--color-warning)';
      }
    }

    updateStatusBar();
    renderGroupTabs();
    renderAccounts();
    await refreshMissingSessionInfo();
  } catch (err) {
    console.error('Init error:', err);
    currentName.textContent = 'Error';
    currentName.classList.add('not-logged-in');
  }
}

init();

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-container')) {
    document.querySelectorAll('.menu-dropdown').forEach(d => d.classList.add('hidden'));
  }
});