/* ── Settings ───────────────────────────────────────────────────────── */
const SETTINGS_DEFAULTS = {
  // Features
  showVagaroSync:       true,
  showMergeDuplicates:  true,
  showVerifyPhones:     true,
  showAiCompose:        true,
  // Sync
  autoSyncOnLogin:      true,
  autoSyncMaxAgeHours:  1,
  smartSync:            true,
  rateLimitRps:         4,
  // Messaging
  confirmBeforeBulkSend: true,
  autosaveBulkDrafts:    true,
  cacheMessages:         true,
  markSentDone:          false,
  messagePageSize:       100,
  // Display
  themeMode:             'system',
  contactsPerPage:       75,
  showNoPhoneWarning:    true,
  cleanupUnknownContacts:false,
  cleanupEmailOnlyContacts:false,
  // AI
  anthropicModel: 'claude-sonnet-4-5',
};

let settings = { ...SETTINGS_DEFAULTS };
const systemThemeQuery = window.matchMedia?.('(prefers-color-scheme: light)');
let settingsInitialized = false;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('app_settings') || '{}');
    settings = { ...SETTINGS_DEFAULTS, ...saved };
  } catch { settings = { ...SETTINGS_DEFAULTS }; }
}

function saveSettings() {
  localStorage.setItem('app_settings', JSON.stringify(settings));
}

function applyTheme() {
  const mode = settings.themeMode || 'system';
  const resolved = mode === 'system'
    ? (systemThemeQuery?.matches ? 'light' : 'dark')
    : mode;
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('#meta-theme-color');
  if (meta) meta.content = resolved === 'light' ? '#ffffff' : '#1c1f27';
}

function applySettings() {
  applyTheme();
  // Feature buttons visibility
  document.querySelectorAll('#btn-vagaro-open').forEach(el =>
    el.classList.toggle('hidden', !settings.showVagaroSync));
  document.querySelectorAll('#btn-dupes-open').forEach(el =>
    el.classList.toggle('hidden', !settings.showMergeDuplicates));
  document.querySelectorAll('#btn-verify').forEach(el =>
    el.classList.toggle('hidden', !settings.showVerifyPhones));
  // AI compose tab
  const modeAiBtn = $('mode-ai');
  if (modeAiBtn) modeAiBtn.classList.toggle('hidden', !settings.showAiCompose);
  // AI settings section
  const aiSection = $('settings-ai-section');
  if (aiSection) aiSection.classList.toggle('hidden', !settings.showAiCompose);
  // Contacts per page
  if (typeof PAGE_SIZE !== 'undefined') {
    window.PAGE_SIZE = settings.contactsPerPage;
  }
  // Re-render if contacts are loaded
  if (allContacts.length) { applyFilters(); }
  // Notify server of rate limit change
  fetch('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rateLimitRps: settings.rateLimitRps }),
  }).catch(() => {});
}

function initSettings() {
  if (settingsInitialized) return;
  settingsInitialized = true;
  loadSettings();
  applySettings();

  const modal = $('modal-settings');
  $('btn-settings').addEventListener('click', () => {
    populateSettingsUI();
    modal.classList.remove('hidden');
  });
  $('btn-settings-close').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
  $('btn-open-credentials')?.addEventListener('click', () => {
    populateSettingsUI();
    modal.classList.remove('hidden');
  });
  $('btn-save-quo-key')?.addEventListener('click', () => {
    const key = $('quo-api-key').value.trim();
    if (!key) {
      const status = $('quo-key-status');
      status.classList.remove('error-msg');
      status.classList.add('muted');
      status.textContent = credentialState.quoApiKeySaved ? 'Saved on server' : 'Enter a key first.';
      return;
    }
    saveCredentialBundle({ quoApiKey: key }, $('quo-key-status'), 'Quo key saved on server.');
  });
  $('btn-db-audit')?.addEventListener('click', auditDatabaseCleanup);
  $('btn-db-clean')?.addEventListener('click', runDatabaseCleanup);
  $('btn-copy-quo-webhook')?.addEventListener('click', () => {
    const url = `${location.origin}/quo-webhook/messages`;
    navigator.clipboard.writeText(url).then(() => {
      const btn = $('btn-copy-quo-webhook');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy URL'; }, 1500);
    });
  });
  initDirectionControls();
  refreshCredentialState().catch(() => {});
}

function formatCleanupStats(s) {
  const q = s.quality || {};
  return [
    `Contacts: ${s.contacts}`,
    `Messages: ${s.messages}`,
    `Unknown contacts: ${s.unknownContacts}`,
    `Email-only contacts: ${q.emailOnly ?? 'n/a'}`,
    `Ready contacts: ${q.ready ?? 'n/a'}`,
    `No-phone contacts: ${q.noPhone ?? 'n/a'}`,
    `Orphan messages: ${s.orphanMessages}`,
    `Stale dismissed duplicate pairs: ${s.orphanDismissedDuplicates}`,
    `Dismissed duplicate pairs: ${s.dismissedDuplicates}`,
  ].join('\n');
}

async function auditDatabaseCleanup() {
  const box = $('db-cleanup-result');
  box.textContent = 'Auditing database…';
  const audit = await fetch('/db/cleanup-audit').then(r => r.json()).catch(e => ({ error: e.message }));
  const dupes = await fetch('/db/find-duplicates').then(r => r.json()).catch(e => ({ total: '?', error: e.message }));
  if (audit.error) { box.textContent = `Audit failed: ${audit.error}`; return; }
  box.textContent = `${formatCleanupStats(audit)}\nDuplicate groups: ${dupes.total}`;
}

async function runDatabaseCleanup() {
  const box = $('db-cleanup-result');
  const includeUnknown = !!settings.cleanupUnknownContacts;
  const includeEmailOnly = !!settings.cleanupEmailOnlyContacts;
  const warning = includeUnknown || includeEmailOnly
    ? 'This will remove selected incomplete local contacts. If those records still exist in Quo, a future sync may bring them back. Continue?'
    : 'This will remove local orphaned message-cache rows and stale dismissed duplicate pairs. Continue?';
  if (!confirm(warning)) return;
  box.textContent = 'Cleaning database…';
  const res = await fetch('/db/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      removeUnknownContacts: includeUnknown,
      removeEmailOnlyContacts: includeEmailOnly,
    }),
  }).then(r => r.json()).catch(e => ({ error: e.message }));
  if (res.error) { box.textContent = `Cleanup failed: ${res.error}`; return; }
  box.textContent =
    `Before:\n${formatCleanupStats(res.before)}\n\nAfter:\n${formatCleanupStats(res.after)}\nDuplicate groups: ${res.duplicates?.total ?? '?'}`;
  await loadFromDb();
}

function populateSettingsUI() {
  updateCredentialIndicators();

  // Checkboxes
  document.querySelectorAll('.toggle input[data-key]').forEach(input => {
    const key = input.dataset.key;
    input.checked = !!settings[key];
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      saveSettings();
      applySettings();
    });
  });

  // Selects
  document.querySelectorAll('select[data-key]').forEach(sel => {
    const key = sel.dataset.key;
    sel.value = settings[key];
    sel.addEventListener('change', () => {
      const val = isNaN(sel.value) ? sel.value : Number(sel.value);
      settings[key] = val;
      // Update PAGE_SIZE immediately
      if (key === 'contactsPerPage') { displayPage = 0; }
      saveSettings();
      applySettings();
    });
  });

  // Sliders
  document.querySelectorAll('input[type=range][data-key]').forEach(slider => {
    const key    = slider.dataset.key;
    slider.value = settings[key];
    updateSliderLabel(slider);
    slider.addEventListener('input', () => {
      settings[key] = Number(slider.value);
      updateSliderLabel(slider);
    });
    slider.addEventListener('change', () => {
      settings[key] = Number(slider.value);
      saveSettings();
      applySettings();
    });
  });

  // Auto-sync row visibility based on toggle
  const syncAgeRow = $('row-sync-age');
  function updateSyncAgeVisibility() {
    if (syncAgeRow) syncAgeRow.style.opacity = settings.autoSyncOnLogin ? '1' : '.4';
  }
  updateSyncAgeVisibility();
  document.querySelector('input[data-key="autoSyncOnLogin"]')
    ?.addEventListener('change', updateSyncAgeVisibility);
}

function updateSliderLabel(slider) {
  const key = slider.dataset.key;
  if (key === 'rateLimitRps') {
    $('rps-label').textContent = `${slider.value} req/s`;
  }
}

let credentialState = {
  quoApiKeySaved: false,
  anthropicApiKeySaved: false,
  vagaroClientId: '',
  vagaroRegion: '',
  vagaroClientSecretSaved: false,
};

function updateCredentialIndicators() {
  const quoStatus = $('quo-key-status');
  if (quoStatus) {
    quoStatus.textContent = credentialState.quoApiKeySaved ? 'Saved on server' : 'Not saved';
    quoStatus.classList.remove('error-msg');
    quoStatus.classList.add('muted');
  }
  const aiStatus = $('ai-key-status');
  if (aiStatus) {
    aiStatus.textContent = credentialState.anthropicApiKeySaved ? 'Saved on server' : 'Not saved';
    aiStatus.classList.remove('error-msg');
    aiStatus.classList.add('muted');
  }
  const vagaroStatus = $('vagaro-cred-status');
  if (vagaroStatus && !vagaroStatus.textContent) {
    vagaroStatus.textContent = (credentialState.vagaroClientId || credentialState.vagaroRegion || credentialState.vagaroClientSecretSaved)
      ? 'Saved on server'
      : 'Not saved';
    vagaroStatus.classList.remove('error-msg');
    vagaroStatus.classList.add('muted');
  }
}

function updateCredentialBanner() {
  const banner = $('credential-banner');
  const text = $('credential-banner-text');
  if (!banner || !text) return;
  const missingQuo = !credentialState.quoApiKeySaved;
  banner.classList.toggle('hidden', !missingQuo);
  if (missingQuo) {
    text.textContent = 'Save your Quo API key in Settings to load contacts, sync messages, and use webhooks.';
  }
}

function showCredentialPrompt(message) {
  const empty = $('view-empty');
  if (!empty) return;
  empty.innerHTML = `
    <div class="empty-icon">🔐</div>
    <p>${esc(message || 'Open Settings to save your Quo API key.')}</p>
  `;
}

