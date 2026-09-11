// ─── Cookie Management ───

// Flag to suppress "unsaved account" detection while we swap cookies ourselves
let _cookieSwapActive = false;

// Generation counter: bumped whenever a user-initiated switch happens so
// background sweeps (unread counts / stats) can abort mid-flight instead of
// restoring a stale cookie snapshot over the new session.
let _cookieSwapGeneration = 0;

// Global queue for ALL cookie-jar mutations. Switches and background sweeps
// must never interleave: a sweep's restore step used to re-apply its start-of-
// sweep snapshot, bouncing the user back to the previous account.
let _cookieOpQueue = Promise.resolve();
function serializeCookieOp(fn) {
  const run = _cookieOpQueue.then(
    () => { _cookieSwapActive = true; return fn(); },
    () => { _cookieSwapActive = true; return fn(); }
  );
  _cookieOpQueue = run.then(
    () => { _cookieSwapActive = false; },
    () => { _cookieSwapActive = false; }
  );
  return run;
}

async function getCookies() {
  const c1 = await chrome.cookies.getAll({ domain: '.x.com' });
  const c2 = await chrome.cookies.getAll({ domain: '.twitter.com' });
  return [...c1, ...c2];
}

async function getAuthToken() {
  const cookies = await getCookies();
  const authToken = cookies.find(c => c.name === 'auth_token');
  const ct0 = cookies.find(c => c.name === 'ct0');
  const twid = cookies.find(c => c.name === 'twid');
  return {
    auth_token: authToken?.value || null,
    ct0: ct0?.value || null,
    twid: twid?.value || null,
    allCookies: cookies.filter(c => ['auth_token', 'ct0', 'twid', 'guest_id', 'personalization_id'].includes(c.name))
  };
}

async function clearTwitterCookies() {
  const cookies = await getCookies();
  await Promise.all(cookies.map(cookie => {
    const url = `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`;
    return chrome.cookies.remove({ url, name: cookie.name }).catch(() => {});
  }));
}

async function setCookies(cookieData) {
  await Promise.all(cookieData.map(cookie => {
    const url = `https://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`;
    return chrome.cookies.set({
      url, name: cookie.name, value: cookie.value,
      domain: cookie.domain, path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: cookie.httpOnly || false,
      expirationDate: cookie.expirationDate || undefined
    }).catch(() => {});
  }));
}

// ─── Session CRUD ───

async function getSessions() {
  const data = await chrome.storage.local.get('sessions');
  return data.sessions || [];
}

async function saveCurrentSession(userInfo) {
  const tokenData = await getAuthToken();
  if (!tokenData.auth_token) return { success: false, error: 'Not logged in' };

  const sessions = await getSessions();
  if (sessions.findIndex(s => s.auth_token === tokenData.auth_token) !== -1) {
    return { success: false, error: 'Already saved' };
  }

  let info = userInfo;
  if (!info || !info.username) info = await getUserInfoFromTabs();

  const session = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    username: info?.username || null,
    displayName: info?.displayName || info?.username || `Account ${sessions.length + 1}`,
    avatarUrl: info?.avatarUrl || null,
    profileBannerUrl: info?.profileBannerUrl || null,
    auth_token: tokenData.auth_token, ct0: tokenData.ct0, twid: tokenData.twid,
    cookies: tokenData.allCookies, createdAt: Date.now()
  };

  sessions.push(session);
  await chrome.storage.local.set({ sessions });
  await updateBadge();
  await rebuildContextMenu();
  return { success: true, session };
}

async function deleteSession(id) {
  const sessions = await getSessions();
  const filtered = sessions.filter(s => s.id !== id);
  await chrome.storage.local.set({ sessions: filtered });
  await updateBadge();
  await rebuildContextMenu();
  return { success: true };
}

function getSessionName(s) {
  return s?.displayName || s?.username || 'Account';
}

