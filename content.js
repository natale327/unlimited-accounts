(() => {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.onMessage) return;

  function getBannerUrl() {
    const header = document.querySelector('[data-testid="profileHeader"]');
    if (header) {
      const bg = getComputedStyle(header).backgroundImage;
      const match = bg.match(/url\("?(.+?)"?\)/);
      if (match && match[1]) return match[1];
    }
    const bannerImg = document.querySelector('img[data-testid*="profileBanner"], img[alt*="profile banner" i], img[src*="profile_banners"]');
    if (bannerImg?.src) return bannerImg.src;
    const og = document.querySelector('meta[property="og:image"]');
    if (og?.content) return og.content;
    return null;
  }

  function isOwnProfile(loggedInUsername) {
    // Compare URL path against the logged-in username
    const path = window.location.pathname.replace(/^\//, '').split('/')[0];
    return path === loggedInUsername;
  }

  function getCurrentUserInfo() {
    const avatarContainer = document.querySelector('[data-testid^="UserAvatar-Container-"]');
    if (!avatarContainer) return null;

    const testId = avatarContainer.getAttribute('data-testid');
    const username = testId.replace('UserAvatar-Container-', '');

    const img = avatarContainer.querySelector('img[src*="twimg.com"]');
    const avatarUrl = img?.src || null;

    let displayName = username;
    const nav = avatarContainer.closest('nav, header, [data-testid*="Sidebar"], [data-testid*="sidebar"]');
    if (nav) {
      const texts = nav.querySelectorAll('[dir="auto"] span, span[dir="auto"]');
      for (const span of texts) {
        const text = span.textContent.trim();
        if (text && text.length > 1 && text !== '@' + username && !text.startsWith('@') && !/^\d+$/.test(text)) {
          displayName = text;
          break;
        }
      }
    }

    // Only save the banner when viewing the logged-in user's own profile
    const bannerUrl = isOwnProfile(username) ? getBannerUrl() : null;

    return { username, displayName, avatarUrl, profileBannerUrl: bannerUrl };
  }

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getUserInfo') {
      sendResponse(getCurrentUserInfo());
    } else if (message.action === 'ping') {
      sendResponse({ ok: true });
    }
  });
})();

// ─── In-page account switcher ───