async function refreshCredentialState() {
  const res = await fetch('/settings/credentials').then(r => r.json()).catch(() => null);
  if (!res?.data) {
    updateCredentialBanner();
    updateCredentialIndicators();
    return null;
  }
  credentialState = { ...credentialState, ...res.data };
  updateCredentialBanner();
  updateCredentialIndicators();
  if ($('vagaro-client-id') && credentialState.vagaroClientId) {
    $('vagaro-client-id').value = credentialState.vagaroClientId;
  }
  if ($('vagaro-region') && credentialState.vagaroRegion) {
    $('vagaro-region').value = credentialState.vagaroRegion;
  }
  if ($('quo-api-key')) {
    $('quo-api-key').placeholder = credentialState.quoApiKeySaved
      ? 'Quo API key saved on the server'
      : 'Paste Quo API key';
  }
  if ($('ai-anthropic-key')) {
    $('ai-anthropic-key').placeholder = credentialState.anthropicApiKeySaved
      ? 'Anthropic API key saved on the server'
      : 'Anthropic API key (sk-ant-…)';
  }
  if ($('vagaro-client-secret')) {
    $('vagaro-client-secret').placeholder = credentialState.vagaroClientSecretSaved
      ? 'Vagaro client secret saved on the server'
      : 'From Vagaro APIs & Webhooks settings';
  }
  return res.data;
}

async function saveCredentialBundle(updates, statusEl, successText = 'Saved on server.') {
  const res = await fetch('/settings/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  }).then(r => r.json()).catch(e => ({ error: e.message }));
  if (res.error || !res.ok) {
    if (statusEl) {
      statusEl.classList.remove('muted');
      statusEl.classList.add('error-msg');
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = res.error || 'Save failed.';
    }
    return false;
  }
  credentialState = { ...credentialState, ...(res.data || {}) };
  if (Object.prototype.hasOwnProperty.call(updates, 'quoApiKey')) {
    apiKey = String(updates.quoApiKey || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'quoApiKey') && $('quo-api-key')) {
    $('quo-api-key').value = '';
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'anthropicApiKey') && $('ai-anthropic-key')) {
    $('ai-anthropic-key').value = '';
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'vagaroClientSecret') && $('vagaro-client-secret')) {
    $('vagaro-client-secret').value = '';
  }
  updateCredentialBanner();
  updateCredentialIndicators();
  if (Object.prototype.hasOwnProperty.call(updates, 'quoApiKey') && !inboxes.length) {
    bootFromServer().then(result => {
      if (!result.ok) {
        updateCredentialBanner();
        showCredentialPrompt(result.error);
      }
    }).catch(() => {});
  }
  if (statusEl) {
    statusEl.classList.remove('error-msg');
    statusEl.classList.add('muted');
    statusEl.style.color = 'var(--success)';
    statusEl.textContent = successText;
    setTimeout(() => {
      if (statusEl.textContent === successText) {
        statusEl.style.color = '';
        statusEl.textContent = '';
      }
    }, 2000);
  }
  return true;
}

loadSettings();  // load immediately so PAGE_SIZE is set before contacts render
applyTheme();
systemThemeQuery?.addEventListener?.('change', () => {
  if ((settings.themeMode || 'system') === 'system') applyTheme();
});
initSettings();

/* ── State ──────────────────────────────────────────────────────────── */
let apiKey        = '';
let inboxes       = [];   // [{id, number, name}]
let activeInbox   = null;
let allContacts   = [];   // full dataset fetched from API (all pages)
let contacts      = [];   // filtered/searched view of allContacts
let customFields  = [];   // [{key, name, type}]
let activeTagFilters = new Set();
let activeQualityFilter = 'ready';
let selectedContact  = null;
let searchQuery      = '';
let bulkSelected     = new Set(); // contact ids
let isSyncing        = false;
let bulkTagFilters   = new Set(); // tag filters inside bulk view
let messageNextPageToken = null;
let currentMessages = [];
let messageLoadContext = null;
const BULK_DRAFT_KEY = 'bulk_message_draft_v1';
let bulkDraftTimer = null;
const editorDirections = new Map();

let displayPage  = 0;
// PAGE_SIZE is driven by settings.contactsPerPage; read it via a getter
Object.defineProperty(window, 'PAGE_SIZE', {
  get: () => settings.contactsPerPage,
  configurable: true,
});

/* ── API helper ─────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-quo-api-key': apiKey } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  try { return await res.json(); } catch { return { _status: res.status }; }
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach(x => p.append(k, x));
    else p.set(k, v);
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

/* ── Utilities ──────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function domId(s) {
  return String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
}
function initials(name) {
  return name.split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
}
function fmtTime(iso) {
  const d = new Date(iso), today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fieldValue(obj, ...keys) {
  if (!obj) return '';
  for (const key of keys) {
    const val = obj[key];
    if (val !== undefined && val !== null && String(val).trim()) return String(val).trim();
  }
  return '';
}
function contactName(c) {
  const f = c.defaultFields || {};
  return `${f.firstName || ''} ${f.lastName || ''}`.trim() ||
    (f.company || '').trim() ||
    contactPhone(c) ||
    contactEmail(c) ||
    'Unknown';
}
function contactPhone(c) {
  const phone = (c.defaultFields?.phoneNumbers || [])
    .map(p => fieldValue(p, 'number', 'value', 'phoneNumber', 'phone'))
    .find(Boolean) || '';
  return ['anonymous', 'unknown', 'none', 'null'].includes(phone.toLowerCase()) ? '' : phone;
}
function contactEmail(c) {
  return (c.defaultFields?.emails || [])
    .map(e => fieldValue(e, 'address', 'value', 'email'))
    .find(Boolean) || '';
}
function contactQuality(c) {
  const df = c.defaultFields || {};
  const name = `${df.firstName || ''} ${df.lastName || ''}`.trim();
  const hasName = !!(name || df.company);
  const hasPhone = !!contactPhone(c);
  const hasEmail = !!contactEmail(c);
  if (hasName && hasPhone) return 'ready';
  if (hasEmail && !hasPhone && !hasName) return 'email_only';
  if (hasPhone && !hasName && !hasEmail) return 'phone_only';
  if (!hasName && !hasPhone && !hasEmail) return 'unknown';
  if (!hasPhone) return 'no_phone';
  return 'incomplete';
}
function contactQualityLabel(q) {
  return ({
    ready: 'Ready',
    email_only: 'Email-only',
    phone_only: 'Phone-only',
    no_phone: 'No phone',
    unknown: 'Unknown',
    incomplete: 'Incomplete',
  })[q] || q;
}
function contactTags(c) {
  const tags = [];
  (c.customFields || []).forEach(cf => {
    if (cf.type === 'multi-select' && Array.isArray(cf.value)) tags.push(...cf.value);
    else if (cf.type === 'string' && cf.value) tags.push(cf.value);
  });
  return tags;
}
function allTagsFromList(list) {
  const s = new Set();
  list.forEach(c => contactTags(c).forEach(t => s.add(t)));
  return [...s].sort();
}
// find a contact in the full dataset by id
function findContact(id) { return allContacts.find(c => c.id === id); }

/* ── Startup helpers ────────────────────────────────────────────────── */
async function bootFromServer() {
  let res;
  try {
    res = await api('/phone-numbers');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (res?.data?.length) {
    await boot(res.data);
    return { ok: true };
  }
  return { ok: false, error: res?.error?.message || res?.error || res?.message || 'No saved Quo credentials yet.' };
}

/* ── Boot ───────────────────────────────────────────────────────────── */
async function boot(phones) {
  $('app').classList.remove('hidden');

  inboxes = phones.map(p => ({ id: p.id, number: p.number, name: p.name || p.number }));
  const sel = $('inbox-select');
  sel.innerHTML = inboxes.length
    ? inboxes.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')
    : '<option value="">No inboxes</option>';
  activeInbox = inboxes[0] || null;
  sel.onchange = () => {
    activeInbox = inboxes.find(i => i.id === sel.value) || inboxes[0] || null;
    if (selectedContact) loadMessages(selectedContact);
  };

  // Load custom fields from API (lightweight, needed for modal)
  const cfRes = await api('/contact-custom-fields');
  customFields = cfRes?.data || [];

  // Load contacts from local DB (instant) then check if a sync is needed
  await loadFromDb();
  showView('empty');

  initVersion();
  applySettings();

  // Auto-sync check
  const stats = await fetch('/db/stats').then(r => r.json()).catch(() => null);
  const lastSync = stats?.lastSync?.completed_at;
  const ageMinutes = lastSync ? (Date.now() - new Date(lastSync).getTime()) / 60000 : Infinity;
  const maxAgeMinutes = (settings.autoSyncMaxAgeHours || 1) * 60;
  if (settings.autoSyncOnLogin && (!stats?.contacts || ageMinutes > maxAgeMinutes)) {
    syncAllContacts();
  } else {
    const t = lastSync
      ? new Date(lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'never';
    setSyncStatus('ok', `${stats?.contacts || 0} contacts · last synced ${t}`);
  }
}

/* ── Load contacts from local DB (instant) ──────────────────────────── */
async function loadFromDb() {
  const res = await fetch('/db/contacts').then(r => r.json()).catch(() => ({ data: [] }));
  allContacts = res.data || [];
  applyFilters();
}

/* ── Sync: runs server-side, client polls for progress ──────────────── */
async function syncAllContacts() {
  if (isSyncing) return;
  isSyncing = true;

  const syncBtn = $('btn-sync');
  syncBtn.disabled = true;
  syncBtn.innerHTML = '<span class="sync-icon">↻</span> Syncing…';
  syncBtn.classList.add('syncing');
  setSyncStatus('syncing', 'Starting sync…');

  // Kick off server-side sync (non-blocking)
  const start = await fetch('/db/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  }).then(r => r.json()).catch(e => ({ error: e.message }));

  if (start.error || !start.ok) {
    setSyncStatus('error', start.error || start.msg || 'Failed to start sync');
    syncBtn.disabled = false; syncBtn.innerHTML = '↻ Sync';
    syncBtn.classList.remove('syncing'); isSyncing = false; return;
  }

  // Poll /db/sync-status until done
  while (true) {
    await new Promise(r => setTimeout(r, 800));
    const status = await fetch('/db/sync-status').then(r => r.json()).catch(() => null);
    if (!status) continue;

    setSyncStatus('syncing', status.phase || '…');

    if (!status.running) {
      if (status.error) {
        setSyncStatus('error', `Sync failed: ${status.error}`);
      } else {
        const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        setSyncStatus('ok', `${status.contactsInDb} contacts · synced ${t}`);
        await loadFromDb();   // refresh UI from DB
      }
      break;
    }
  }

  syncBtn.disabled = false; syncBtn.innerHTML = '↻ Sync';
  syncBtn.classList.remove('syncing'); isSyncing = false;
}

function setSyncStatus(state, text) {
  const el = $('sync-status');
  el.className = 'sync-status' + (state === 'syncing' ? ' syncing' : '');
  const dot = state !== 'error' ? '<span class="dot"></span>' : '⚠ ';
  el.innerHTML = `${dot}${esc(text)}`;
}

$('btn-sync').addEventListener('click', syncAllContacts);

/* ── Verify Phones: server-side threaded, browser just polls ─────────── */
$('btn-verify').addEventListener('click', verifyAllPhones);

async function verifyAllPhones() {
  if (!allContacts.length) { alert('Sync contacts first.'); return; }

  const btn = $('btn-verify');
  btn.disabled = true;

  // Create progress toast
  const toast = document.createElement('div');
  toast.className = 'verify-toast';
  toast.innerHTML = `
    <div><strong>Verifying phone numbers…</strong></div>
    <div class="vt-bar"><div class="vt-fill" id="vt-fill" style="width:0%"></div></div>
    <div id="vt-status" style="color:var(--muted);font-size:12px">Starting…</div>`;
  document.body.appendChild(toast);

  // Kick off server-side verify (20 parallel workers, no browser hop per contact)
  const start = await fetch('/db/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  }).then(r => r.json()).catch(e => ({ error: e.message }));

  if (!start.ok) {
    document.getElementById('vt-status').textContent = start.error || start.msg || 'Failed';
    setTimeout(() => toast.remove(), 3000);
    btn.disabled = false; return;
  }

  // Poll until done
  while (true) {
    await new Promise(r => setTimeout(r, 600));
    const s = await fetch('/db/verify-status').then(r => r.json()).catch(() => null);
    if (!s) continue;

    const pct  = s.total ? Math.round(s.done / s.total * 100) : 0;
    const fill = document.getElementById('vt-fill');
    const stat = document.getElementById('vt-status');
    if (fill) fill.style.width = pct + '%';
    if (stat) stat.textContent = s.phase;

    if (!s.running) {
      if (s.error) {
        if (stat) stat.textContent = `Error: ${s.error}`;
      } else {
        if (stat) stat.textContent =
          `Done — ${s.fixed} phone number${s.fixed!==1?'s':''} corrected out of ${s.done} contacts.`;
        await loadFromDb();
        if (selectedContact) {
          const refreshed = findContact(selectedContact.id);
          if (refreshed) openContact(refreshed);
        }
      }
      setTimeout(() => toast.remove(), 4000);
      break;
    }
  }

  btn.disabled = false;
}

/* ── Filter / search (client-side, against full allContacts) ────────── */
function applyFilters() {
  let list = allContacts;

  if (activeQualityFilter !== 'all') {
    if (activeQualityFilter === 'no_phone') {
      list = list.filter(c => !contactPhone(c));
    } else {
      list = list.filter(c => contactQuality(c) === activeQualityFilter);
    }
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(c =>
      contactName(c).toLowerCase().includes(q) ||
      contactPhone(c).toLowerCase().includes(q) ||
      contactEmail(c).toLowerCase().includes(q) ||
      contactTags(c).some(t => t.toLowerCase().includes(q))
    );
  }

  if (activeTagFilters.size) {
    list = list.filter(c => {
      const tags = contactTags(c);
      return [...activeTagFilters].every(t => tags.includes(t));
    });
  }

  contacts = list;
  displayPage = 0;
  renderQualityBar();
  renderTagBar();
  renderContactList($('contact-list'));
  renderPagination();
}

let searchTimer;
$('search').addEventListener('input', e => {
  searchQuery = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilters, 200);
});

/* ── Rendering ──────────────────────────────────────────────────────── */
function qualityCounts() {
  const counts = { all: allContacts.length, ready: 0, email_only: 0, no_phone: 0, phone_only: 0, unknown: 0, incomplete: 0 };
  allContacts.forEach(c => {
    const q = contactQuality(c);
    if (q !== 'no_phone') counts[q] = (counts[q] || 0) + 1;
    if (!contactPhone(c)) counts.no_phone++;
  });
  return counts;
}

function renderQualityBar() {
  const bar = $('quality-bar');
  if (!bar) return;
  const counts = qualityCounts();
  const chips = [
    ['ready', 'Ready'],
    ['all', 'All'],
    ['email_only', 'Email-only'],
    ['no_phone', 'No phone'],
    ['phone_only', 'Phone-only'],
  ];
  bar.innerHTML = chips.map(([key, label]) =>
    `<button class="quality-chip ${activeQualityFilter === key ? 'active' : ''}" data-quality="${key}">
      ${esc(label)} <span class="count">${counts[key] || 0}</span>
    </button>`
  ).join('');
  bar.querySelectorAll('.quality-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeQualityFilter = chip.dataset.quality;
      applyFilters();
    });
  });
}