async function logSwitch(fromSession, toSession, source) {
  try {
    const data = await chrome.storage.local.get('switchLog');
    const log = data.switchLog || [];
    log.unshift({
      at: Date.now(),
      from: fromSession ? { id: fromSession.id, name: getSessionName(fromSession) } : null,
      to: { id: toSession.id, name: getSessionName(toSession) },
      source: source || 'popup'
    });
    await chrome.storage.local.set({ switchLog: log.slice(0, 200) });
  } catch {}
}

async function switchSession(id, openNewTab = false, source = 'popup') {
  const sessions = await getSessions();
  const session = sessions.find(s => s.id === id);
  if (!session) return { success: false, error: 'Session not found' };

  const tokenBefore = await getAuthToken();
  const fromSession = tokenBefore.auth_token
    ? sessions.find(s => s.auth_token === tokenBefore.auth_token) || null
    : null;

  // Abort any in-flight background sweep (unread counts / stats) so it cannot
  // restore a stale cookie snapshot over our switch.
  _cookieSwapGeneration++;

  // Swap, then validate the target session is actually alive (HEAD /home:
  // 302 → bounced to login → cookies are dead). Reloads happen inside the
  // serialized op so a queued sweep can't swap cookies mid-navigation.
  let expired = false;
  await serializeCookieOp(async () => {
    await clearTwitterCookies();
    await setCookies(session.cookies);
    try {
      const res = await fetch('https://x.com/home', { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
      expired = res.status === 302;
    } catch {}
    if (!expired) {
      if (openNewTab) {
        await chrome.tabs.create({ url: 'https://x.com' });
      } else {
        const tabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] });
        for (const tab of tabs) {
          await chrome.tabs.reload(tab.id).catch(() => {});
        }
      }
    }
  });

  if (expired) {
    session.expired = true;
    await chrome.storage.local.set({ sessions });
    await updateBadge();
    await rebuildContextMenu();
    return { success: false, error: 'Cookies expired', expired: true };
  }
  if (session.expired) {
    session.expired = false;
    await chrome.storage.local.set({ sessions });
  }

  // Always refresh ct0 after the switch: a stale csrf pair with the new
  // auth_token causes 403 blips and confusing redirects on x.com.
  // Detached + serialized so it reads the jar at its own turn.
  void serializeCookieOp(async () => {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const newCt0 = await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' });
      if (newCt0?.value && newCt0.value !== session.ct0) {
        session.ct0 = newCt0.value;
        const existing = session.cookies.find(c => c.name === 'ct0');
        if (existing) existing.value = newCt0.value;
        else session.cookies.push({ name: 'ct0', value: newCt0.value, domain: '.x.com', path: '/', secure: true, httpOnly: false });
        await chrome.storage.local.set({ sessions });
      }
    } catch {}
  });

  await updateBadge();
  await logSwitch(fromSession, session, source);
  return { success: true };
}

async function renameSession(id, label) {
  const sessions = await getSessions();
  const session = sessions.find(s => s.id === id);
  if (!session) return { success: false, error: 'Not found' };
  session.displayName = label;
  session.label = label;
  await chrome.storage.local.set({ sessions });
  await rebuildContextMenu();
  return { success: true };
}

async function reorderSessions(orderedIds) {
  const sessions = await getSessions();
  const map = new Map(sessions.map(s => [s.id, s]));
  const reordered = [];
  for (const id of orderedIds) { const s = map.get(id); if (s) reordered.push(s); }
  for (const s of sessions) { if (!orderedIds.includes(s.id)) reordered.push(s); }
  await chrome.storage.local.set({ sessions: reordered });
  await rebuildContextMenu();
  return { success: true };
}

async function updateSessionInfo(id, userInfo) {
  const sessions = await getSessions();
  const session = sessions.find(s => s.id === id);
  if (!session) return { success: false, error: 'Not found' };
  if (userInfo.username) session.username = userInfo.username;
  if (userInfo.displayName) session.displayName = userInfo.displayName;
  if (userInfo.avatarUrl) session.avatarUrl = userInfo.avatarUrl;
  if (userInfo.profileBannerUrl) session.profileBannerUrl = userInfo.profileBannerUrl;
  await chrome.storage.local.set({ sessions });
  return { success: true, session };
}

