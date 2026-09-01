const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');
const cookieImport = document.getElementById('cookie-import');
const getCookieBtn = document.getElementById('get-cookie-btn');
const cookieDisplay = document.getElementById('cookie-display');
const fileInput = document.getElementById('file-input');
const messageEl = document.getElementById('message');
const ioModal = document.getElementById('io-modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');

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

// ─── Export ───

exportBtn.addEventListener('click', () => {
  openModal('Export', `
    <p class="modal-desc">Encrypt with password. Same password required to import.</p>
    <input type="password" id="export-password" class="modal-input" placeholder="Password" autofocus>
    <input type="password" id="export-password-confirm" class="modal-input" placeholder="Confirm password">
  `, async () => {
    const pw = modalBody.querySelector('#export-password').value;
    const pwConfirm = modalBody.querySelector('#export-password-confirm').value;
    if (!pw) { showMessage('Enter a password', 'error'); return; }
    if (pw !== pwConfirm) { showMessage('Passwords do not match', 'error'); return; }

    modalConfirm.disabled = true;
    modalConfirm.textContent = 'Encrypting...';

    const result = await chrome.runtime.sendMessage({ action: 'exportSessions', password: pw });
    modalConfirm.disabled = false;
    modalConfirm.textContent = 'Confirm';

    if (result.success) {
      const blob = new Blob([result.data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `twitter-accounts-${date}.tua`;
      a.click();
      URL.revokeObjectURL(url);
      closeModal();
      showMessage(`Exported ${result.count} account${result.count > 1 ? 's' : ''}`);
    } else {
      showMessage(result.error || 'Export failed', 'error');
    }
  });
});

// ─── Import File ───

importBtn.addEventListener('click', () => {
  fileInput.value = '';
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const fileData = ev.target.result;

    openModal('Import', `
      <p class="modal-desc">File: <strong>${escapeHtml(file.name)}</strong></p>
      <input type="password" id="import-password" class="modal-input" placeholder="Password" autofocus>
      <div class="import-mode">
        <label class="radio-label">
          <input type="radio" name="import-mode" value="merge" checked>
          <span>Merge (add to existing)</span>
        </label>
        <label class="radio-label">
          <input type="radio" name="import-mode" value="replace">
          <span>Replace (delete existing)</span>
        </label>
      </div>
    `, async () => {
      const pw = modalBody.querySelector('#import-password').value;
      const mode = modalBody.querySelector('input[name="import-mode"]:checked').value;
      if (!pw) { showMessage('Enter password', 'error'); return; }

      modalConfirm.disabled = true;
      modalConfirm.textContent = 'Decrypting...';

      const result = await chrome.runtime.sendMessage({ action: 'importSessions', data: fileData, password: pw, mode });
      modalConfirm.disabled = false;
      modalConfirm.textContent = 'Confirm';

      if (result.success) {
        closeModal();
        if (mode === 'merge') showMessage(`Added ${result.count} (${result.total} total)`);
        else showMessage(`Imported ${result.count} account${result.count > 1 ? 's' : ''}`);
      } else {
        showMessage(result.error || 'Import failed', 'error');
      }
    });
  };
  reader.readAsText(file);
});

// ─── Cookie Import ───

cookieImport.addEventListener('click', async () => {
  const authToken = document.getElementById('cookie-auth').value.trim();
  const ct0 = document.getElementById('cookie-ct0').value.trim();
  const username = document.getElementById('cookie-username').value.trim();

  if (!authToken) { showMessage('auth_token is required', 'error'); return; }

  const userInfo = username ? { username, displayName: username } : null;
  const result = await chrome.runtime.sendMessage({
    action: 'importByCookie', authToken, ct0: ct0 || null, userInfo
  });

  if (result.success) {
    document.getElementById('cookie-auth').value = '';
    document.getElementById('cookie-ct0').value = '';
    document.getElementById('cookie-username').value = '';
    showMessage('Account added');
  } else {
    showMessage(result.error || 'Import failed', 'error');
  }
});

// ─── Keyboard Shortcuts ───

const shortcutList = document.getElementById('shortcut-list');

function formatShortcut(shortcut) {
  if (!shortcut) return 'Not set';
  return shortcut
    .replace(/(Mac|Windows|Linux|ChromeOS):/g, '')
    .replace(/\+/g, ' + ')
    .replace(/Ctrl/g, 'Ctrl')
    .trim();
}

async function renderShortcuts() {
  try {
    const commands = await chrome.commands.getAll();
    const items = commands.filter(c => c.name.startsWith('switch-'));
    if (items.length === 0) {
      shortcutList.innerHTML = '<p class="s-desc">No switch shortcuts defined.</p>';
      return;
    }
    shortcutList.innerHTML = items.map(c => {
      const num = c.name.replace('switch-', '');
      return `
        <div class="shortcut-item">
          <span class="shortcut-name">Switch to account #${num}</span>
          <span class="shortcut-keys">${escapeHtml(formatShortcut(c.shortcut))}</span>
        </div>
      `;
    }).join('');
  } catch {
    shortcutList.innerHTML = '<p class="s-desc">Unable to load shortcuts.</p>';
  }
}

renderShortcuts();


// ─── Appearance ───

const accentColorInput = document.getElementById('accent-color');
const accentPresets = document.getElementById('accent-presets');
const accentResetBtn = document.getElementById('accent-reset');
const rememberGroupCheckbox = document.getElementById('remember-group');

const ACCENT_PRESETS = ['#1d9bf0', '#f91880', '#7856ff', '#00ba7c', '#ff7a00', '#ffd400', '#ef4444', '#8b5cf6'];

const accentR = document.getElementById('accent-r');
const accentG = document.getElementById('accent-g');
const accentB = document.getElementById('accent-b');

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
  const clamp = v => Math.max(0, Math.min(255, Math.round(Number(v)) || 0));
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('');
}