function renderContactList(container) {
  const start = displayPage * PAGE_SIZE;
  const page  = contacts.slice(start, start + PAGE_SIZE);

  if (!page.length) {
    container.innerHTML = contacts.length
      ? '<div class="contact-item"><div class="muted" style="padding:6px">No contacts on this page</div></div>'
      : allContacts.length
        ? '<div class="contact-item"><div class="muted" style="padding:6px">No contacts match your search</div></div>'
        : '<div class="contact-item"><div class="muted" style="padding:6px">No contacts yet — hit ↻ Sync</div></div>';
    return;
  }

  container.innerHTML = page.map(c => {
    const name  = contactName(c);
    const phone = contactPhone(c);
    const email = contactEmail(c);
    const quality = contactQuality(c);
    const tags  = contactTags(c);
    const phoneHtml = phone
      ? `<div class="ci-phone">${esc(phone)}</div>`
      : email
        ? `<div class="ci-phone missing">${esc(email)}</div>`
        : `<div class="ci-phone missing">⚠ no phone number</div>`;
    return `<div class="contact-item ${selectedContact?.id === c.id ? 'active' : ''}" data-id="${c.id}">
      <div class="avatar">${esc(initials(name))}</div>
      <div class="ci-meta">
        <div class="ci-name">${esc(name)}</div>
        <span class="ci-status ${esc(quality)}">${esc(contactQualityLabel(quality))}</span>
        ${phoneHtml}
        ${tags.length ? `<div class="ci-tags">${tags.map(t=>`<span class="ci-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.contact-item').forEach(el => {
    el.addEventListener('click', () => {
      const c = contacts.find(x => x.id === el.dataset.id);
      if (c) openContact(c);
    });
  });
}

function renderTagBar() {
  const tags = allTagsFromList(allContacts); // tags from full dataset
  const bar  = $('tag-bar');
  if (!tags.length) { bar.innerHTML = ''; return; }

  // Tag chips
  bar.innerHTML = tags.map(t => {
    const count = allContacts.filter(c => contactTags(c).includes(t)).length;
    return `<span class="tag-chip ${activeTagFilters.has(t) ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)} <span style="opacity:.55;font-size:10px">${count}</span></span>`;
  }).join('');

  // Quick bulk-message action when filters are active
  if (activeTagFilters.size) {
    const tagList   = [...activeTagFilters].map(t => `"${t}"`).join(' + ');
    const matchCount = contacts.length;
    const action = document.createElement('button');
    action.className = 'bulk-tag-action';
    action.textContent = `↗ Bulk message ${matchCount} contact${matchCount!==1?'s':''} tagged ${tagList}`;
    action.addEventListener('click', () => {
      // Pre-select all matching contacts, then open bulk view
      contacts.filter(c => contactPhone(c)).forEach(c => bulkSelected.add(c.id));
      // Mirror tag filters into bulk view
      bulkTagFilters = new Set(activeTagFilters);
      openBulkView(true); // pass flag = don't clear selection
    });
    bar.appendChild(action);
  }

  bar.querySelectorAll('.tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const t = chip.dataset.tag;
      if (activeTagFilters.has(t)) activeTagFilters.delete(t); else activeTagFilters.add(t);
      applyFilters();
    });
  });
}

function renderBulkTagBar() {
  const tags = allTagsFromList(allContacts);
  const bar  = $('bulk-tag-bar');
  if (!tags.length) { bar.innerHTML = ''; return; }

  bar.innerHTML = tags.map(t => {
    const count = allContacts.filter(c => contactTags(c).includes(t)).length;
    return `<span class="bulk-tag-chip ${bulkTagFilters.has(t) ? 'active' : ''}" data-tag="${esc(t)}">
      ${esc(t)} <span class="chip-count">${count}</span>
    </span>`;
  }).join('');

  bar.querySelectorAll('.bulk-tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const t = chip.dataset.tag;
      if (bulkTagFilters.has(t)) bulkTagFilters.delete(t); else bulkTagFilters.add(t);
      renderBulkTagBar();
      renderBulkList($('bulk-search').value);
    });
  });
}

function renderPagination() {
  const pg    = $('pagination');
  const total = contacts.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  pg.innerHTML = '';

  if (total > 0) {
    const start = displayPage * PAGE_SIZE + 1;
    const end   = Math.min((displayPage + 1) * PAGE_SIZE, total);
    const info  = document.createElement('span');
    info.className = 'muted'; info.style.fontSize = '11px';
    info.textContent = `${start}–${end} of ${total}`;
    pg.appendChild(info);
  }

  if (displayPage > 0) {
    const btn = document.createElement('button');
    btn.className = 'btn-outline btn-sm'; btn.textContent = '←';
    btn.addEventListener('click', () => { displayPage--; renderContactList($('contact-list')); renderPagination(); });
    pg.appendChild(btn);
  }
  if (displayPage < pages - 1) {
    const btn = document.createElement('button');
    btn.className = 'btn-outline btn-sm'; btn.textContent = '→';
    btn.addEventListener('click', () => { displayPage++; renderContactList($('contact-list')); renderPagination(); });
    pg.appendChild(btn);
  }
}

/* ── Contact detail view ────────────────────────────────────────────── */
function openContact(contact) {
  selectedContact = contact;
  renderContactList($('contact-list'));

  const name    = contactName(contact);
  const phone   = contactPhone(contact);
  const tags    = contactTags(contact);
  const df      = contact.defaultFields || {};
  const email   = contactEmail(contact);
  const company = df.company || '';
  const role    = df.role    || '';

  $('cv-avatar').textContent = initials(name);
  $('cv-name').textContent   = name;

  // Phone — prominent monospace display
  const phoneEl = $('cv-phone');
  const copyBtn = $('btn-copy-phone');
  const telBtn  = $('btn-tel');
  if (phone) {
    phoneEl.textContent = phone;
    phoneEl.className   = 'phone-display';
    phoneEl.title       = 'Click to copy';
    copyBtn.classList.remove('hidden');
    telBtn.classList.remove('hidden');
    telBtn.href = `tel:${phone}`;
  } else {
    phoneEl.textContent = '⚠ No phone number — click Verify';
    phoneEl.className   = 'phone-display no-phone';
    copyBtn.classList.add('hidden');
    telBtn.classList.add('hidden');
  }

  // Secondary info line (email, company, role)
  const extra = [];
  if (company) extra.push(`<span><b>${esc(company)}</b></span>`);
  if (role)    extra.push(`<span>${esc(role)}</span>`);
  if (email)   extra.push(`<span>${esc(email)}</span>`);
  $('cv-extra').innerHTML = extra.join('<span style="opacity:.3">·</span>');

  $('cv-tags').innerHTML = tags.length
    ? tags.map(t => `<span class="tag-badge">${esc(t)}</span>`).join('')
    : '<span class="muted" style="font-size:12px">No tags</span>';

  showView('contact');
  loadMessages(contact);
}