async function getCurrentSession() {
  const tokenData = await getAuthToken();
  if (!tokenData.auth_token) return { isLoggedIn: false, savedSession: null };
  const sessions = await getSessions();
  const savedSession = sessions.find(s => s.auth_token === tokenData.auth_token) || null;
  let userId = null;
  if (tokenData.twid) {
    try { userId = decodeURIComponent(tokenData.twid).replace('u=', ''); } catch { userId = tokenData.twid; }
  }
  return { isLoggedIn: true, savedSession, userId, auth_token: tokenData.auth_token };
}

// ─── User Info from Tabs ───

async function getUserInfoFromTabs() {
  const tabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] });
  for (const tab of tabs) {
    try { await chrome.tabs.sendMessage(tab.id, { action: 'ping' }); } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
          world: 'ISOLATED'
        });
      } catch {}
    }
    try {
      const info = await chrome.tabs.sendMessage(tab.id, { action: 'getUserInfo' });
      if (info?.username) return info;
    } catch {}
  }
  return null;
}

// ─── Groups ───

async function getGroups() {
  const data = await chrome.storage.local.get('groups');
  return data.groups || [];
}

async function getSwitchLog() {
  const data = await chrome.storage.local.get('switchLog');
  return data.switchLog || [];
}

async function clearSwitchLog() {
  await chrome.storage.local.set({ switchLog: [] });
  return { success: true };
}

async function addGroup(name, color) {
  const groups = await getGroups();
  const group = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, color: color || '#1d9bf0', createdAt: Date.now() };
  groups.push(group);
  await chrome.storage.local.set({ groups });
  return { success: true, group };
}

async function updateGroup(id, name, color) {
  const groups = await getGroups();
  const group = groups.find(g => g.id === id);
  if (!group) return { success: false, error: 'Not found' };
  if (name) group.name = name;
  if (color) group.color = color;
  await chrome.storage.local.set({ groups });
  return { success: true, group };
}

async function deleteGroup(id) {
  const groups = await getGroups();
  await chrome.storage.local.set({ groups: groups.filter(g => g.id !== id) });
  const sessions = await getSessions();
  for (const s of sessions) { if (s.groupId === id) s.groupId = null; }
  await chrome.storage.local.set({ sessions });
  return { success: true };
}

async function assignGroup(sessionId, groupId) {
  const sessions = await getSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return { success: false };
  session.groupId = groupId;
  await chrome.storage.local.set({ sessions });
  return { success: true };
}

// ─── Encryption ───

async function encryptData(data, password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(data)));
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0); combined.set(iv, salt.length); combined.set(new Uint8Array(encrypted), salt.length + iv.length);
  let binary = ''; for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

async function decryptData(encryptedBase64, password) {
  const encoder = new TextEncoder();
  const binary = atob(encryptedBase64);
  const combined = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) combined[i] = binary.charCodeAt(i);
  const salt = combined.slice(0, 16), iv = combined.slice(16, 28), ciphertext = combined.slice(28);
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function exportSessions(password) {
  const sessions = await getSessions();
  if (sessions.length === 0) return { success: false, error: 'No accounts saved' };
  return { success: true, data: await encryptData(sessions, password), count: sessions.length };
}

async function importSessions(encryptedData, password, mode) {
  let imported;
  try { imported = await decryptData(encryptedData, password); } catch { return { success: false, error: 'Wrong password or corrupted file' }; }
  if (!Array.isArray(imported)) return { success: false, error: 'Invalid file format' };
  const current = await getSessions();
  if (mode === 'merge') {
    const existingTokens = new Set(current.map(s => s.auth_token));
    let added = 0;
    for (const session of imported) {
      if (!existingTokens.has(session.auth_token)) {
        session.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        current.push(session); added++;
      }
    }
    await chrome.storage.local.set({ sessions: current });
    return { success: true, count: added, total: current.length };
  } else {
    const newSessions = imported.map(s => { s.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); return s; });
    await chrome.storage.local.set({ sessions: newSessions });
    return { success: true, count: newSessions.length, total: newSessions.length };
  }
}