(() => {
  if (window.top !== window) return;

  const runtime = globalThis.chrome?.runtime;
  const storage = globalThis.chrome?.storage;
  if (!runtime?.sendMessage || !storage?.local || !storage?.onChanged) return;

  const RAIL_ID = 'twu-switcher-rail';

  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #${RAIL_ID} {
      position: fixed;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      z-index: 99999;
      background: oklch(15% 0.012 255 / 0.78);
      backdrop-filter: blur(12px) saturate(120%);
      -webkit-backdrop-filter: blur(12px) saturate(120%);
      border: 1px solid oklch(38% 0.02 255 / 0.55);
      border-left: none;
      border-radius: 0 10px 10px 0;
      padding: 6px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 2px 0 8px oklch(0% 0 0 / 0.22);
      cursor: grab;
      touch-action: none;
      user-select: none;
    }
    #${RAIL_ID}.twu-collapsed .twu-account {
      display: none;
    }
    #${RAIL_ID} .twu-toggle {
      width: 28px;
      height: 28px;
      border: 1px solid oklch(38% 0.02 255 / 0.45);
      border-radius: 8px;
      background: oklch(22% 0.015 255 / 0.65);
      color: oklch(72% 0.02 255);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 150ms cubic-bezier(0.16, 1, 0.3, 1),
                  border-color 150ms cubic-bezier(0.16, 1, 0.3, 1),
                  color 150ms cubic-bezier(0.16, 1, 0.3, 1),
                  transform 150ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    #${RAIL_ID} .twu-toggle:hover {
      background: oklch(28% 0.02 255 / 0.85);
      border-color: oklch(55% 0.03 255 / 0.65);
      color: oklch(95% 0.005 255);
    }
    #${RAIL_ID} .twu-toggle:active {
      transform: scale(0.94);
    }
    #${RAIL_ID} .twu-account {
      position: relative;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 2px solid transparent;
      padding: 0;
      overflow: hidden;
      cursor: pointer;
      background: oklch(25% 0.018 255);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 150ms cubic-bezier(0.16, 1, 0.3, 1),
                  border-color 150ms cubic-bezier(0.16, 1, 0.3, 1),
                  box-shadow 150ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    #${RAIL_ID} .twu-account.twu-active {
      border-color: oklch(64% 0.2 250 / 0.85);
      box-shadow: 0 0 0 2px oklch(15% 0.012 255 / 0.78);
    }
    #${RAIL_ID} .twu-account img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    #${RAIL_ID} .twu-account .twu-ph {
      color: oklch(95% 0.005 255);
      font-size: 14px;
      font-weight: 600;
    }
    #${RAIL_ID} .twu-account[data-title]::after {
      content: attr(data-title);
      position: absolute;
      left: calc(100% + 8px);
      top: 50%;
      transform: translateY(-50%) scale(0.96);
      padding: 4px 8px;
      background: oklch(18% 0.015 255 / 0.92);
      color: oklch(95% 0.005 255);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      border-radius: 6px;
      border: 1px solid oklch(40% 0.02 255 / 0.5);
      opacity: 0;
      pointer-events: none;
      transition: opacity 150ms cubic-bezier(0.16, 1, 0.3, 1),
                  transform 150ms cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 100000;
    }
    #${RAIL_ID} .twu-account:hover[data-title]::after,
    #${RAIL_ID} .twu-account:focus-visible[data-title]::after {
      opacity: 1;
      transform: translateY(-50%) scale(1);
    }
    #${RAIL_ID} .twu-account:hover {
      transform: scale(1.15);
      z-index: 2;
    }
    #${RAIL_ID} .twu-account img {
      -webkit-user-drag: none;
      transition: opacity 150ms cubic-bezier(0.16, 1, 0.3, 1), filter 200ms ease;
    }
    #${RAIL_ID} .twu-account.twu-expired img,
    #${RAIL_ID} .twu-account.twu-expired .twu-ph {
      filter: grayscale(1) opacity(0.45);
    }
    #${RAIL_ID} .twu-account.twu-expired::before {
      content: '';
      position: absolute;
      top: -2px;
      right: -2px;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: oklch(62% 0.2 25);
      border: 2px solid oklch(15% 0.012 255);
      z-index: 1;
    }
    #${RAIL_ID} .twu-account.twu-fail {
      outline: 2px solid oklch(62% 0.2 25);
      outline-offset: 2px;
    }
    #${RAIL_ID}.twu-dragging {
      cursor: grabbing;
    }
    #${RAIL_ID}.twu-dragging .twu-account {
      pointer-events: none;
    }
    #${RAIL_ID}.twu-side-right {
      left: auto;
      border-left: 1px solid oklch(38% 0.02 255 / 0.55);
      border-right: none;
      border-radius: 10px 0 0 10px;
      box-shadow: -2px 0 8px oklch(0% 0 0 / 0.22);
    }
    #${RAIL_ID}.twu-side-right .twu-account[data-title]::after {
      left: auto;
      right: calc(100% + 8px);
    }
  `;
  document.head.appendChild(styleEl);

  const rail = document.createElement('div');
  rail.id = RAIL_ID;

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'twu-toggle';
  toggleBtn.title = 'Collapse / expand account switcher';
  rail.appendChild(toggleBtn);

  let sessions = [];
  let currentUserId = null;
  let enabled = true;
  let switching = false;
  let switchTimeout = null;
  let railTopPct = 0.5;
  let railSide = 'left';
  let dragStart = null;
  let dragging = false;
  let suppressClick = false;

  function decodeTwid(twid) {
    try {
      const raw = decodeURIComponent(twid || '');
      return raw.startsWith('u=') ? raw.slice(2) : raw;
    } catch {
      return twid || '';
    }
  }

  function clearSwitch() {
    switching = false;
    if (switchTimeout) {
      clearTimeout(switchTimeout);
      switchTimeout = null;
    }
  }

  function sendRuntimeMessage(message) {
    const currentRuntime = globalThis.chrome?.runtime;
    if (typeof currentRuntime?.sendMessage !== 'function') return Promise.resolve(null);
    try {
      return Promise.resolve(currentRuntime.sendMessage(message));
    } catch {
      return Promise.resolve(null);
    }
  }

  function triggerSwitch(session, btn, source) {
    if (switching) return;
    switching = true;
    clearTimeout(switchTimeout);
    switchTimeout = setTimeout(() => { switching = false; }, 5000);
    sendRuntimeMessage({ action: 'switchSession', id: session.id, source })
      .then((result) => {
        switching = false;
        clearTimeout(switchTimeout);
        if (result && !result.success && btn) {
          btn.classList.add('twu-fail');
          setTimeout(() => btn.classList.remove('twu-fail'), 2500);
        }
      })
      .catch(() => {
        switching = false;
        clearTimeout(switchTimeout);
      });
  }

  function clampRailTop(top) {
    const railHeight = rail.offsetHeight || 0;
    const maxTop = Math.max(0, window.innerHeight - railHeight);
    const minTop = Math.min(8, maxTop);
    return Math.max(minTop, Math.min(Math.max(minTop, maxTop - 8), top));
  }

  function applyRailPosition() {
    const railHeight = rail.offsetHeight || 0;
    const maxTop = Math.max(0, window.innerHeight - railHeight);
    rail.style.top = clampRailTop(railTopPct * maxTop) + 'px';
    rail.style.transform = 'none';
    rail.style.left = railSide === 'left' ? '0' : 'auto';
    rail.style.right = railSide === 'right' ? '0' : 'auto';
    rail.classList.toggle('twu-side-right', railSide === 'right');
  }

  function loadRailPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem('twu-switcher-pos') || 'null');
      if (saved && typeof saved.topPct === 'number') {
        railTopPct = Math.max(0, Math.min(1, saved.topPct));
        if (saved.side === 'left' || saved.side === 'right') railSide = saved.side;
      }
    } catch {}
  }

  function applyCollapsed() {
    let collapsed = false;
    try { collapsed = localStorage.getItem('twu-switcher-collapsed') === '1'; } catch {}
    rail.classList.toggle('twu-collapsed', collapsed);
    toggleBtn.textContent = collapsed ? '›' : '‹';
  }

  toggleBtn.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    const collapsed = !rail.classList.contains('twu-collapsed');
    try { localStorage.setItem('twu-switcher-collapsed', collapsed ? '1' : '0'); } catch {}
    applyCollapsed();
  });

  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    let startTop = parseFloat(rail.style.top);
    if (!Number.isFinite(startTop)) startTop = rail.getBoundingClientRect().top;
    dragStart = { x: e.clientX, y: e.clientY, startTop };
    dragging = false;
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (!dragging && Math.hypot(dx, dy) > 5) {
      dragging = true;
      rail.classList.add('twu-dragging');
    }
    if (!dragging) return;
    e.preventDefault();
    rail.style.top = clampRailTop(dragStart.startTop + dy) + 'px';
    const side = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
    if (side !== railSide) {
      railSide = side;
      rail.style.left = side === 'left' ? '0' : 'auto';
      rail.style.right = side === 'right' ? '0' : 'auto';
      rail.classList.toggle('twu-side-right', side === 'right');
    }
  });

  document.addEventListener('pointerup', () => {
    if (!dragStart) return;
    dragStart = null;
    if (!dragging) return;
    dragging = false;
    rail.classList.remove('twu-dragging');
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 500);
    const railHeight = rail.offsetHeight;
    const maxTop = Math.max(1, window.innerHeight - railHeight);
    const top = parseFloat(rail.style.top);
    if (Number.isFinite(top)) {
      railTopPct = Math.max(0, Math.min(1, top / maxTop));
    }
    try { localStorage.setItem('twu-switcher-pos', JSON.stringify({ topPct: railTopPct, side: railSide })); } catch {}
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // Alt+Shift+Arrow — plain arrows would hijack page scrolling, and
    // Alt+Arrow alone collides with the browser's Back/Forward shortcuts.
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (switching || sessions.length < 2) return;
    const target = e.target;
    const editable = target && (target.isContentEditable ||
      (target.closest && target.closest('input, textarea, select, [contenteditable]')));
    const activeEl = document.activeElement;
    const activeEditable = activeEl && (activeEl.isContentEditable ||
      (activeEl.closest && activeEl.closest('input, textarea, select, [contenteditable]')));
    if (editable || activeEditable) return;
    e.preventDefault();
    const activeIndex = sessions.findIndex(s =>
      currentUserId && s.twid && decodeTwid(s.twid) === currentUserId);
    let nextIndex;
    if (activeIndex === -1) {
      nextIndex = e.key === 'ArrowRight' ? 0 : sessions.length - 1;
    } else if (e.key === 'ArrowRight') {
      nextIndex = (activeIndex + 1) % sessions.length;
    } else {
      nextIndex = (activeIndex - 1 + sessions.length) % sessions.length;
    }
    const avatars = rail.querySelectorAll('.twu-account');
    triggerSwitch(sessions[nextIndex], avatars[nextIndex] || null, 'hotkey');
  });

  window.addEventListener('resize', () => applyRailPosition());

  function render() {
    clearSwitch();
    applyCollapsed();
    rail.querySelectorAll('.twu-account').forEach(el => el.remove());
    if (!enabled || sessions.length === 0) {
      rail.style.display = 'none';
      return;
    }
    rail.style.display = 'flex';
    for (const session of sessions) {
      const btn = document.createElement('button');
      btn.className = 'twu-account';
      const dead = !!session.expired;
      const title = (session.displayName || session.username || 'Account') + (dead ? ' (expired)' : '');
      btn.title = title;
      btn.dataset.title = title;
      btn.setAttribute('aria-label', 'Switch to ' + title);
      if (dead) btn.classList.add('twu-expired');
      if (currentUserId && session.twid && decodeTwid(session.twid) === currentUserId) {
        btn.classList.add('twu-active');
      }
      if (session.avatarUrl) {
        const img = document.createElement('img');
        img.src = session.avatarUrl;
        img.alt = '';
        img.loading = 'lazy';
        btn.appendChild(img);
      } else {
        const ph = document.createElement('span');
        ph.className = 'twu-ph';
        ph.textContent = ((session.displayName || session.username || 'A')[0] || 'A').toUpperCase();
        btn.appendChild(ph);
      }
      btn.addEventListener('click', () => {
        if (suppressClick) { suppressClick = false; return; }
        triggerSwitch(session, btn, 'menu');
      });
      rail.appendChild(btn);
    }
    applyRailPosition();
  }

  async function refresh() {
    try {
      const [sessionsResult, current] = await Promise.all([
        sendRuntimeMessage({ action: 'getSessions' }),
        sendRuntimeMessage({ action: 'getCurrentSession' })
      ]);
      sessions = sessionsResult || [];
      currentUserId = (current && current.userId) || null;
      render();
    } catch {}
  }

  storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.sessions) refresh();
    if (changes.uiInpageSwitcher) {
      enabled = changes.uiInpageSwitcher.newValue !== false;
      render();
    }
  });

  storage.local.get('uiInpageSwitcher').then((data) => {
    enabled = data.uiInpageSwitcher !== false;
    loadRailPosition();
    (document.body || document.documentElement).appendChild(rail);
    refresh();
  });
})();