// Copy phone to clipboard
$('cv-phone').addEventListener('click', () => {
  const phone = contactPhone(selectedContact);
  if (!phone) return;
  navigator.clipboard.writeText(phone).then(() => {
    const el = $('cv-phone');
    const orig = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(() => { el.textContent = orig; }, 1200);
  });
});
$('btn-copy-phone').addEventListener('click', () => {
  const phone = contactPhone(selectedContact);
  if (!phone) return;
  navigator.clipboard.writeText(phone).then(() => {
    const btn = $('btn-copy-phone');
    btn.textContent = '✓';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '⎘'; btn.classList.remove('copied'); }, 1500);
  });
});

// Per-contact verify button
$('btn-verify-contact').addEventListener('click', async () => {
  if (!selectedContact) return;
  const btn = $('btn-verify-contact');
  btn.disabled = true; btn.textContent = '…';
  const res = await api(`/contacts/${selectedContact.id}`);
  if (res?.data) {
    await fetch(`/db/contacts/${selectedContact.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(res.data),
    }).catch(() => {});
    await loadFromDb();
    const updated = findContact(selectedContact.id);
    if (updated) openContact(updated);
  }
  btn.disabled = false; btn.textContent = '↻ Verify';
});

async function loadMessages(contact) {
  const phone = contactPhone(contact);
  const msgs  = $('cv-messages');
  messageNextPageToken = null;
  currentMessages = [];
  messageLoadContext = contact?.id || null;
  $('msg-sync-label').textContent = '';
  $('btn-msg-older').disabled = true;
  $('send-mark-done').checked = !!settings.markSentDone;
  if (!phone || !activeInbox) {
    msgs.innerHTML = '<div class="muted" style="padding:16px">No phone number or inbox available.</div>';
    return;
  }
  msgs.innerHTML = '<div class="muted" style="padding:16px">Loading messages…</div>';

  // 1. Try DB cache first (instant)
  let cached = null;
  if (settings.cacheMessages) {
    cached = await fetch(`/db/messages?phoneNumberId=${encodeURIComponent(activeInbox.id)}&contactPhone=${encodeURIComponent(phone)}`)
      .then(r => r.json()).catch(() => null);
    if (cached?.data?.length) {
      currentMessages = cached.data;
      renderMessages(currentMessages);
      $('msg-sync-label').textContent = `Cached ${cached.data.length}`;
    }
  }

  // 2. Always fetch fresh from Quo API and update cache
  await fetchMessagePage({ reset: true });
}

async function fetchMessagePage({ reset = false } = {}) {
  if (!selectedContact || !activeInbox) return;
  const phone = contactPhone(selectedContact);
  if (!phone) return;
  const label = $('msg-sync-label');
  const olderBtn = $('btn-msg-older');
  if (!reset && !messageNextPageToken) return;
  olderBtn.disabled = true;
  label.textContent = reset ? 'Refreshing from Quo…' : 'Loading older messages…';

  const res = await api('/messages' + qs({
    phoneNumberId: activeInbox.id,
    participants: [phone],
    maxResults: settings.messagePageSize || 100,
    pageToken: reset ? '' : messageNextPageToken,
  }));
  const list = res?.data || [];
  messageNextPageToken = res?.nextPageToken || null;

  if (list.length) {
    const byId = new Map((reset ? [] : currentMessages).map(m => [m.id, m]));
    currentMessages.forEach(m => byId.set(m.id, m));
    list.forEach(m => byId.set(m.id, m));
    currentMessages = [...byId.values()];
    if (settings.cacheMessages) {
      fetch('/db/messages/cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumberId: activeInbox.id, contactPhone: phone, messages: list }),
      }).catch(() => {});
    }
    renderMessages(currentMessages);
    label.textContent = `${currentMessages.length} messages · refreshed ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;
  } else if (!currentMessages.length) {
    msgs.innerHTML = '<div class="muted" style="padding:16px;text-align:center">No messages yet. Say hello!</div>';
    label.textContent = 'No messages in Quo';
  } else {
    label.textContent = `${currentMessages.length} messages`;
  }
  olderBtn.disabled = !messageNextPageToken;
}

function renderMessages(list) {
  const msgs = $('cv-messages');
  const sorted = [...list].sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
  msgs.innerHTML = sorted.map(m => {
    const out = m.direction === 'outgoing';
    const status = out && m.status ? ` · ${esc(m.status)}` : '';
    const user = m.userId ? ` · ${esc(m.userId)}` : '';
    return `<div class="msg-group">
      <div class="bubble ${out ? 'out' : 'in'}">${esc(m.text || '(no content)')}</div>
      <div class="msg-meta ${out ? 'out' : ''}">
        ${fmtTime(m.createdAt)}${status}${user}
        <button class="msg-detail-btn" data-id="${esc(m.id)}">details</button>
      </div>
    </div>`;
  }).join('');
  msgs.querySelectorAll('.msg-detail-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleMessageDetail(btn.dataset.id));
  });
  msgs.scrollTop = msgs.scrollHeight;
}

async function toggleMessageDetail(id) {
  const btn = document.querySelector(`.msg-detail-btn[data-id="${CSS.escape(id)}"]`);
  const group = btn?.closest('.msg-group');
  if (!group) return;
  const existing = group.querySelector('.msg-detail');
  if (existing) { existing.remove(); return; }
  let msg = currentMessages.find(m => m.id === id);
  btn.disabled = true;
  const fresh = await api(`/messages/${encodeURIComponent(id)}`).catch(() => null);
  btn.disabled = false;
  if (fresh?.data) {
    msg = fresh.data;
    currentMessages = currentMessages.map(m => m.id === id ? { ...m, ...msg } : m);
    if (settings.cacheMessages && selectedContact && activeInbox) {
      fetch('/db/messages/cache-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumberId: activeInbox.id,
          contactPhone: contactPhone(selectedContact),
          message: msg,
        }),
      }).catch(() => {});
    }
  }
  const detail = document.createElement('div');
  detail.className = 'msg-detail';
  detail.textContent = [
    `ID: ${msg?.id || id}`,
    `From: ${msg?.from || ''}`,
    `To: ${(msg?.to || []).join(', ')}`,
    `Direction: ${msg?.direction || ''}`,
    `Status: ${msg?.status || ''}`,
    `Phone number ID: ${msg?.phoneNumberId || ''}`,
    `User ID: ${msg?.userId || ''}`,
    `Created: ${msg?.createdAt || ''}`,
    `Updated: ${msg?.updatedAt || ''}`,
  ].join('\n');
  group.appendChild(detail);
}

$('btn-send').addEventListener('click', sendMessage);
$('compose-box').addEventListener('keydown', e => { if (e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(); }});
$('btn-msg-refresh').addEventListener('click', () => fetchMessagePage({ reset: true }));
$('btn-msg-older').addEventListener('click', () => fetchMessagePage({ reset: false }));
$('send-mark-done').addEventListener('change', e => {
  settings.markSentDone = e.target.checked;
  saveSettings();
});

async function sendMessage() {
  const text = $('compose-box').value.trim();
  if (!text || !selectedContact || !activeInbox) return;
  const phone = contactPhone(selectedContact);
  if (!phone) return;
  const btn = $('btn-send');
  btn.disabled = true;
  const body = { from: activeInbox.number, to:[phone], content:text };
  if ($('send-mark-done').checked) body.setInboxStatus = 'done';
  const res = await api('/messages', { method:'POST', body });
  if (res?.data && settings.cacheMessages) {
    await fetch('/db/messages/cache-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumberId: activeInbox.id, contactPhone: phone, message: res.data }),
    }).catch(() => {});
  }
  $('compose-box').value = '';
  btn.disabled = false;
  loadMessages(selectedContact);
}

/* ── Bulk messaging ─────────────────────────────────────────────────── */
$('btn-bulk-open').addEventListener('click', openBulkView);
$('btn-bulk-cancel').addEventListener('click', () => {
  saveBulkDraftNow();
  bulkSelected.clear();
  bulkTagFilters.clear();
  showView('empty');
});

function openBulkView(keepSelection = false) {
  if (!keepSelection) { bulkSelected.clear(); bulkTagFilters.clear(); }
  $('bulk-results').innerHTML = '';
  $('bulk-search').value = '';
  aiDrafts.clear();
  aiDraftSelections.clear();
  $('ai-preview-list').innerHTML = '';
  restoreBulkDraft();
  setBulkMode(aiMode ? 'ai' : 'manual');
  showView('bulk');  // renderBulkList called inside showView
  updateBulkChips();
  updateBulkEditorStats();
  updateSendBtn();
}

function renderBulkList(filter = '') {
  renderBulkTagBar(); // keep tag bar in sync

  // Filter by tag chips first, then by text search
  const q = filter.toLowerCase();
  let list = allContacts;

  if (bulkTagFilters.size) {
    list = list.filter(c => {
      const tags = contactTags(c);
      return [...bulkTagFilters].every(t => tags.includes(t));
    });
  }
  if (q) {
    list = list.filter(c =>
      contactName(c).toLowerCase().includes(q) || contactPhone(c).includes(q)
    );
  }
  const container = $('bulk-contact-list');

  if (!list.length) {
    container.innerHTML = '<div class="contact-item"><div class="muted" style="padding:6px">No contacts</div></div>';
    return;
  }
  container.innerHTML = list.map(c => {
    const name    = contactName(c);
    const phone   = contactPhone(c);
    const checked = bulkSelected.has(c.id);
    return `<div class="contact-item ${checked?'active':''}" data-id="${c.id}">
      <input type="checkbox" class="bulk-cb" data-id="${c.id}" ${checked?'checked':''}>
      <div class="avatar">${esc(initials(name))}</div>
      <div class="ci-meta">
        <div class="ci-name">${esc(name)}</div>
        ${phone ? `<div class="ci-phone">${esc(phone)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.bulk-cb').forEach(cb => {
    cb.addEventListener('change', e => {
      const id = e.target.dataset.id;
      e.target.checked ? bulkSelected.add(id) : bulkSelected.delete(id);
      e.target.closest('.contact-item')?.classList.toggle('active', e.target.checked);
      updateBulkChips();
    });
  });
  container.querySelectorAll('.contact-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.type==='checkbox') return;
      const id = el.dataset.id;
      const cb = el.querySelector('.bulk-cb');
      if (bulkSelected.has(id)) { bulkSelected.delete(id); if(cb) cb.checked=false; el.classList.remove('active'); }
      else { bulkSelected.add(id); if(cb) cb.checked=true; el.classList.add('active'); }
      updateBulkChips();
    });
  });
}