async function importByCookie(authToken, ct0, twid, userInfo) {
  if (!authToken) return { success: false, error: 'auth_token is required' };
  const sessions = await getSessions();
  if (sessions.findIndex(s => s.auth_token === authToken) !== -1) return { success: false, error: 'Already saved' };
  const cookies = [{ name: 'auth_token', value: authToken, domain: '.x.com', path: '/', secure: true, httpOnly: true }];
  if (ct0) cookies.push({ name: 'ct0', value: ct0, domain: '.x.com', path: '/', secure: true, httpOnly: false });
  if (twid) cookies.push({ name: 'twid', value: twid, domain: '.x.com', path: '/', secure: true, httpOnly: false });
  const session = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    username: userInfo?.username || null,
    displayName: userInfo?.displayName || userInfo?.username || `Account ${sessions.length + 1}`,
    avatarUrl: userInfo?.avatarUrl || null,
    profileBannerUrl: userInfo?.profileBannerUrl || null,
    auth_token: authToken, ct0: ct0 || null, twid: twid || null,
    cookies, createdAt: Date.now()
  };
  sessions.push(session);
  await chrome.storage.local.set({ sessions });
  await updateBadge();
  await rebuildContextMenu();
  return { success: true, session };
}

async function getCurrentCookies() {
  const d = await getAuthToken();
  return { auth_token: d.auth_token, ct0: d.ct0, twid: d.twid };
}

// ─── Badge ───

async function updateBadge() {
  const tokenData = await getAuthToken();
  if (!tokenData.auth_token) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const sessions = await getSessions();
  const idx = sessions.findIndex(s => s.auth_token === tokenData.auth_token);
  if (idx !== -1) {
    const { accentColor } = await chrome.storage.local.get('accentColor');
    await chrome.action.setBadgeText({ text: String(idx + 1) });
    await chrome.action.setBadgeBackgroundColor({ color: accentColor || '#1d9bf0' });
  } else {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ffd400' });
  }
}

// ─── Context Menu ───

async function rebuildContextMenu() {
  await chrome.contextMenus.removeAll();
  const sessions = await getSessions();
  if (sessions.length === 0) return;

  chrome.contextMenus.create({ id: 'header', title: 'Switch Twitter Account', contexts: ['action'], enabled: false });

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const name = session.displayName || session.username || `Account ${i + 1}`;
    const shortcut = i < 9 ? `Ctrl+Shift+${i + 1}` : '';
    chrome.contextMenus.create({
      id: `switch-${session.id}`,
      title: `${name}${shortcut ? ' (' + shortcut + ')' : ''}`,
      contexts: ['action']
    });
  }
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId.startsWith('switch-')) {
    const id = info.menuItemId.replace('switch-', '');
    await switchSession(id, false, 'menu');
  }
});

// ─── Keyboard Shortcuts ───

chrome.commands.onCommand.addListener(async (command) => {
  const match = command.match(/^switch-(\d+)$/);
  if (!match) return;
  const index = parseInt(match[1]) - 1;
  const sessions = await getSessions();
  if (index >= 0 && index < sessions.length) {
    await switchSession(sessions[index].id, false, 'hotkey');
  }
});

// ─── Auto-Detect & Expiry Check ───

chrome.cookies.onChanged.addListener(async (changeInfo) => {
  if (_cookieSwapActive) return; // ignore our own temporary cookie swaps
  if (!changeInfo.removed && changeInfo.cookie.name === 'auth_token' &&
      (changeInfo.cookie.domain.includes('x.com') || changeInfo.cookie.domain.includes('twitter.com'))) {
    const tokenData = await getAuthToken();
    if (!tokenData.auth_token) return;
    const sessions = await getSessions();
    const saved = sessions.find(s => s.auth_token === tokenData.auth_token);
    if (!saved) {
      const count = sessions.length;
      await chrome.storage.local.set({ 
        unsavedDetected: true,
        unsavedAuthToken: tokenData.auth_token
      });
      await updateBadge();
    }
    await updateBadge();
  }
});