function syncRgbInputs(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return;
  accentR.value = rgb.r;
  accentG.value = rgb.g;
  accentB.value = rgb.b;
}

function applyAccent(c) {
  if (!c) return;
  const r = document.documentElement.style;
  r.setProperty('--color-accent', c);
  r.setProperty('--color-accent-strong', `color-mix(in srgb, ${c} 82%, white)`);
  r.setProperty('--color-accent-soft', `color-mix(in srgb, ${c} 22%, transparent)`);
}

function renderAccentPresets(current) {
  accentPresets.innerHTML = ACCENT_PRESETS.map(p =>
    `<button class="accent-swatch ${p === current ? 'selected' : ''}" data-color="${p}" style="background: ${p}" title="${p}"></button>`
  ).join('');
  accentPresets.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.addEventListener('click', () => selectAccent(btn.dataset.color));
  });
}

function selectAccent(c) {
  if (!c) return;
  accentColorInput.value = c;
  chrome.storage.local.set({ accentColor: c });
  try { localStorage.setItem('accentColor', c); } catch {}
  applyAccent(c);
  syncRgbInputs(c);
  chrome.runtime.sendMessage({ action: 'updateBadge' });
  renderAccentPresets(c);
}

accentColorInput.addEventListener('input', () => selectAccent(accentColorInput.value));

function onRgbInput() {
  const r = parseInt(accentR.value, 10);
  const g = parseInt(accentG.value, 10);
  const b = parseInt(accentB.value, 10);
  if ([r, g, b].some(v => Number.isNaN(v))) return;
  selectAccent(rgbToHex(r, g, b));
}

accentR.addEventListener('input', onRgbInput);
accentG.addEventListener('input', onRgbInput);
accentB.addEventListener('input', onRgbInput);

accentResetBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove('accentColor');
  try { localStorage.removeItem('accentColor'); } catch {}
  selectAccent('#1d9bf0');
  showMessage('Accent color reset');
});

rememberGroupCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ uiRememberGroup: rememberGroupCheckbox.checked });
});

async function initAppearance() {
  const { accentColor, uiRememberGroup } = await chrome.storage.local.get(['accentColor', 'uiRememberGroup']);
  const c = accentColor || '#1d9bf0';
  accentColorInput.value = c;
  try { localStorage.setItem('accentColor', c); } catch {}
  applyAccent(c);
  syncRgbInputs(c);
  renderAccentPresets(c);
  rememberGroupCheckbox.checked = uiRememberGroup !== false;
}

initAppearance();

// ─── Switch History ───

const historyList = document.getElementById('history-list');
const historyClearBtn = document.getElementById('history-clear-btn');

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function renderHistory() {
  try {
    const log = await chrome.runtime.sendMessage({ action: 'getSwitchLog' });
    if (!Array.isArray(log) || log.length === 0) {
      historyList.innerHTML = '<p class="s-desc">No switches recorded yet.</p>';
      return;
    }
    historyList.innerHTML = log.map(e => `
      <div class="history-item">
        <span class="history-name">${escapeHtml(e.from?.name || '(logged out)')}</span>
        <span class="history-arrow">→</span>
        <span class="history-name history-name-to">${escapeHtml(e.to?.name || '?')}</span>
        <span class="history-meta">${escapeHtml(e.source || '')} · ${formatTimestamp(e.at)}</span>
      </div>
    `).join('');
  } catch {
    historyList.innerHTML = '<p class="s-desc">Unable to load history.</p>';
  }
}

historyClearBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'clearSwitchLog' });
  renderHistory();
  showMessage('History cleared');
});

renderHistory();

// ─── Get Cookies ───

getCookieBtn.addEventListener('click', async () => {
  const cookies = await chrome.runtime.sendMessage({ action: 'getCurrentCookies' });

  cookieDisplay.classList.remove('hidden');
  cookieDisplay.innerHTML = `
    <div class="cookie-field">
      <label>auth_token</label>
      <textarea readonly>${escapeHtml(cookies.auth_token || 'Not logged in')}</textarea>
    </div>
    <div class="cookie-field">
      <label>ct0</label>
      <textarea readonly>${escapeHtml(cookies.ct0 || 'N/A')}</textarea>
    </div>
    <div class="cookie-field">
      <label>twid</label>
      <textarea readonly>${escapeHtml(cookies.twid || 'N/A')}</textarea>
    </div>
    <button id="copy-all-cookies" class="btn btn-secondary" style="width:100%;margin-top:4px;">Copy All</button>
  `;

  document.querySelectorAll('.cookie-field textarea').forEach(ta => {
    ta.addEventListener('click', () => {
      ta.select();
      navigator.clipboard.writeText(ta.value);
    });
  });

  document.getElementById('copy-all-cookies').addEventListener('click', async () => {
    const all = `auth_token: ${cookies.auth_token || 'N/A'}\nct0: ${cookies.ct0 || 'N/A'}\ntwid: ${cookies.twid || 'N/A'}`;
    await navigator.clipboard.writeText(all);
    showMessage('Copied');
  });
});

// ─── Page Integration ───

const inpageSwitcherCheckbox = document.getElementById('inpage-switcher');

inpageSwitcherCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ uiInpageSwitcher: inpageSwitcherCheckbox.checked });
});

async function initInpageSwitcher() {
  const { uiInpageSwitcher } = await chrome.storage.local.get('uiInpageSwitcher');
  inpageSwitcherCheckbox.checked = uiInpageSwitcher !== false;
}

initInpageSwitcher();