$('btn-select-all').addEventListener('click', () => {
  const q = $('bulk-search').value.toLowerCase();
  let list = allContacts;
  // Apply same filters as renderBulkList
  if (bulkTagFilters.size) {
    list = list.filter(c => {
      const tags = contactTags(c);
      return [...bulkTagFilters].every(t => tags.includes(t));
    });
  }
  if (q) list = list.filter(c => contactName(c).toLowerCase().includes(q) || contactPhone(c).includes(q));
  list.filter(c => contactPhone(c)).forEach(c => bulkSelected.add(c.id));
  renderBulkList($('bulk-search').value);
  updateBulkChips();
});
$('btn-clear-all').addEventListener('click', () => {
  bulkSelected.clear();
  renderBulkList($('bulk-search').value);
  updateBulkChips();
});

let bulkSearchTimer;
$('bulk-search').addEventListener('input', e => {
  clearTimeout(bulkSearchTimer);
  bulkSearchTimer = setTimeout(() => renderBulkList(e.target.value), 200);
});

function updateBulkChips() {
  const area  = $('bulk-chip-area');
  const label = $('bulk-count-label');
  label.textContent = `${bulkSelected.size} recipient${bulkSelected.size!==1?'s':''} selected`;

  area.innerHTML = [...bulkSelected].map(id => {
    const c = findContact(id);
    if (!c) return '';
    return `<span class="recipient-chip" data-id="${id}">${esc(contactName(c))}<button data-id="${id}" title="Remove">×</button></span>`;
  }).join('');

  area.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      bulkSelected.delete(btn.dataset.id);
      renderBulkList($('bulk-search').value);
      updateBulkChips();
    });
  });
}

$('btn-bulk-send').addEventListener('click', async () => {
  if (!bulkSelected.size) { $('bulk-results').innerHTML='<div class="r-err">Select at least one contact.</div>'; return; }
  if (!activeInbox)       { $('bulk-results').innerHTML='<div class="r-err">No inbox selected.</div>'; return; }

  // Confirmation guard
  if (settings.confirmBeforeBulkSend) {
    const mode = aiMode ? 'AI-personalized' : 'identical';
    const count = aiMode && aiDrafts.size ? selectedAiMessageCount() : bulkSelected.size;
    const noun = aiMode && aiDrafts.size ? 'message' : 'contact';
    const ok = confirm(
      `Send ${mode} messages to ${count} ${noun}${count!==1?'s':''}?\n\nThis cannot be undone.`
    );
    if (!ok) { updateSendBtn(); return; }
  }

  // In AI mode: generate first if no drafts, then send
  if (aiMode) {
    if (!aiDrafts.size) {
      await generateAiDrafts();
      if (!aiDrafts.size) return; // generation failed
    }
    if (!selectedAiMessageCount()) {
      $('bulk-results').innerHTML = '<div class="r-err">Select at least one drafted message to send.</div>';
      return;
    }
    await sendBulkMessages(id => selectedAiMessages(id));
    aiDrafts.clear();
    aiDraftSelections.clear();
    renderAiPreviews([]);
  } else {
    const text = $('bulk-text').value.trim();
    if (!text) { $('bulk-results').innerHTML='<div class="r-err">Please write a message first.</div>'; return; }
    await sendBulkMessages(() => text);
    $('bulk-text').value = '';
    clearBulkDraft('manual');
  }
  updateSendBtn();
});

async function sendBulkMessages(getText) {
  const btn = $('btn-bulk-send');
  btn.disabled = true; btn.textContent = 'Sending…';
  const resultsEl = $('bulk-results');
  resultsEl.innerHTML = '';

  for (const id of bulkSelected) {
    const contact = findContact(id);
    if (!contact) continue;
    const phone = contactPhone(contact);
    const name  = contactName(contact);
    const draftValue = getText(id);
    const texts = Array.isArray(draftValue) ? draftValue : [draftValue];
    const messages = texts.map(t => String(t || '').trim()).filter(Boolean);

    if (!phone) { resultsEl.innerHTML += `<div class="r-err">✗ ${esc(name)} — no phone number</div>`; continue; }
    if (!messages.length)  { resultsEl.innerHTML += `<div class="r-err">✗ ${esc(name)} — no message</div>`; continue; }

    let okCount = 0;
    let lastErr = '';
    for (const text of messages) {
      const body = { from: activeInbox.number, to:[phone], content:text };
      if (settings.markSentDone) body.setInboxStatus = 'done';
      const res = await api('/messages', { method:'POST', body });
      if (res?.data || res?.id) {
        okCount += 1;
        if (res?.data && settings.cacheMessages) {
          fetch('/db/messages/cache-one', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumberId: activeInbox.id, contactPhone: phone, message: res.data }),
          }).catch(() => {});
        }
      } else {
        lastErr = res?.error?.message || res?.message || JSON.stringify(res);
        break;
      }
    }
    if (okCount === messages.length) {
      resultsEl.innerHTML += `<div class="r-ok">✓ ${esc(name)} (${esc(phone)}) · ${okCount} sent</div>`;
    } else {
      resultsEl.innerHTML += `<div class="r-err">✗ ${esc(name)} — sent ${okCount}/${messages.length}; ${esc(lastErr)}</div>`;
    }
  }

  btn.disabled = false;
  updateSendBtn();
}

function smsSegments(text) {
  const len = String(text || '').length;
  if (!len) return 0;
  return len <= 160 ? 1 : Math.ceil(len / 153);
}

function detectedTextDirection(text) {
  const value = String(text || '');
  const rtl = /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;
  const ltr = /[A-Za-z]/;
  for (const ch of value) {
    if (rtl.test(ch)) return 'rtl';
    if (ltr.test(ch)) return 'ltr';
  }
  return 'ltr';
}

function applyEditorDirection(el, mode = 'auto') {
  if (!el) return;
  const resolved = mode === 'auto' ? detectedTextDirection(el.value) : mode;
  el.setAttribute('dir', resolved);
  el.classList.toggle('text-rtl', resolved === 'rtl');
  el.classList.toggle('text-ltr', resolved !== 'rtl');
}

function setEditorDirection(targetId, mode = 'auto') {
  editorDirections.set(targetId, mode);
  const el = $(targetId);
  applyEditorDirection(el, mode);
  document.querySelectorAll(`.dir-toggle[data-target="${CSS.escape(targetId)}"] .dir-btn`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.dir === mode);
  });
}

function initDirectionControls(root = document) {
  root.querySelectorAll('.dir-toggle').forEach(group => {
    const targetId = group.dataset.target;
    if (!targetId) return;
    group.querySelectorAll('.dir-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        setEditorDirection(targetId, btn.dataset.dir || 'auto');
        scheduleBulkDraftSave();
      });
    });
    setEditorDirection(targetId, editorDirections.get(targetId) || 'auto');
  });
}

function refreshAutoDirection(el) {
  if (!el) return;
  if ((editorDirections.get(el.id) || 'auto') === 'auto') {
    applyEditorDirection(el, 'auto');
  }
}

function updateBulkEditorStats() {
  const manual = $('bulk-text')?.value || '';
  const intent = $('ai-intent')?.value || '';
  refreshAutoDirection($('bulk-text'));
  refreshAutoDirection($('ai-intent'));
  if ($('bulk-text-count')) {
    $('bulk-text-count').textContent = `${manual.length} chars · ${smsSegments(manual)} SMS`;
  }
  if ($('ai-intent-count')) {
    $('ai-intent-count').textContent = `${intent.length} chars`;
  }
}

function bulkDraftPayload() {
  return {
    mode: aiMode ? 'ai' : 'manual',
    manualText: $('bulk-text')?.value || '',
    aiIntent: $('ai-intent')?.value || '',
    savedAt: new Date().toISOString(),
  };
}

function setDraftStatus(text) {
  if ($('bulk-draft-status')) $('bulk-draft-status').textContent = text || '';
  if ($('ai-draft-status')) $('ai-draft-status').textContent = text || '';
}

function saveBulkDraftNow() {
  if (!settings.autosaveBulkDrafts) return;
  const draft = bulkDraftPayload();
  if (!draft.manualText && !draft.aiIntent) {
    localStorage.removeItem(BULK_DRAFT_KEY);
    setDraftStatus('');
    return;
  }
  localStorage.setItem(BULK_DRAFT_KEY, JSON.stringify(draft));
  setDraftStatus(`Saved ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`);
}

function scheduleBulkDraftSave() {
  updateBulkEditorStats();
  if (!settings.autosaveBulkDrafts) {
    setDraftStatus('Autosave off');
    return;
  }
  setDraftStatus('Saving…');
  clearTimeout(bulkDraftTimer);
  bulkDraftTimer = setTimeout(saveBulkDraftNow, 450);
}