chrome.alarms.create('checkExpiry', { periodInMinutes: 60 });
// Note: no periodic unread polling by design — automatic cookie swaps on a
// fixed cadence look bot-like. Unread counts refresh only when the user
// opens the popup/dashboard (with a stale threshold) or presses the button.
// Warm the cache once at browser startup so counts are ready on first open.
chrome.runtime.onStartup.addListener(() => {
  fetchUnreadCounts().catch(() => {});
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkExpiry') {
    const tokenData = await getAuthToken();
    if (!tokenData.auth_token) return;
    try {
      const res = await fetch('https://x.com/home', { method: 'HEAD', redirect: 'manual' });
      if (res.status === 302) {
        const sessions = await getSessions();
        const saved = sessions.find(s => s.auth_token === tokenData.auth_token);
        if (saved) {
          saved.expired = true;
          await chrome.storage.local.set({ sessions });
        }
      }
    } catch {}
    await updateBadge();
  }
});

// ─── GraphQL query ID resolution ───

// GraphQL query ID cache — auto-resolved on first use
const _queryIdCache = {};
// Diagnostics from the last resolveQueryId attempt (for user-facing errors)
let _lastQueryIdDiag = '';

// Persisted query ID store (survives SW restarts)
async function getPersistedQueryIds() {
  const data = await chrome.storage.local.get('queryIds');
  return data.queryIds || {};
}

// Resolve a GraphQL query ID via, in order:
//   1. memory / storage cache
//   2. performance-timeline sniffing from open x.com tabs (works for any op the page has requested)
//   3. hardcoded fallbacks known to work on recent x.com builds
async function resolveQueryId(operationName) {
  _lastQueryIdDiag = '';
  if (_queryIdCache[operationName]) return _queryIdCache[operationName];

  // 1. persisted cache
  try {
    const persisted = await getPersistedQueryIds();
    if (persisted[operationName]) {
      _queryIdCache[operationName] = persisted[operationName];
      return persisted[operationName];
    }
  } catch {}

  // 2. performance-timeline sniffing from open x.com tabs.
  // Uses chrome.scripting.executeScript so it works even in tabs whose
  // content script predates the last extension reload.
  let sniffDiag = '';
  try {
    const tabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] });
    if (!tabs.length) {
      sniffDiag = 'no x.com tab open';
    } else {
      let sniffed = null;
      for (const tab of tabs) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (opName) => {
              try {
                const entries = performance.getEntriesByType('resource') || [];
                const re = new RegExp('/i/api/graphql/([^/]+)/(?:' + opName + ')(\\?|$)');
                for (const e of entries) {
                  const m = (e.name || '').match(re);
                  if (m) return m[1];
                }
              } catch {}
              return null;
            },
            args: [operationName]
          });
          const queryId = results?.[0]?.result;
          if (queryId) { sniffed = queryId; break; }
        } catch (err) {
          sniffDiag = 'tab error: ' + (err.message || 'failed');
        }
      }
      if (sniffed) {
        _queryIdCache[operationName] = sniffed;
        try {
          const store = await getPersistedQueryIds();
          store[operationName] = sniffed;
          await chrome.storage.local.set({ queryIds: store });
        } catch {}
        return sniffed;
      }
      if (!sniffDiag) {
        sniffDiag = `no ${operationName} request in ${tabs.length} tab(s)`;
      }
    }
  } catch (err) {
    sniffDiag = err.message || 'failed';
  }

  // 3. hardcoded fallbacks — queryIds known to work as of recent x.com builds
  const FALLBACK_QUERY_IDS = {
    UserByScreenName: 'IGgvgiOx4QZndDHuD3x9TQ'
  };
  if (FALLBACK_QUERY_IDS[operationName]) {
    _queryIdCache[operationName] = FALLBACK_QUERY_IDS[operationName];
    return FALLBACK_QUERY_IDS[operationName];
  }

  _lastQueryIdDiag = 'sniffer: ' + sniffDiag;
  return null;
}

// ─── Account Dashboard / Notifications (Internal API) ───

// Public web bearer token (constant, used by x.com web itself)
const X_WEB_BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

function decodeTwid(twid) {
  try {
    const raw = decodeURIComponent(twid || '');
    return raw.startsWith('u=') ? raw.slice(2) : raw;
  } catch {
    return twid || '';
  }
}

async function getXsrfToken(session) {
  if (session?.ct0) return session.ct0;
  const cookies = await getCookies();
  const ct0 = cookies.find(c => c.name === 'ct0');
  return ct0?.value || '';
}

async function xapiFetch(path) {
  const ct0 = await getXsrfToken(null);
  const res = await fetch('https://x.com' + path, {
    headers: {
      'Authorization': X_WEB_BEARER,
      'X-Csrf-Token': ct0,
      'X-Twitter-Auth-Type': 'OAuth2Session',
      'X-Twitter-Active-User': 'yes',
      'Accept': 'application/json'
    },
    credentials: 'include',
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    let hint = '';
    try {
      const body = await res.text();
      if (body && !body.trimStart().startsWith('<')) hint = ': ' + body.slice(0, 140);
    } catch {}
    if (res.status === 401 || res.status === 403) throw new Error('Unauthorized' + hint);
    throw new Error('HTTP ' + res.status + hint);
  }
  return res.json();
}

// Temporarily swaps browser cookies to `session`, runs fn(), then restores.
// Takes a FULL snapshot of the active session's cookies so the active login is
// never degraded by the swap (saved sessions only store a small cookie subset).
async function withSessionCookies(session, fn) {
  const tokenBefore = await getAuthToken();
  const sessions = await getSessions();
  const activeSession = tokenBefore.auth_token
    ? sessions.find(s => s.auth_token === tokenBefore.auth_token) || null
    : null;

  if (!activeSession || activeSession.id === session.id) {
    return fn();
  }

  return serializeCookieOp(async () => {
    const fullActiveCookies = await getCookies();
    try {
      await clearTwitterCookies();
      await setCookies(session.cookies);
      return await fn();
    } finally {
      try {
        await clearTwitterCookies();
        await setCookies(fullActiveCookies);
      } catch {}
    }
  });
}

async function getAccountStatsStore() {
  const data = await chrome.storage.local.get('accountStats');
  return data.accountStats || {};
}

// Standard feature switches the web client sends for user queries
const USER_QUERY_FEATURES = JSON.stringify({
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true
});

async function graphqlUserQuery(operationName, variables, queryId) {
  if (!queryId) throw new Error('No query ID for ' + operationName);
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: USER_QUERY_FEATURES
  });
  const ct0 = await getXsrfToken(null);
  const res = await fetch(`https://x.com/i/api/graphql/${queryId}/${operationName}?${params.toString()}`, {
    headers: {
      'Authorization': X_WEB_BEARER,
      'X-Csrf-Token': ct0,
      'X-Twitter-Auth-Type': 'OAuth2Session',
      'X-Twitter-Active-User': 'yes',
      'Accept': 'application/json'
    },
    credentials: 'include',
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    let hint = '';
    try {
      const body = await res.text();
      if (body && !body.trimStart().startsWith('<')) hint = ': ' + body.slice(0, 140);
    } catch {}
    throw new Error('HTTP ' + res.status + hint);
  }
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message || 'GraphQL error');
  return data;
}

function parseUserResult(result) {
  const legacy = result?.legacy || {};
  return {
    followers: legacy.followers_count ?? null,
    following: legacy.friends_count ?? null,
    tweets: legacy.statuses_count ?? null,
    suspended: !!result?.suspended,
    screenName: legacy.screen_name || null,
    fetchedAt: Date.now()
  };
}