function restoreBulkDraft() {
  const raw = localStorage.getItem(BULK_DRAFT_KEY);
  if (!settings.autosaveBulkDrafts || !raw) {
    $('bulk-text').value = '';
    $('ai-intent').value = '';
    aiMode = false;
    setDraftStatus(settings.autosaveBulkDrafts ? '' : 'Autosave off');
    return;
  }
  try {
    const draft = JSON.parse(raw);
    $('bulk-text').value = draft.manualText || '';
    $('ai-intent').value = draft.aiIntent || '';
    aiMode = draft.mode === 'ai';
    const when = draft.savedAt
      ? new Date(draft.savedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
      : '';
    setDraftStatus(when ? `Restored draft from ${when}` : 'Restored draft');
  } catch {
    localStorage.removeItem(BULK_DRAFT_KEY);
    $('bulk-text').value = '';
    $('ai-intent').value = '';
    aiMode = false;
    setDraftStatus('');
  }
}

function clearBulkDraft(kind = 'all') {
  if (kind === 'manual' || kind === 'all') $('bulk-text').value = '';
  if (kind === 'ai' || kind === 'all') $('ai-intent').value = '';
  if (!$('bulk-text').value && !$('ai-intent').value) {
    localStorage.removeItem(BULK_DRAFT_KEY);
    setDraftStatus('Draft cleared');
  } else {
    saveBulkDraftNow();
  }
  updateBulkEditorStats();
}

/* ── Contact create / edit modal ────────────────────────────────────── */
let editingContact = null;

$('btn-new-contact').addEventListener('click',  () => openModal(null));
$('btn-edit-contact').addEventListener('click', () => openModal(selectedContact));
$('btn-modal-cancel').addEventListener('click', closeModal);
$('modal').addEventListener('click', e => { if (e.target===$('modal')) closeModal(); });

function openModal(contact) {
  editingContact = contact;
  $('modal-title').textContent = contact ? 'Edit Contact' : 'New Contact';
  $('m-first').value   = contact?.defaultFields?.firstName || '';
  $('m-last').value    = contact?.defaultFields?.lastName  || '';
  $('m-phone').value   = contactPhone(contact);
  $('m-email').value   = contactEmail(contact || {});
  $('m-company').value = contact?.defaultFields?.company || '';
  $('m-role').value    = contact?.defaultFields?.role    || '';
  $('modal-error').textContent = '';

  $('m-custom-fields').innerHTML = customFields.map(cf => {
    const existing = contact?.customFields?.find(x => x.key===cf.key);
    const val = cf.type==='multi-select' ? (existing?.value||[]).join(', ') : (existing?.value||'');
    const hint = cf.type==='multi-select' ? ' (comma-separated)' : '';
    return `<div class="form-group"><label>${esc(cf.name)}${hint}</label>
      <input type="text" data-key="${esc(cf.key)}" data-type="${esc(cf.type)}" value="${esc(val)}">
    </div>`;
  }).join('');

  $('modal').classList.remove('hidden');
  $('m-first').focus();
}

function closeModal() { $('modal').classList.add('hidden'); }

$('btn-modal-save').addEventListener('click', async () => {
  const firstName = $('m-first').value.trim();
  if (!firstName) { $('modal-error').textContent='First name is required.'; return; }
  const btn = $('btn-modal-save');
  btn.disabled = true;

  const phone = $('m-phone').value.trim();
  const email = $('m-email').value.trim();
  const body = {
    defaultFields: {
      firstName,
      lastName: $('m-last').value.trim()    || undefined,
      company:  $('m-company').value.trim() || undefined,
      role:     $('m-role').value.trim()    || undefined,
      ...(phone ? { phoneNumbers:[{number:phone}] } : {}),
      ...(email ? { emails:[{address:email}] }      : {}),
    },
  };

  const cfInputs = $('m-custom-fields').querySelectorAll('input[data-key]');
  if (cfInputs.length) {
    body.customFields = [...cfInputs].map(inp => {
      const raw = inp.value.trim();
      const val = inp.dataset.type==='multi-select'
        ? raw.split(',').map(s=>s.trim()).filter(Boolean) : raw;
      return { key: inp.dataset.key, value: val };
    }).filter(cf => Array.isArray(cf.value) ? cf.value.length>0 : !!cf.value);
  }

  let res;
  if (editingContact) {
    res = await api(`/contacts/${editingContact.id}`, { method:'PATCH', body });
  } else {
    res = await api('/contacts', { method:'POST', body });
  }

  if (res?.data || res?.id) {
    closeModal();
    const savedId = res?.data?.id || res?.id;

    // Fetch full enriched contact from API, persist to DB, refresh UI
    let fullContact = res?.data || res;
    try {
      const full = await api(`/contacts/${savedId}`);
      if (full?.data) fullContact = full.data;
    } catch {}

    // Write to DB
    await fetch(`/db/contacts/${savedId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullContact),
    }).catch(() => {});

    // Reload from DB so allContacts stays consistent
    await loadFromDb();

    if (editingContact) {
      const updated = findContact(editingContact.id);
      if (updated) openContact(updated);
    }
  } else {
    $('modal-error').textContent = res?.error?.message || res?.message || 'Save failed.';
  }
  btn.disabled = false;
});

/* ── AI Compose ─────────────────────────────────────────────────────── */
let aiMode = false;                    // manual vs AI
let aiDrafts = new Map();              // contactId → message text
let aiDraftSelections = new Map();     // contactId → [true/false per generated message]

function selectedAiMessages(id) {
  const messages = aiDrafts.get(id) || [];
  const selections = aiDraftSelections.get(id) || messages.map(() => true);
  return messages.filter((msg, idx) => selections[idx] !== false && String(msg || '').trim());
}

function selectedAiMessageCount() {
  let total = 0;
  aiDrafts.forEach((_, id) => { total += selectedAiMessages(id).length; });
  return total;
}

function aiPreviewContacts(contactsPayload = null) {
  const source = contactsPayload || [...bulkSelected].map(id => {
    const c = findContact(id);
    if (!c) return null;
    return { id, name: contactName(c), phone: contactPhone(c) };
  }).filter(Boolean);
  return source.filter(c => aiDrafts.has(c.id));
}

function setBulkMode(mode) {
  aiMode = mode === 'ai';
  document.querySelectorAll('.mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  $('compose-manual').classList.toggle('hidden', aiMode);
  $('compose-ai').classList.toggle('hidden', !aiMode);
  updateSendBtn();
}

// Mode toggle
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setBulkMode(btn.dataset.mode);
    scheduleBulkDraftSave();
  });
});

$('bulk-text').addEventListener('input', scheduleBulkDraftSave);
$('ai-intent').addEventListener('input', scheduleBulkDraftSave);
$('btn-clear-bulk-draft').addEventListener('click', () => clearBulkDraft('manual'));
$('btn-clear-ai-draft').addEventListener('click', () => clearBulkDraft('ai'));

$('btn-save-ai-key').addEventListener('click', () => {
  const key = $('ai-anthropic-key').value.trim();
  if (!key) {
    $('ai-key-status').classList.remove('error-msg');
    $('ai-key-status').classList.add('muted');
    $('ai-key-status').textContent = credentialState.anthropicApiKeySaved ? 'Saved on server' : 'Enter a key first.';
    return;
  }
  saveCredentialBundle({ anthropicApiKey: key }, $('ai-key-status'), 'Anthropic key saved on server.');
});

function updateSendBtn() {
  const btn = $('btn-bulk-send');
  if (aiMode && aiDrafts.size > 0) {
    const total = selectedAiMessageCount();
    btn.textContent = `Send ${total} Personalized Message${total !== 1 ? 's' : ''}`;
  } else if (aiMode) {
    btn.textContent = 'Generate & Send';
  } else {
    btn.textContent = 'Send Messages';
  }
}

// Generate button
$('btn-ai-generate').addEventListener('click', generateAiDrafts);

async function generateAiDrafts() {
  const intent      = $('ai-intent').value.trim();
  const anthropicKey = $('ai-anthropic-key').value.trim();

  if (!intent) { alert('Describe what you want to say first.'); return; }
  if (!anthropicKey && !credentialState.anthropicApiKeySaved) { alert('Enter your Anthropic API key in Settings first.'); return; }
  if (!bulkSelected.size) { alert('Select at least one contact.'); return; }

  const btn = $('btn-ai-generate');
  btn.disabled = true;
  $('ai-preview-list').innerHTML = `<div class="ai-generating"><div class="ai-spinner"></div>Writing ${bulkSelected.size} personalized message${bulkSelected.size !== 1 ? 's' : ''}…</div>`;

  // Build contact list for API
  const contactsPayload = [...bulkSelected].map(id => {
    const c = findContact(id);
    if (!c) return null;
    return {
      id,
      name:    contactName(c),
      phone:   contactPhone(c),
      tags:    contactTags(c),
      company: c.defaultFields?.company || '',
      role:    c.defaultFields?.role    || '',
    };
  }).filter(Boolean);

  let result;
  try {
    const res = await fetch('/ai-compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anthropicKey,
        intent,
        contacts: contactsPayload,
        model: settings.anthropicModel,
      }),
    });
    result = await res.json();
  } catch (e) {
    $('ai-preview-list').innerHTML = `<div class="muted" style="padding:12px;color:var(--danger)">Network error: ${esc(e.message)}</div>`;
    btn.disabled = false; return;
  }

  if (result.error) {
    $('ai-preview-list').innerHTML = `<div class="muted" style="padding:12px;color:var(--danger)">Error: ${esc(result.error)}</div>`;
    btn.disabled = false; return;
  }

  // Build a contactId → message map from response
  aiDrafts.clear();
  aiDraftSelections.clear();
  (result.messages || []).forEach(m => {
    const list = Array.isArray(m.messages)
      ? m.messages
      : String(m.message || '').split(/\n{2,}/);
    const clean = list.map(x => String(x || '').trim()).filter(Boolean);
    aiDrafts.set(m.id, clean);
    aiDraftSelections.set(m.id, clean.map(() => true));
  });
  saveBulkDraftNow();

  renderAiPreviews(contactsPayload);
  btn.disabled = false;
  updateSendBtn();
}

function renderAiPreviews(contactsPayload) {
  const list = $('ai-preview-list');
  if (!aiDrafts.size) { list.innerHTML = '<div class="muted" style="padding:12px">No messages generated.</div>'; return; }
  const previewContacts = aiPreviewContacts(contactsPayload);

  list.innerHTML = previewContacts.map(c => {
    const messages = aiDrafts.get(c.id) || [];
    const selections = aiDraftSelections.get(c.id) || messages.map(() => true);
    return `<div class="ai-preview-item" data-id="${esc(c.id)}">
      <div class="ai-preview-head">
        <div class="ai-preview-name">${esc(c.name)} <span class="muted" style="font-weight:400;text-transform:none">${esc(c.phone)}</span></div>
        <button class="btn-outline btn-sm ai-remove-contact" data-id="${esc(c.id)}">Remove</button>
      </div>
      ${messages.map((msg, idx) => {
        const len = msg.length;
        const checked = selections[idx] !== false;
        const editorId = `ai-draft-${domId(c.id)}-${idx}`;
        return `<div class="ai-preview-draft">
          <label class="ai-draft-label">
            <input type="checkbox" class="ai-send-check" data-id="${esc(c.id)}" data-index="${idx}" ${checked ? 'checked' : ''}>
            <span>Send message ${idx + 1}</span>
            <div class="dir-toggle" data-target="${esc(editorId)}" aria-label="Message ${idx + 1} direction">
              <button class="dir-btn active" data-dir="auto">Auto</button>
              <button class="dir-btn" data-dir="ltr">LTR</button>
              <button class="dir-btn" data-dir="rtl">RTL</button>
            </div>
          </label>
          <textarea id="${esc(editorId)}" class="ai-preview-msg" data-id="${esc(c.id)}" data-index="${idx}">${esc(msg)}</textarea>
          <div class="ai-char-count ${len > 160 ? 'over' : ''}" data-id="${esc(c.id)}" data-index="${idx}">${len}/160${len > 160 ? ' ⚠ may split' : ''}</div>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');

  // Live char count + sync edits back to aiDrafts
  initDirectionControls(list);
  list.querySelectorAll('.ai-remove-contact').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      bulkSelected.delete(id);
      aiDrafts.delete(id);
      aiDraftSelections.delete(id);
      renderBulkList($('bulk-search').value);
      updateBulkChips();
      renderAiPreviews();
      updateSendBtn();
    });
  });
  list.querySelectorAll('.ai-send-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.id;
      const idx = Number(cb.dataset.index || 0);
      const messages = aiDrafts.get(id) || [];
      const selections = aiDraftSelections.get(id) || messages.map(() => true);
      selections[idx] = cb.checked;
      aiDraftSelections.set(id, selections);
      updateSendBtn();
    });
  });
  list.querySelectorAll('.ai-preview-msg').forEach(ta => {
    ta.addEventListener('input', () => {
      const id  = ta.dataset.id;
      const idx = Number(ta.dataset.index || 0);
      const len = ta.value.length;
      refreshAutoDirection(ta);
      const messages = aiDrafts.get(id) || [];
      messages[idx] = ta.value;
      aiDrafts.set(id, messages);
      if (!aiDraftSelections.has(id)) aiDraftSelections.set(id, messages.map(() => true));
      const counter = list.querySelector(`.ai-char-count[data-id="${CSS.escape(id)}"][data-index="${idx}"]`);
      if (counter) {
        counter.textContent = `${len}/160${len > 160 ? ' ⚠ may split' : ''}`;
        counter.classList.toggle('over', len > 160);
      }
      updateSendBtn();
    });
    // Auto-grow
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  });
}

/* ── Vagaro Sync panel ──────────────────────────────────────────────── */
$('btn-vagaro-open').addEventListener('click',  () => showView('vagaro'));
$('btn-vagaro-close').addEventListener('click', () => showView('empty'));

// Set webhook URL display once app is open
function setWebhookUrl() {
  const url = `${location.origin}/vagaro-webhook`;
  $('webhook-url-display').value = url;
}

$('btn-copy-webhook').addEventListener('click', () => {
  navigator.clipboard.writeText($('webhook-url-display').value)
    .then(() => { $('btn-copy-webhook').textContent = 'Copied!'; setTimeout(() => $('btn-copy-webhook').textContent = 'Copy', 1500); });
});

$('btn-vagaro-save-creds').addEventListener('click', () => {
  const creds = {
    clientId:     $('vagaro-client-id').value.trim(),
    clientSecret: $('vagaro-client-secret').value.trim(),
    region:       $('vagaro-region').value.trim(),
  };
  if (!creds.clientId || !creds.region || (!creds.clientSecret && !credentialState.vagaroClientSecretSaved)) {
    $('vagaro-creds-status').classList.remove('muted');
    $('vagaro-creds-status').classList.add('error-msg');
    $('vagaro-creds-status').textContent = 'Client ID, region, and a first-time client secret are required.';
    return;
  }
  saveCredentialBundle({
    vagaroClientId: creds.clientId,
    vagaroClientSecret: creds.clientSecret,
    vagaroRegion: creds.region,
  }, $('vagaro-creds-status'), 'Vagaro credentials saved on server.');
});

$('btn-vagaro-test').addEventListener('click', async () => {
  const btn = $('btn-vagaro-test');
  btn.disabled = true; btn.textContent = 'Testing…';
  const creds = {
    clientId:     $('vagaro-client-id').value.trim(),
    clientSecret: $('vagaro-client-secret').value.trim(),
    region:       $('vagaro-region').value.trim(),
  };
  const res = await fetch('/vagaro-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds),
  }).then(r => r.json()).catch(e => ({ ok: false, msg: e.message }));

  $('vagaro-creds-status').style.color = res.ok ? 'var(--success)' : 'var(--danger)';
  $('vagaro-creds-status').textContent = res.msg;
  btn.disabled = false; btn.textContent = 'Test Connection';
});

// Poll webhook log every 5s when panel is open
let webhookLogTimer = null;
async function refreshWebhookLog() {
  const res = await fetch('/vagaro-webhook-log').then(r => r.json()).catch(() => []);
  const el  = $('wl-entries');
  $('wl-count').textContent = res.length ? `(${res.length})` : '';
  if (!res.length) { el.innerHTML = '<div class="wl-entry"><span class="wl-time">—</span><span class="muted">No events yet</span></div>'; return; }
  el.innerHTML = res.map(e => `
    <div class="wl-entry">
      <span class="wl-time">${esc(e.time)}</span>
      <span class="${e.ok ? 'wl-ok' : 'wl-err'}">${esc(e.name || '?')}</span>
      <span class="muted">${esc(e.event)}</span>
      <span>${esc(e.msg)}</span>
    </div>`).join('');
}

/* ── CSV Import ─────────────────────────────────────────────────────── */
let csvRows = [];   // parsed rows ready to import

$('btn-csv-browse').addEventListener('click', () => $('csv-file-input').click());
$('csv-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) handleCsvFile(file);
});

const dropZone = $('csv-drop-zone');
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleCsvFile(file);
});

function handleCsvFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    csvRows = parseCsv(text);
    if (!csvRows.length) { alert('No data rows found in CSV.'); return; }
    renderCsvPreview(csvRows);
    $('csv-import-actions').classList.remove('hidden');
    $('csv-import-progress').innerHTML = '';
  };
  reader.readAsText(file);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => row[h] = (vals[i] || '').trim());
    return row;
  }).filter(r => r['first name'] || r['firstname'] || r['first_name']);
}

function parseCsvLine(line) {
  const result = [], re = /("([^"]|"")*"|[^,]*)(,|$)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    let val = m[1];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1,-1).replace(/""/g,'"');
    result.push(val);
    if (m[3] === '') break;
  }
  return result;
}

// Map Vagaro CSV column names → our fields
function csvRowToContact(row) {
  const get = (...keys) => { for (const k of keys) { if (row[k]) return row[k]; } return ''; };
  return {
    firstName:   get('first name','firstname','first_name'),
    lastName:    get('last name','lastname','last_name'),
    email:       get('email','email address','email_address'),
    phone:       get('cell phone','cellphone','cell_phone','mobile','mobile phone','phone','phone number'),
    company:     get('company','business'),
    tags:        get('tags','general tags','labels'),
  };
}

function renderCsvPreview(rows) {
  const preview = rows.slice(0, 8).map(r => csvRowToContact(r));
  const el = $('csv-preview');
  el.classList.remove('hidden');
  el.innerHTML = `<table>
    <thead><tr><th>First</th><th>Last</th><th>Phone</th><th>Email</th><th>Tags</th></tr></thead>
    <tbody>${preview.map(c => `<tr>
      <td>${esc(c.firstName)}</td><td>${esc(c.lastName)}</td>
      <td>${esc(c.phone)}</td><td>${esc(c.email)}</td><td>${esc(c.tags)}</td>
    </tr>`).join('')}
    ${rows.length > 8 ? `<tr><td colspan="5" class="muted" style="text-align:center">…and ${rows.length - 8} more rows</td></tr>` : ''}
    </tbody></table>`;
}

$('btn-csv-clear').addEventListener('click', () => {
  csvRows = [];
  $('csv-preview').classList.add('hidden');
  $('csv-import-actions').classList.add('hidden');
  $('csv-import-progress').innerHTML = '';
  $('csv-file-input').value = '';
});

$('btn-csv-import').addEventListener('click', async () => {
  if (!csvRows.length) return;
  const btn = $('btn-csv-import');
  btn.disabled = true; btn.textContent = 'Importing…';

  const progress = $('csv-import-progress');
  let done = 0, ok = 0, fail = 0;

  // Progress bar
  progress.innerHTML = `<div class="ip-bar"><div class="ip-fill" id="ip-fill" style="width:0%"></div></div>
    <div id="ip-status"></div><div id="ip-log" style="max-height:120px;overflow-y:auto"></div>`;

  for (const rawRow of csvRows) {
    const c = csvRowToContact(rawRow);
    if (!c.firstName) { done++; continue; }

    const body = {
      defaultFields: {
        firstName: c.firstName,
        lastName:  c.lastName  || undefined,
        company:   c.company   || undefined,
        ...(c.phone ? { phoneNumbers: [{ number: normalizePhone(c.phone) }] } : {}),
        ...(c.email ? { emails:       [{ address: c.email }] }              : {}),
      },
    };
    if (c.tags) {
      body.customFields = [{ key: 'tags', value: c.tags.split(',').map(t => t.trim()).filter(Boolean) }];
    }

    const res = await api('/contacts', { method: 'POST', body });
    const success = !!(res?.data || res?.id);
    if (success) ok++; else fail++;
    done++;

    const pct = Math.round(done / csvRows.length * 100);
    $('ip-fill').style.width = pct + '%';
    $('ip-status').textContent = `${done} / ${csvRows.length}  ·  ✓ ${ok}  ✗ ${fail}`;

    if (!success) {
      $('ip-log').innerHTML += `<div class="ip-err">✗ ${esc(c.firstName)} ${esc(c.lastName)} — ${esc(res?.error?.message || res?.message || JSON.stringify(res))}</div>`;
    }
  }

  btn.disabled = false; btn.textContent = 'Import to Quo';
  $('ip-status').innerHTML = `<strong>Done: ${ok} imported, ${fail} failed.</strong>`;

  // Re-sync contacts list
  if (ok > 0) syncAllContacts();
});

function normalizePhone(raw) {
  // Try to format as E.164 — if already looks right, keep it
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return raw.replace(/[^\d+]/g,'');
  if (digits.length === 10) return '+1' + digits;   // US number
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return raw; // pass through, API will validate
}

/* ── Version & Changelog ────────────────────────────────────────────── */
async function initVersion() {
  const res = await fetch('/version').then(r => r.json()).catch(() => null);
  if (!res) return;

  const current  = res.version;
  const lastSeen = localStorage.getItem('app_version_seen');

  $('version-label').textContent = `v${current}`;

  if (lastSeen !== current) {
    $('version-new-dot').classList.remove('hidden');
  }

  // Build changelog HTML
  const body = $('changelog-body');
  body.innerHTML = res.changelog.map((entry, i) => `
    <div class="cl-entry">
      <div class="cl-version">
        <span class="cl-version-num">v${esc(entry.version)}</span>
        <span class="cl-version-date">${esc(entry.date)}</span>
        ${i === 0 && lastSeen !== current ? '<span class="cl-badge-new">NEW</span>' : ''}
      </div>
      <ul class="cl-features">
        ${entry.features.map(f => `<li>${esc(f)}</li>`).join('')}
      </ul>
    </div>
    ${i < res.changelog.length - 1 ? '<hr class="cl-divider">' : ''}
  `).join('');

  $('btn-changelog').addEventListener('click', () => {
    $('modal-changelog').classList.remove('hidden');
    localStorage.setItem('app_version_seen', current);
    $('version-new-dot').classList.add('hidden');
  });
  $('btn-changelog-close').addEventListener('click', () => {
    $('modal-changelog').classList.add('hidden');
  });
  $('modal-changelog').addEventListener('click', e => {
    if (e.target === $('modal-changelog')) $('modal-changelog').classList.add('hidden');
  });
}

/* ── Duplicate Merge ────────────────────────────────────────────────── */
let dupeGroups = [];
let selectedDupeIdx = null;
let chosenKeepId    = null;   // which contact the user picked to keep

$('btn-dupes-open').addEventListener('click',  () => showView('dupes'));
$('btn-dupes-close').addEventListener('click', () => showView('empty'));

async function loadDuplicates() {
  $('dupes-count').textContent = 'Scanning…';
  $('dupes-list').innerHTML = '<div class="muted" style="padding:12px;font-size:13px">Scanning for duplicates…</div>';

  const res = await fetch('/db/find-duplicates').then(r => r.json()).catch(() => ({ groups: [] }));
  dupeGroups = res.groups || [];

  $('dupes-count').textContent = dupeGroups.length
    ? `${dupeGroups.length} group${dupeGroups.length !== 1 ? 's' : ''}`
    : 'None found';

  if (!dupeGroups.length) {
    $('dupes-list').innerHTML =
      '<div class="muted" style="padding:16px;font-size:13px;text-align:center">🎉 No duplicates found!</div>';
    return;
  }

  $('dupes-list').innerHTML = dupeGroups.map((g, i) => {
    const names = g.contacts.map(c => {
      const df = c.defaultFields || {};
      return `${df.firstName || ''} ${df.lastName || ''}`.trim() || '(unnamed)';
    }).join(' · ');
    return `<div class="dupe-item" data-idx="${i}">
      <div class="dupe-item-reason">${esc(g.reason)}</div>
      <div class="dupe-item-names">${esc(names)}</div>
    </div>`;
  }).join('');

  $('dupes-list').querySelectorAll('.dupe-item').forEach(el => {
    el.addEventListener('click', () => {
      $('dupes-list').querySelectorAll('.dupe-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      selectedDupeIdx = parseInt(el.dataset.idx);
      chosenKeepId    = null;
      renderDupeDetail(dupeGroups[selectedDupeIdx]);
    });
  });
}

function getField(contact, key) {
  const df = contact.defaultFields || {};
  if (key === 'name')    return contactName(contact);
  if (key === 'phone')   return contactPhone(contact);
  if (key === 'email')   return contactEmail(contact);
  if (key === 'company') return df.company || '';
  if (key === 'role')    return df.role    || '';
  if (key === 'tags') {
    const tags = [];
    for (const cf of (contact.customFields || [])) {
      if (Array.isArray(cf.value)) tags.push(...cf.value);
      else if (cf.value) tags.push(cf.value);
    }
    return tags.join(', ');
  }
  return '';
}

function renderDupeDetail(group) {
  const [a, b] = group.contacts;
  const main   = $('dupes-main');
  const fields  = ['name', 'phone', 'email', 'company', 'role', 'tags'];

  function cardHtml(contact, role) {
    const chosen  = chosenKeepId === contact.id;
    const discard = chosenKeepId && chosenKeepId !== contact.id;
    return `<div class="dupe-card ${chosen ? 'chosen' : ''} ${discard ? 'discard' : ''}"
                 data-id="${esc(contact.id)}">
      <div class="dupe-card-label">${role}${chosen ? ' ✓ Keep' : ''}</div>
      ${fields.map(f => {
        const val  = getField(contact, f);
        const diff = val && getField(contact === a ? b : a, f) && val !== getField(contact === a ? b : a, f);
        return `<div class="dupe-field">
          <div class="dupe-field-key">${f.charAt(0).toUpperCase()+f.slice(1)}</div>
          <div class="dupe-field-val ${!val?'missing':''}${diff?' diff':''}">${val || '—'}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function previewHtml() {
    if (!chosenKeepId) return '';
    const keeper  = group.contacts.find(c => c.id === chosenKeepId);
    const discard = group.contacts.find(c => c.id !== chosenKeepId);
    const rows = fields.map(f => {
      const kVal = getField(keeper,  f);
      const dVal = getField(discard, f);
      const final = kVal || dVal;
      const fromB = !kVal && dVal;
      return final ? `<div class="dupe-preview-field">
        <div class="dupe-preview-key">${f}</div>
        <div class="dupe-preview-val ${fromB?'from-b':''}">${esc(final)}${fromB?' <span style="font-size:9px;opacity:.7">(from duplicate)</span>':''}</div>
      </div>` : '';
    }).filter(Boolean).join('');

    return `<div class="dupe-preview">
      <h4>Merged result preview</h4>
      <div class="dupe-preview-fields">${rows}</div>
    </div>`;
  }

  main.innerHTML = `
    <div style="font-size:12px;color:var(--accent);font-weight:600">${esc(group.reason)}</div>
    <p style="font-size:12px;color:var(--muted)">Click a contact below to select which one to keep. The other will be deleted from Quo.</p>
    <div class="dupe-comparison">
      ${cardHtml(a, 'Contact A')}
      <div class="dupe-vs">VS</div>
      ${cardHtml(b, 'Contact B')}
    </div>
    ${previewHtml()}
    <div class="dupe-actions">
      <button class="btn-primary" id="btn-confirm-merge" ${!chosenKeepId?'disabled':''}>
        Merge — Delete Duplicate
      </button>
      <button class="btn-outline" id="btn-skip-dupe">Not a Duplicate → Skip</button>
    </div>
    <div id="dupe-result" class="dupe-result"></div>
  `;

  // Card click → pick keeper
  main.querySelectorAll('.dupe-card').forEach(card => {
    card.addEventListener('click', () => {
      chosenKeepId = card.dataset.id;
      renderDupeDetail(group);
    });
  });

  // Confirm merge
  $('btn-confirm-merge')?.addEventListener('click', async () => {
    if (!chosenKeepId) return;
    const keeper  = group.contacts.find(c => c.id === chosenKeepId);
    const discard = group.contacts.find(c => c.id !== chosenKeepId);
    const btn     = $('btn-confirm-merge');
    btn.disabled  = true; btn.textContent = 'Merging…';

    // Build a patch: fill in any blank fields on keeper from discard
    const df = keeper.defaultFields || {};
    const patch = { defaultFields: {} };
    let hasPatch = false;
    if (!df.phoneNumbers?.length && (discard.defaultFields?.phoneNumbers?.length)) {
      patch.defaultFields.phoneNumbers = discard.defaultFields.phoneNumbers;
      hasPatch = true;
    }
    if (!df.emails?.length && discard.defaultFields?.emails?.length) {
      patch.defaultFields.emails = discard.defaultFields.emails;
      hasPatch = true;
    }
    if (!df.company && discard.defaultFields?.company) {
      patch.defaultFields.company = discard.defaultFields.company;
      hasPatch = true;
    }
    if (!df.role && discard.defaultFields?.role) {
      patch.defaultFields.role = discard.defaultFields.role;
      hasPatch = true;
    }
    // Merge tags
    const keepTags    = (keeper.customFields  || []).flatMap(cf => Array.isArray(cf.value)?cf.value:[cf.value]).filter(Boolean);
    const discardTags = (discard.customFields || []).flatMap(cf => Array.isArray(cf.value)?cf.value:[cf.value]).filter(Boolean);
    const mergedTags  = [...new Set([...keepTags, ...discardTags])];
    if (mergedTags.length > keepTags.length) {
      patch.customFields = [{ key: 'tags', value: mergedTags }];
      hasPatch = true;
    }

    const res = await fetch('/db/merge-contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey:   apiKey,
        keepId:   keeper.id,
        deleteId: discard.id,
        patch:    hasPatch ? patch : null,
      }),
    }).then(r => r.json()).catch(e => ({ error: e.message }));

    const resultEl = $('dupe-result');
    if (res.ok) {
      resultEl.className = 'dupe-result ok';
      resultEl.textContent = `✓ Merged. ${res.deletedFromQuo ? 'Duplicate deleted from Quo.' : 'Removed from local DB (Quo delete may have failed).'}`;
      await loadFromDb();
      // Remove this group and re-render list
      dupeGroups.splice(selectedDupeIdx, 1);
      selectedDupeIdx = null; chosenKeepId = null;
      $('dupes-count').textContent = dupeGroups.length
        ? `${dupeGroups.length} group${dupeGroups.length!==1?'s':''}`
        : 'None found ✓';
      $('dupes-list').querySelectorAll('.dupe-item').forEach(e => e.classList.remove('active'));
      if (!dupeGroups.length) {
        $('dupes-main').innerHTML =
          '<div style="height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--muted)"><div style="font-size:36px">🎉</div><p>All duplicates resolved!</p></div>';
        $('dupes-list').innerHTML =
          '<div class="muted" style="padding:16px;font-size:13px;text-align:center">All clear!</div>';
      } else {
        // Re-render list without removed item
        $('dupes-list').querySelectorAll('.dupe-item').forEach((el, i) => {
          el.dataset.idx = i;
        });
        $('dupes-main').innerHTML =
          '<div style="height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--muted)"><div style="font-size:36px">⇌</div><p>Select next group to review</p></div>';
      }
    } else {
      resultEl.className = 'dupe-result err';
      resultEl.textContent = `✗ Error: ${res.error || JSON.stringify(res)}`;
      btn.disabled = false; btn.textContent = 'Merge — Delete Duplicate';
    }
  });

  // Skip / not a duplicate
  $('btn-skip-dupe')?.addEventListener('click', async () => {
    await fetch('/db/dismiss-duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id1: a.id, id2: b.id }),
    }).catch(() => {});
    dupeGroups.splice(selectedDupeIdx, 1);
    selectedDupeIdx = null; chosenKeepId = null;
    // Remove from DOM
    const items = $('dupes-list').querySelectorAll('.dupe-item');
    items.forEach(el => { if (el.classList.contains('active')) el.remove(); });
    items.forEach((el, i) => { el.dataset.idx = i; });
    $('dupes-count').textContent = dupeGroups.length
      ? `${dupeGroups.length} group${dupeGroups.length!==1?'s':''}`
      : 'None found ✓';
    $('dupes-main').innerHTML =
      '<div style="height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--muted)"><div style="font-size:36px">⇌</div><p>Select next group to review</p></div>';
  });
}

/* ── View switcher ──────────────────────────────────────────────────── */
function showView(name) {
  ['empty','contact','bulk','vagaro','dupes'].forEach(v => $('view-'+v).classList.toggle('hidden', v!==name));
  if (name === 'bulk')   renderBulkList();
  if (name === 'dupes')  loadDuplicates();
  if (name === 'vagaro') {
    setWebhookUrl();
    loadSavedVagaroCreds();
    refreshWebhookLog();
    clearInterval(webhookLogTimer);
    webhookLogTimer = setInterval(refreshWebhookLog, 5000);
  } else {
    clearInterval(webhookLogTimer);
    webhookLogTimer = null;
  }
}

/* ── Startup ────────────────────────────────────────────────────────── */
(async () => {
  await refreshCredentialState().catch(() => {});
  const result = await bootFromServer();
  if (!result.ok) {
    updateCredentialBanner();
    showCredentialPrompt(result.error);
  }
})();