async function fetchAccountStats(sessionId) {
  const sessions = await getSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return { success: false, error: 'Session not found' };

  const hasUsername = !!session.username;
  const hasTwid = !!session.twid;
  if (!hasUsername && !hasTwid) {
    const store = await getAccountStatsStore();
    store[sessionId] = { error: 'No identifier', fetchedAt: Date.now() };
    await chrome.storage.local.set({ accountStats: store });
    return { success: false, error: 'No identifier' };
  }

  try {
    let stats;
    try {
      // Primary: legacy v1.1 endpoint
      const data = await withSessionCookies(session, async () => {
        const params = new URLSearchParams();
        if (hasUsername) params.set('screen_name', session.username);
        else params.set('user_id', decodeTwid(session.twid));
        return xapiFetch('/i/api/1.1/users/show.json?' + params.toString());
      });
      stats = {
        followers: data.followers_count ?? null,
        following: data.friends_count ?? null,
        tweets: data.statuses_count ?? null,
        suspended: !!data.suspended,
        screenName: data.screen_name || session.username || null,
        fetchedAt: Date.now()
      };
    } catch (v1Err) {
      // Fallback: GraphQL UserByScreenName / UserByRestId.
      // Resolve the queryId BEFORE the cookie swap — the schema endpoint needs
      // the fully logged-in cookie jar of the active session.
      const operationName = hasUsername ? 'UserByScreenName' : 'UserByRestId';
      const queryId = await resolveQueryId(operationName);
      if (!queryId) {
        throw new Error('No query ID (' + (_lastQueryIdDiag || 'unknown reason') + ')');
      }
      const data = await withSessionCookies(session, async () => {
        if (hasUsername) {
          return graphqlUserQuery(operationName, { screen_name: session.username, withSafetyModeUserFields: true }, queryId);
        }
        return graphqlUserQuery(operationName, { userId: decodeTwid(session.twid) }, queryId);
      });
      const result = data?.data?.user?.result;
      if (!result) throw new Error(v1Err.message);
      stats = parseUserResult(result);
    }

    const store = await getAccountStatsStore();
    store[sessionId] = stats;
    await chrome.storage.local.set({ accountStats: store });

    if (!session.username && stats.screenName) {
      session.username = stats.screenName;
      await chrome.storage.local.set({ sessions });
    }

    return { success: true, stats };
  } catch (err) {
    const store = await getAccountStatsStore();
    store[sessionId] = { error: err.message || 'Fetch failed', fetchedAt: Date.now() };
    await chrome.storage.local.set({ accountStats: store });
    return { success: false, error: err.message || 'Fetch failed' };
  }
}

async function refreshAllStats() {
  const sessions = await getSessions();
  const results = {};
  const myGen = ++_cookieSwapGeneration;
  for (const s of sessions) {
    // Abort if a user-initiated switch happened while we were running
    if (myGen !== _cookieSwapGeneration) break;
    const r = await fetchAccountStats(s.id);
    results[s.id] = r.success ? r.stats : { error: r.error };
  }
  return { success: true, results };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchUnreadCounts() {
  const sessions = await getSessions();
  const counts = {};
  const shapeDiag = {};
  const myGen = ++_cookieSwapGeneration;
  for (const s of sessions) {
    // Abort if a user-initiated switch happened while we were running
    if (myGen !== _cookieSwapGeneration) break;
    try {
      const d = await withSessionCookies(s, () => xapiFetch('/i/api/2/notifications/unread_count.json'));
      // Response shape has changed across builds — probe known fields and
      // normalize strings to numbers, taking the max of anything numeric.
      let n = null;
      for (const candidate of [d.unread_count, d.ntab_unread_count, d.rt_unread_count, d.count, d.total]) {
        const num = Number(candidate);
        if (Number.isFinite(num)) n = Math.max(n ?? 0, num);
      }
      if (n === null) {
        counts[s.id] = null;
        shapeDiag[s.id] = JSON.stringify(d).slice(0, 160);
      } else {
        counts[s.id] = n;
      }
    } catch {
      counts[s.id] = null;
    }
    // Random jitter between accounts so sequential access doesn't look automated
    await sleep(200 + Math.floor(Math.random() * 600));
  }
  await chrome.storage.local.set({ unreadCounts: counts, unreadCountsAt: Date.now(), unreadShapeDiag: shapeDiag });
  const unknownShapes = Object.keys(shapeDiag).length;
  return { success: true, counts, unknownShapes, aborted: myGen !== _cookieSwapGeneration };
}

function normalizeNotifications(data) {
  try {
    const users = data.globalObjects?.users || {};
    const entries = [];
    for (const instr of (data.timeline?.instructions || [])) {
      if (instr.type === 'TimelineAddEntries' || instr.addEntries) {
        entries.push(...(instr.entries || []));
      }
    }
    const items = [];
    for (const entry of entries) {
      const notif = entry?.content?.item?.content?.notification;
      if (!notif) continue;
      const entryUsers = (notif.users || []).map(id => {
        const u = users[id];
        return u ? { name: u.name, screenName: u.screen_name, avatar: u.profile_image_url_https?.replace('_normal', '_mini') || null } : null;
      }).filter(Boolean);
      items.push({
        id: entry.entryId,
        type: notif.type || 'generic',
        text: notif.message?.text || '',
        time: notif.time ? Number(notif.time) * 1000 : null,
        users: entryUsers
      });
    }
    let cursor = null;
    for (const entry of entries) {
      const op = entry?.content?.operation;
      if (op?.cursor?.cursorValue) cursor = op.cursor.cursorValue;
    }
    return { items, cursor };
  } catch {
    return { items: [], cursor: null };
  }
}

async function fetchNotifications(sessionId, cursor) {
  const sessions = await getSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return { success: false, error: 'Session not found' };
  try {
    const data = await withSessionCookies(session, () =>
      xapiFetch('/i/api/2/notifications/all.json?count=30' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    );
    const { items, cursor: nextCursor } = normalizeNotifications(data);
    return { success: true, items, cursor: nextCursor };
  } catch (err) {
    return { success: false, error: err.message || 'Fetch failed' };
  }
}

// ─── Init ───

(async () => {
  await updateBadge();
  await rebuildContextMenu();
})();

// ─── Message Handler ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    saveSession: () => saveCurrentSession(message.userInfo),
    getSessions: () => getSessions(),
    deleteSession: () => deleteSession(message.id),
    switchSession: () => switchSession(message.id, message.openNewTab, message.source),
    renameSession: () => renameSession(message.id, message.label),
    reorderSessions: () => reorderSessions(message.orderedIds),
    updateSessionInfo: () => updateSessionInfo(message.id, message.userInfo),
    exportSessions: () => exportSessions(message.password),
    importSessions: () => importSessions(message.data, message.password, message.mode),
    importByCookie: () => importByCookie(message.authToken, message.ct0, message.twid, message.userInfo),
    getCurrentCookies: () => getCurrentCookies(),
    getCurrentSession: () => getCurrentSession(),
    getGroups: () => getGroups(),
    getSwitchLog: () => getSwitchLog(),
    clearSwitchLog: () => clearSwitchLog(),
    addGroup: () => addGroup(message.name, message.color),
    updateGroup: () => updateGroup(message.id, message.name, message.color),
    deleteGroup: () => deleteGroup(message.id),
    assignGroup: () => assignGroup(message.sessionId, message.groupId),
    getAccountStats: () => getAccountStatsStore(),
    refreshAccountStats: () => fetchAccountStats(message.sessionId),
    refreshAllStats: () => refreshAllStats(),
    fetchUnreadCounts: () => fetchUnreadCounts(),
    getNotifications: () => fetchNotifications(message.sessionId, message.cursor),
    updateBadge: () => updateBadge(),
    openSettings: () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') })
  };
  const handler = handlers[message.action];
  if (handler) { handler().then(sendResponse); return true; }
});
