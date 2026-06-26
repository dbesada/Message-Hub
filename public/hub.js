const state = {
  connectors: [],
  messages: [],
  connectorKinds: [],
  settings: {},
  selectedId: null,
  editingConnectorId: null,
  autoRefreshHandle: null,
  hasAppliedDefaultSourceFilter: false,
  filters: {
    source: 'all',
    location: 'all',
    status: 'all',
    search: '',
  },
};

const els = {
  connectorList: document.getElementById('connectorList'),
  messageList: document.getElementById('messageList'),
  detailEmpty: document.getElementById('detailEmpty'),
  detailView: document.getElementById('detailView'),
  detailSource: document.getElementById('detailSource'),
  detailSubject: document.getElementById('detailSubject'),
  detailSender: document.getElementById('detailSender'),
  detailStatus: document.getElementById('detailStatus'),
  detailConfidence: document.getElementById('detailConfidence'),
  detailLocationRow: document.getElementById('detailLocationRow'),
  detailBody: document.getElementById('detailBody'),
  detailReceived: document.getElementById('detailReceived'),
  detailThread: document.getElementById('detailThread'),
  detailConnector: document.getElementById('detailConnector'),
  draftBox: document.getElementById('draftBox'),
  resultCount: document.getElementById('resultCount'),
  activeFilterLabel: document.getElementById('activeFilterLabel'),
  searchInput: document.getElementById('searchInput'),
  locationFilter: document.getElementById('locationFilter'),
  statusFilter: document.getElementById('statusFilter'),
  connectorCount: document.getElementById('connectorCount'),
  mississaugaCount: document.getElementById('mississaugaCount'),
  torontoCount: document.getElementById('torontoCount'),
  reviewCount: document.getElementById('reviewCount'),
  openSettingsBtn: document.getElementById('openSettingsBtn'),
  syncBtn: document.getElementById('syncBtn'),
  draftBtn: document.getElementById('draftBtn'),
  classifyBtn: document.getElementById('classifyBtn'),
  reviewBtn: document.getElementById('reviewBtn'),
  doneBtn: document.getElementById('doneBtn'),
  copyDraftBtn: document.getElementById('copyDraftBtn'),
  addConnectorOpen: document.getElementById('addConnectorOpen'),
  connectorModal: document.getElementById('connectorModal'),
  connectorModalTitle: document.getElementById('connectorModalTitle'),
  connectorModalCopy: document.getElementById('connectorModalCopy'),
  closeConnectorModal: document.getElementById('closeConnectorModal'),
  connectorForm: document.getElementById('connectorForm'),
  connectorId: document.getElementById('connectorId'),
  connectorKind: document.getElementById('connectorKind'),
  connectorName: document.getElementById('connectorName'),
  connectorEnabled: document.getElementById('connectorEnabled'),
  connectorFields: document.getElementById('connectorFields'),
  connectorHelp: document.getElementById('connectorHelp'),
  saveConnectorBtn: document.getElementById('saveConnectorBtn'),
  connectorSetupPanel: document.getElementById('connectorSetupPanel'),
  connectorSetupSummary: document.getElementById('connectorSetupSummary'),
  connectorSetupDetails: document.getElementById('connectorSetupDetails'),
  connectGmailBtn: document.getElementById('connectGmailBtn'),
  testConnectorBtn: document.getElementById('testConnectorBtn'),
  deleteConnectorBtn: document.getElementById('deleteConnectorBtn'),
  settingsModal: document.getElementById('settingsModal'),
  closeSettingsModal: document.getElementById('closeSettingsModal'),
  settingsForm: document.getElementById('settingsForm'),
  settingsLayoutMode: document.getElementById('settingsLayoutMode'),
  settingsDefaultSource: document.getElementById('settingsDefaultSource'),
  settingsMessageLimit: document.getElementById('settingsMessageLimit'),
  settingsAutoRefresh: document.getElementById('settingsAutoRefresh'),
  settingsReplySignature: document.getElementById('settingsReplySignature'),
  settingsCompactMode: document.getElementById('settingsCompactMode'),
  settingsShowConnectorDetails: document.getElementById('settingsShowConnectorDetails'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
};

const DEFAULT_SETTINGS = {
  message_limit: 300,
  auto_refresh_seconds: 0,
  compact_mode: false,
  show_connector_details: true,
  default_source_filter: 'all',
  reply_signature: '',
  layout_mode: 'auto',
};

function fmtTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function relativeTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function getSelectedMessage() {
  return state.messages.find((message) => message.id === state.selectedId) || null;
}

function getConnectorName(id) {
  const connector = state.connectors.find((item) => item.id === id);
  return connector ? connector.name : id;
}

function chipClass(tag) {
  const value = (tag || '').toLowerCase();
  if (value === 'mississauga') return 'location-pill mississauga';
  if (value === 'toronto') return 'location-pill toronto';
  return 'location-pill unclear';
}

function getKindMeta(kind) {
  return state.connectorKinds.find((item) => item.kind === kind) || {
    kind,
    label: kind,
    description: 'Generic connector',
    sync_supported: false,
    ingest_supported: false,
    default_config: {},
  };
}

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
}

function effectiveSourceFilter(sourceId) {
  if (sourceId === 'all') return 'all';
  return state.connectors.some((connector) => connector.id === sourceId) ? sourceId : 'all';
}

function applyDefaultSourceFilter(force = false) {
  const settings = getSettings();
  if (!force && state.hasAppliedDefaultSourceFilter) return;
  state.filters.source = effectiveSourceFilter(settings.default_source_filter || 'all');
  state.hasAppliedDefaultSourceFilter = true;
}

function formatJsonValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function getConnectorStatusClass(connector) {
  if (!connector?.enabled) return '';
  if (connector.status === 'connected') return 'on';
  if (connector.status === 'ready') return 'ready';
  return '';
}

function renderSetupPanel(connector = null) {
  if (!connector?.setup) {
    els.connectorSetupPanel.classList.add('hidden');
    els.connectorSetupSummary.textContent = '';
    els.connectorSetupDetails.innerHTML = '';
    return;
  }
  els.connectorSetupPanel.classList.remove('hidden');
  els.connectorSetupSummary.textContent = connector.setup.summary || 'Setup status unavailable';
  const details = connector.setup.details || [];
  els.connectorSetupDetails.innerHTML = details.map((item) => `<div>${escapeHtml(item)}</div>`).join('');
}

function updateConnectorActionButtons(connector = null, kind = els.connectorKind.value || 'gmail') {
  const isGmail = kind === 'gmail';
  els.connectGmailBtn.classList.toggle('hidden', !isGmail);
  if (!isGmail) {
    els.connectGmailBtn.disabled = true;
    return;
  }
  const hasConnector = Boolean(connector?.id);
  els.connectGmailBtn.disabled = !hasConnector;
  els.connectGmailBtn.textContent = connector?.config?.google_email ? 'Reconnect Gmail' : (hasConnector ? 'Connect Gmail' : 'Save first');
}

function updateDeleteConnectorButton(connector = null) {
  const hasConnector = Boolean(connector?.id);
  els.deleteConnectorBtn.classList.toggle('hidden', !hasConnector);
  els.deleteConnectorBtn.disabled = !hasConnector;
}

function populateSettingsSourceOptions() {
  const currentValue = effectiveSourceFilter(els.settingsDefaultSource.value || getSettings().default_source_filter || 'all');
  const options = ['<option value="all">All sources</option>'];
  state.connectors.forEach((connector) => {
    options.push(`<option value="${escapeHtml(connector.id)}">${escapeHtml(connector.name)}</option>`);
  });
  els.settingsDefaultSource.innerHTML = options.join('');
  els.settingsDefaultSource.value = effectiveSourceFilter(currentValue);
}

function fillSettingsForm() {
  const settings = getSettings();
  populateSettingsSourceOptions();
  els.settingsLayoutMode.value = settings.layout_mode || 'auto';
  els.settingsDefaultSource.value = effectiveSourceFilter(settings.default_source_filter || 'all');
  els.settingsMessageLimit.value = String(settings.message_limit ?? DEFAULT_SETTINGS.message_limit);
  els.settingsAutoRefresh.value = String(settings.auto_refresh_seconds ?? DEFAULT_SETTINGS.auto_refresh_seconds);
  els.settingsReplySignature.value = settings.reply_signature || '';
  els.settingsCompactMode.checked = !!settings.compact_mode;
  els.settingsShowConnectorDetails.checked = settings.show_connector_details !== false;
}

function readSettingsForm() {
  return {
    layout_mode: String(els.settingsLayoutMode.value || 'auto').trim(),
    default_source_filter: effectiveSourceFilter(els.settingsDefaultSource.value || 'all'),
    message_limit: Number(els.settingsMessageLimit.value || DEFAULT_SETTINGS.message_limit),
    auto_refresh_seconds: Number(els.settingsAutoRefresh.value || 0),
    reply_signature: String(els.settingsReplySignature.value || '').trim(),
    compact_mode: !!els.settingsCompactMode.checked,
    show_connector_details: !!els.settingsShowConnectorDetails.checked,
  };
}

function scheduleAutoRefresh() {
  if (state.autoRefreshHandle) {
    window.clearInterval(state.autoRefreshHandle);
    state.autoRefreshHandle = null;
  }
  const seconds = Number(getSettings().auto_refresh_seconds || 0);
  if (seconds <= 0) return;
  state.autoRefreshHandle = window.setInterval(() => {
    loadBootstrap({ preserveSelection: true }).catch((error) => {
      console.error('Auto refresh failed', error);
    });
  }, seconds * 1000);
}

function applySettingsToUI() {
  const settings = getSettings();
  document.body.classList.toggle('compact-mode', !!settings.compact_mode);
  document.body.classList.toggle('hide-connector-details', settings.show_connector_details === false);
  document.body.dataset.layoutMode = settings.layout_mode || 'auto';
  populateSettingsSourceOptions();
  scheduleAutoRefresh();
}

function openSettingsModal() {
  fillSettingsForm();
  els.settingsModal.classList.remove('hidden');
  els.settingsModal.setAttribute('aria-hidden', 'false');
}

function closeSettingsModal() {
  els.settingsModal.classList.add('hidden');
  els.settingsModal.setAttribute('aria-hidden', 'true');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderConnectorFields(kind, config = {}) {
  const cfg = { ...getKindMeta(kind).default_config, ...(config || {}) };
  const commonNotes = cfg.notes || '';
  if (kind === 'gmail') {
    const transport = String(cfg.transport || (cfg.username ? 'imap' : 'google_oauth')).trim();
    const connectedEmail = cfg.google_email ? `<div class="connector-note">Connected Google account: ${escapeHtml(formatJsonValue(cfg.google_email))}</div>` : '';
    if (transport === 'google_oauth') {
      return `
        <label>Connection mode
          <select name="transport">
            <option value="google_oauth" selected>Google login (recommended)</option>
            <option value="imap">IMAP app password (legacy)</option>
          </select>
        </label>
        <label>Google client ID<input name="google_client_id" value="${escapeHtml(formatJsonValue(cfg.google_client_id))}" placeholder="Google OAuth web client ID"></label>
        <label>Google client secret<input name="google_client_secret" type="password" value="" placeholder="Paste once; stays saved on the server"></label>
        <div class="field-grid two">
          <label>Mailbox / label<input name="mailbox" value="${escapeHtml(formatJsonValue(cfg.mailbox || 'INBOX'))}" placeholder="INBOX"></label>
          <label>Max messages<input name="max_messages" type="number" min="1" max="500" value="${escapeHtml(formatJsonValue(cfg.max_messages ?? 100))}"></label>
        </div>
        <div class="connector-note">After saving, Message Hub can send you through the Google login flow and keep the refresh token on the server.</div>
        ${connectedEmail}
        <label>Notes<textarea name="notes" rows="3" placeholder="Optional setup notes">${escapeHtml(commonNotes)}</textarea></label>
      `;
    }
    return `
      <label>Connection mode
        <select name="transport">
          <option value="google_oauth">Google login (recommended)</option>
          <option value="imap" selected>IMAP app password (legacy)</option>
        </select>
      </label>
      <label>Host<input name="host" value="${escapeHtml(formatJsonValue(cfg.host || 'imap.gmail.com'))}" placeholder="imap.gmail.com"></label>
      <div class="field-grid two">
        <label>Port<input name="port" type="number" min="1" max="65535" value="${escapeHtml(formatJsonValue(cfg.port ?? 993))}"></label>
        <label>Mailbox<input name="mailbox" value="${escapeHtml(formatJsonValue(cfg.mailbox || 'INBOX'))}" placeholder="INBOX"></label>
      </div>
      <label>Username<input name="username" value="${escapeHtml(formatJsonValue(cfg.username))}" placeholder="you@gmail.com"></label>
      <label>Password<input name="password" type="password" value="${escapeHtml(formatJsonValue(cfg.password))}" placeholder="Gmail app password"></label>
      <div class="field-grid two">
        <label>Max messages<input name="max_messages" type="number" min="1" max="500" value="${escapeHtml(formatJsonValue(cfg.max_messages ?? 100))}"></label>
        <label class="inline-toggle"><input name="ssl" type="checkbox" ${cfg.ssl === false ? '' : 'checked'}><span>Use SSL</span></label>
      </div>
      <label>Notes<textarea name="notes" rows="3" placeholder="Optional setup notes">${escapeHtml(commonNotes)}</textarea></label>
    `;
  }

  if (kind === 'quo') {
    const effectiveLimit = cfg.limit_locked === false && Number(cfg.limit ?? 0) === 250 ? 0 : Number(cfg.limit ?? 0);
    return `
      <label>Source mode
        <select name="mode">
          <option value="local_db" ${cfg.mode === 'local_db' ? 'selected' : ''}>Local Quo database</option>
          <option value="api" ${cfg.mode === 'api' ? 'selected' : ''}>Quo API</option>
        </select>
      </label>
      <label>API key<input name="api_key" value="${escapeHtml(formatJsonValue(cfg.api_key))}" placeholder="Only needed for API mode"></label>
      <div class="field-grid two">
        <label>Limit<input name="limit" type="number" min="0" max="5000" value="${escapeHtml(formatJsonValue(effectiveLimit))}" placeholder="0 = all cached messages"></label>
        <label>Source label<input name="source_label" value="${escapeHtml(formatJsonValue(cfg.source_label || 'Quo'))}" placeholder="Quo"></label>
      </div>
      <div class="connector-note">Set the limit to 0 to pull the full Quo cache instead of only the newest messages.</div>
      <label>Notes<textarea name="notes" rows="3" placeholder="Optional setup notes">${escapeHtml(commonNotes)}</textarea></label>
    `;
  }

  if (kind === 'meta') {
    return `
      <label>Channels
        <input name="channels" value="${escapeHtml(formatJsonValue(cfg.channels || ['facebook', 'instagram']))}" placeholder="facebook, instagram">
      </label>
      <div class="field-grid two">
        <label>Page ID<input name="page_id" value="${escapeHtml(formatJsonValue(cfg.page_id))}" placeholder="Facebook page ID"></label>
        <label>Instagram ID<input name="instagram_id" value="${escapeHtml(formatJsonValue(cfg.instagram_id))}" placeholder="Optional"></label>
      </div>
      <label>Access token<input name="access_token" type="password" value="${escapeHtml(formatJsonValue(cfg.access_token))}" placeholder="Meta access token"></label>
      <label>Webhook verify token<input name="verify_token" value="${escapeHtml(formatJsonValue(cfg.verify_token))}" placeholder="Optional webhook token"></label>
      <div class="connector-note">Save the connector first, then use the callback URL shown in the source list as your Meta webhook URL.</div>
      <label>Notes<textarea name="notes" rows="3" placeholder="Optional setup notes">${escapeHtml(commonNotes)}</textarea></label>
    `;
  }

  if (kind === 'tiktok') {
    return `
      <label>Access token<input name="access_token" type="password" value="${escapeHtml(formatJsonValue(cfg.access_token))}" placeholder="TikTok access token"></label>
      <div class="field-grid two">
        <label>App ID<input name="app_id" value="${escapeHtml(formatJsonValue(cfg.app_id))}" placeholder="Optional"></label>
        <label>Webhook secret<input name="webhook_secret" value="${escapeHtml(formatJsonValue(cfg.webhook_secret))}" placeholder="Optional"></label>
      </div>
      <label>Notes<textarea name="notes" rows="3" placeholder="Optional setup notes">${escapeHtml(commonNotes)}</textarea></label>
    `;
  }

  return `
    <label>Webhook secret<input name="webhook_secret" value="${escapeHtml(formatJsonValue(cfg.webhook_secret))}" placeholder="Optional shared secret"></label>
    <label>Target URL<input name="target_url" value="${escapeHtml(formatJsonValue(cfg.target_url))}" placeholder="Where payloads will come from"></label>
    <label>Notes<textarea name="notes" rows="3" placeholder="Optional setup notes">${escapeHtml(commonNotes)}</textarea></label>
  `;
}

function readConnectorForm() {
  const formData = new FormData(els.connectorForm);
  const kind = String(formData.get('kind') || 'webhook').trim();
  const id = String(formData.get('id') || '').trim();
  const name = String(formData.get('name') || '').trim();
  const enabled = els.connectorEnabled.checked;
  const config = {};
  const entries = Array.from(formData.entries());
  for (const [key, value] of entries) {
    if (['id', 'kind', 'name'].includes(key)) continue;
    if (key === 'notes' && !String(value || '').trim()) continue;
    config[key] = String(value ?? '').trim();
  }
  if (kind === 'gmail') {
    config.transport = String(config.transport || 'google_oauth').trim();
    config.max_messages = Number(config.max_messages || 100);
    if (config.transport === 'imap') {
      config.ssl = !!els.connectorForm.querySelector('input[name="ssl"]')?.checked;
      config.port = Number(config.port || 993);
    } else {
      delete config.host;
      delete config.port;
      delete config.ssl;
      delete config.username;
      delete config.password;
    }
  }
  if (kind === 'quo') {
    config.limit = Number(config.limit || 0);
    config.limit_locked = true;
  }
  if (kind === 'meta' && config.channels) {
    config.channels = config.channels.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return { id, name, kind, enabled, config };
}

function fillConnectorForm(connector = null) {
  const kind = connector?.kind || els.connectorKind.value || 'gmail';
  els.connectorId.value = connector?.id || '';
  els.connectorKind.value = kind;
  els.connectorName.value = connector?.name || getKindMeta(kind).label;
  els.connectorEnabled.checked = connector ? !!connector.enabled : true;
  els.connectorFields.innerHTML = renderConnectorFields(kind, connector?.config || {});
  const meta = getKindMeta(kind);
  els.connectorHelp.textContent = `${meta.description}${meta.ingest_supported ? ' A webhook endpoint is available for pushing messages in.' : ''}`;
  els.connectorModalTitle.textContent = connector ? `Edit ${meta.label}` : `Add ${meta.label}`;
  els.connectorModalCopy.textContent = connector
    ? `Update the ${meta.label} connection, then sync it again to pull fresh messages.`
    : `Add the ${meta.label} connection and sync its messages into the hub.`;
  els.testConnectorBtn.disabled = !connector?.id;
  els.testConnectorBtn.textContent = connector?.id ? 'Test setup' : 'Save first';
  updateConnectorActionButtons(connector, kind);
  updateDeleteConnectorButton(connector);
  renderSetupPanel(connector || {
    setup: {
      summary: 'Save this connector to test it',
      details: ['Connection checks run against the saved connector settings on the server.'],
    },
  });
}

function refreshConnectorModal(kind = els.connectorKind.value || 'gmail') {
  const currentName = els.connectorName.value;
  const currentEnabled = els.connectorEnabled.checked;
  const currentConfig = readConnectorForm().config;
  const meta = getKindMeta(kind);
  els.connectorFields.innerHTML = renderConnectorFields(kind, currentConfig);
  els.connectorName.value = currentName || meta.label;
  els.connectorEnabled.checked = currentEnabled;
  els.connectorHelp.textContent = `${meta.description}${meta.ingest_supported ? ' A webhook endpoint is available for pushing messages in.' : ''}`;
  els.connectorModalTitle.textContent = state.editingConnectorId ? `Edit ${meta.label}` : `Add ${meta.label}`;
  els.connectorModalCopy.textContent = state.editingConnectorId
    ? `Update the ${meta.label} connection, then sync it again to pull fresh messages.`
    : `Add the ${meta.label} connection and sync its messages into the hub.`;
  const existingConnector = state.connectors.find((item) => item.id === state.editingConnectorId);
  updateConnectorActionButtons(existingConnector || { id: state.editingConnectorId, kind }, kind);
  updateDeleteConnectorButton(existingConnector);
  renderSetupPanel(existingConnector && existingConnector.kind === kind ? existingConnector : {
    setup: {
      summary: 'Save this connector to test it',
      details: ['Connection checks run against the saved connector settings on the server.'],
    },
  });
}

function openConnectorEditor(connector = null) {
  state.editingConnectorId = connector?.id || null;
  fillConnectorForm(connector);
  openModal();
  setTimeout(() => {
    els.connectorName.focus();
    els.connectorName.select();
  }, 0);
}

function statusLabel(status) {
  if (!status) return 'Needs review';
  return status.replace(/_/g, ' ');
}

function draftFor(message) {
  const location = message.location_tag || 'your preferred location';
  let draft;
  if (location === 'Mississauga') {
    draft = [
      'Thanks for reaching out.',
      'We can help with your Mississauga booking.',
      'Please send your preferred day and time, and we will confirm the next available slot.',
    ].join(' ');
  } else if (location === 'Toronto') {
    draft = [
      'Thanks for reaching out.',
      'We can help with your Toronto booking.',
      'Please send your preferred day and time, and we will confirm the next available slot.',
    ].join(' ');
  } else {
    draft = [
      'Thanks for reaching out.',
      'Please let us know whether you would like to book in Mississauga or Toronto,',
      'and share your preferred day and time so we can confirm availability.',
    ].join(' ');
  }
  const signature = String(getSettings().reply_signature || '').trim();
  return signature ? `${draft}\n\n${signature}` : draft;
}

function filterMessages() {
  const needle = state.filters.search.trim().toLowerCase();
  return state.messages.filter((message) => {
    const matchesSource = state.filters.source === 'all' || message.connector_id === state.filters.source;
    const matchesLocation =
      state.filters.location === 'all' ||
      (state.filters.location === 'unclear'
        ? !message.location_tag
        : message.location_tag === state.filters.location);
    const matchesStatus = state.filters.status === 'all' || message.status === state.filters.status;
    const haystack = [
      message.source,
      message.sender,
      message.subject,
      message.preview,
      message.body,
      message.location_tag,
      message.status,
    ].join(' ').toLowerCase();
    const matchesSearch = !needle || haystack.includes(needle);
    return matchesSource && matchesLocation && matchesStatus && matchesSearch;
  });
}

function renderFilterChips() {
  const locationOptions = [
    { id: 'all', label: 'All locations' },
    { id: 'mississauga', label: 'Mississauga' },
    { id: 'toronto', label: 'Toronto' },
    { id: 'unclear', label: 'Unclear' },
  ];
  const statusOptions = [
    { id: 'all', label: 'All statuses' },
    { id: 'needs_review', label: 'Needs review' },
    { id: 'drafted', label: 'Drafted' },
    { id: 'done', label: 'Done' },
  ];

  els.locationFilter.innerHTML = locationOptions
    .map((option) => {
      const active = state.filters.location === option.id ? 'active' : '';
      return `<button class="filter-chip ${active}" data-filter-group="location" data-filter-value="${option.id}" type="button">${option.label}</button>`;
    })
    .join('');

  els.statusFilter.innerHTML = statusOptions
    .map((option) => {
      const active = state.filters.status === option.id ? 'active' : '';
      return `<button class="filter-chip ${active}" data-filter-group="status" data-filter-value="${option.id}" type="button">${option.label}</button>`;
    })
    .join('');

  document.querySelectorAll('[data-filter-group]').forEach((button) => {
    button.addEventListener('click', () => {
      const group = button.dataset.filterGroup;
      const value = button.dataset.filterValue;
      state.filters[group] = value;
      renderAll();
    });
  });
}

function renderConnectors() {
  els.connectorCount.textContent = String(state.connectors.length);
  const activeSource = state.filters.source === 'all' ? 'All sources' : getConnectorName(state.filters.source);
  els.activeFilterLabel.textContent = activeSource;
  const settings = getSettings();
  const showDetails = settings.show_connector_details !== false;

  els.connectorList.innerHTML = state.connectors.map((connector) => {
    const statusClass = getConnectorStatusClass(connector);
    const activeClass = state.filters.source === connector.id ? 'active' : '';
    const note = connector.last_error || connector.setup?.summary || connector.config?.notes || connector.description || connector.config?.transport || connector.kind;
    const webhookUrl = connector.ingest_supported ? `${window.location.origin}${connector.webhook_path}` : '';
    const webhookLabel = connector.kind === 'meta' ? 'Meta callback URL' : 'Webhook URL';
    const setupDetails = (connector.setup?.details || []).slice(0, 2);
    return `
      <article class="connector-card ${activeClass}" data-connector-id="${connector.id}">
        <div class="connector-row">
          <div class="connector-name">
            <strong>${connector.name}</strong>
            <span>${connector.label || connector.kind} · ${connector.message_count || 0} messages</span>
          </div>
          <div class="connector-meta">
            <span class="status-dot ${statusClass}"></span>
            <button class="tiny-pill" data-sync-connector="${connector.id}" type="button">${connector.sync_supported ? 'Sync now' : 'Webhook'}</button>
            <button class="tiny-pill" data-test-connector="${connector.id}" type="button">Test setup</button>
            <button class="tiny-pill" data-edit-connector="${connector.id}" type="button">Edit</button>
            <button class="tiny-pill" data-toggle-connector="${connector.id}" type="button">${connector.enabled ? 'Enabled' : 'Paused'}</button>
          </div>
        </div>
        <div class="connector-note">${note || 'Ready for a new adapter'}</div>
        ${showDetails ? setupDetails.map((item) => `<div class="connector-note">${escapeHtml(item)}</div>`).join('') : ''}
        ${showDetails && connector.ingest_supported ? `<div class="connector-note">${webhookLabel}: <code>${webhookUrl}</code></div>` : ''}
        ${showDetails && connector.kind === 'meta' ? `<div class="connector-note">Saved Meta verify tokens stay on the server and are used during the webhook challenge.</div>` : ''}
      </article>
    `;
  }).join('');

  document.querySelectorAll('[data-connector-id]').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-toggle-connector]')) return;
      state.filters.source = card.dataset.connectorId;
      state.hasAppliedDefaultSourceFilter = true;
      renderAll();
    });
  });

  document.querySelectorAll('[data-toggle-connector]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const connectorId = button.dataset.toggleConnector;
      const connector = state.connectors.find((item) => item.id === connectorId);
      if (!connector) return;
      await patchConnector(connectorId, { enabled: !connector.enabled });
      await loadBootstrap({ preserveSelection: true });
    });
  });

  document.querySelectorAll('[data-edit-connector]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const connectorId = button.dataset.editConnector;
      const connector = state.connectors.find((item) => item.id === connectorId);
      if (!connector) return;
      openConnectorEditor(connector);
    });
  });

  document.querySelectorAll('[data-test-connector]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await runConnectorTest(button.dataset.testConnector, button);
    });
  });

  document.querySelectorAll('[data-sync-connector]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const connectorId = button.dataset.syncConnector;
      button.textContent = 'Syncing...';
      try {
        const response = await fetch(`/hub/api/connectors/${encodeURIComponent(connectorId)}/sync`, { method: 'POST' });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `Unable to sync connector (${response.status})`);
        }
        await loadBootstrap({ preserveSelection: true });
      } catch (error) {
        alert(error.message);
      } finally {
        button.textContent = state.connectors.find((item) => item.id === connectorId)?.sync_supported ? 'Sync now' : 'Webhook';
      }
    });
  });
}

function renderMessages() {
  const rows = filterMessages();
  if (rows.length && !rows.some((message) => message.id === state.selectedId)) {
    state.selectedId = rows[0].id;
  } else if (!rows.length) {
    state.selectedId = null;
  }
  els.resultCount.textContent = `${rows.length} message${rows.length === 1 ? '' : 's'}`;

  if (!rows.length) {
    els.messageList.innerHTML = `
      <div class="detail-empty" style="min-height:320px;">
        <div class="detail-hero-mark"></div>
        <h2>No messages match these filters</h2>
        <p>Try switching source, location, or status to pull another thread into view.</p>
      </div>
    `;
    return;
  }

  els.messageList.innerHTML = rows.map((message) => {
    const active = message.id === state.selectedId ? 'active' : '';
    const location = message.location_tag || 'Unclear';
    const status = statusLabel(message.status);
    return `
      <article class="message-card ${active}" data-message-id="${message.id}">
        <div class="message-head">
          <div>
            <strong>${message.sender}</strong>
            <span>${message.subject || 'No subject'}</span>
          </div>
          <span class="tiny-pill">${relativeTime(message.received_at)}</span>
        </div>
        <div class="message-preview">${message.preview || message.body || ''}</div>
        <div class="message-tags">
          <span class="source-pill">${message.source || getConnectorName(message.connector_id)}</span>
          <span class="${chipClass(location)}">${location}</span>
          <span class="status-pill ${message.status || 'needs_review'}">${status}</span>
        </div>
      </article>
    `;
  }).join('');

  document.querySelectorAll('[data-message-id]').forEach((card) => {
    card.addEventListener('click', () => {
      state.selectedId = card.dataset.messageId;
      renderAll();
    });
  });
}

function renderDetail() {
  const message = getSelectedMessage();
  if (!message) {
    els.detailEmpty.classList.remove('hidden');
    els.detailView.classList.add('hidden');
    return;
  }

  els.detailEmpty.classList.add('hidden');
  els.detailView.classList.remove('hidden');

  els.detailSource.textContent = message.source || getConnectorName(message.connector_id);
  els.detailSubject.textContent = message.subject || 'Untitled thread';
  els.detailSender.textContent = `${message.sender} · ${relativeTime(message.received_at)}`;
  els.detailStatus.className = `status-pill ${message.status || 'needs_review'}`;
  els.detailStatus.textContent = statusLabel(message.status);
  els.detailConfidence.className = 'confidence-pill';
  els.detailConfidence.textContent = `${Math.round((message.confidence || 0) * 100)}% confidence`;
  els.detailBody.textContent = message.body || message.preview || 'No body available.';
  els.detailReceived.textContent = fmtTime(message.received_at);
  els.detailThread.textContent = message.thread_id || '—';
  els.detailConnector.textContent = getConnectorName(message.connector_id);

  const location = message.location_tag || '';
  const chips = [
    { value: 'Mississauga', label: 'Mississauga' },
    { value: 'Toronto', label: 'Toronto' },
    { value: '', label: 'Unclear' },
  ];
  els.detailLocationRow.innerHTML = chips.map((chip) => {
    const active = (location || '') === chip.value || (!location && !chip.value) ? 'active' : '';
    const tag = chip.value || 'Unclear';
    return `<button class="${chipClass(tag)} ${active}" data-tag-value="${chip.value}" type="button">${chip.label}</button>`;
  }).join('');

  document.querySelectorAll('[data-tag-value]').forEach((button) => {
    button.addEventListener('click', async () => {
      await patchMessage(message.id, {
        location_tag: button.dataset.tagValue,
        status: message.status || 'needs_review',
      });
      await loadBootstrap({ preserveSelection: true });
    });
  });
}

function renderCounts(summary) {
  els.mississaugaCount.textContent = summary.mississauga ?? 0;
  els.torontoCount.textContent = summary.toronto ?? 0;
  els.reviewCount.textContent = summary.needs_review ?? 0;
}

function renderSelection() {
  document.querySelectorAll('[data-message-id]').forEach((card) => {
    card.classList.toggle('active', card.dataset.messageId === state.selectedId);
  });
}

function renderAll() {
  renderFilterChips();
  renderConnectors();
  renderMessages();
  renderSelection();
  renderDetail();
}

async function loadBootstrap(options = {}) {
  const response = await fetch('/hub/api/bootstrap');
  if (!response.ok) {
    throw new Error(`Bootstrap failed: ${response.status}`);
  }
  const payload = await response.json();
  state.connectors = payload.connectors || [];
  state.messages = payload.messages || [];
  state.connectorKinds = payload.connector_kinds || [];
  state.settings = { ...DEFAULT_SETTINGS, ...(payload.settings || {}) };
  applySettingsToUI();
  if (options.applyDefaultSourceFilter || !state.hasAppliedDefaultSourceFilter) {
    applyDefaultSourceFilter(options.applyDefaultSourceFilter);
  } else if (state.filters.source !== 'all') {
    state.filters.source = effectiveSourceFilter(state.filters.source);
  }
  renderCounts(payload.summary || {});

  const selectedStillVisible = state.messages.some((message) => message.id === state.selectedId);
  if (!options.preserveSelection || !selectedStillVisible) {
    state.selectedId = state.messages[0]?.id || null;
  }

  if (options.reselectLast && options.lastId) {
    state.selectedId = options.lastId;
  }
  renderAll();
}

async function patchMessage(messageId, payload) {
  const response = await fetch(`/hub/api/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Unable to update message (${response.status})`);
  }
  return response.json();
}

async function classifyMessage(messageId) {
  const response = await fetch(`/hub/api/messages/${encodeURIComponent(messageId)}/classify`, {
    method: 'POST',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Unable to classify message (${response.status})`);
  }
  return response.json();
}

async function patchConnector(connectorId, payload) {
  const response = await fetch(`/hub/api/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Unable to update connector (${response.status})`);
  }
  return response.json();
}

function startGmailOAuthPopup(connectorId) {
  const popupUrl = `/hub/api/connectors/${encodeURIComponent(connectorId)}/gmail/oauth/start?return_to=${encodeURIComponent('/hub')}&popup=1`;
  const width = 560;
  const height = 760;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  const popup = window.open(
    popupUrl,
    'message-hub-gmail-oauth',
    `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
  );
  if (!popup) {
    window.location.href = `/hub/api/connectors/${encodeURIComponent(connectorId)}/gmail/oauth/start?return_to=${encodeURIComponent('/hub')}`;
    return null;
  }
  popup.focus();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      window.removeEventListener('message', handleMessage);
      window.clearInterval(closePoll);
    };
    const handleMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      const payload = event.data || {};
      if (payload.type !== 'hub:gmail-oauth' || payload.connectorId !== connectorId) return;
      cleanup();
      resolve(payload);
    };
    const closePoll = window.setInterval(() => {
      if (settled) return;
      if (popup.closed) {
        cleanup();
        reject(new Error('Google login popup was closed before the connection finished.'));
      }
    }, 400);
    window.addEventListener('message', handleMessage);
  });
}

async function deleteConnector(connectorId) {
  const response = await fetch(`/hub/api/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'DELETE',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Unable to delete connector (${response.status})`);
  }
  if (state.filters.source === connectorId) {
    state.filters.source = 'all';
  }
  closeModal();
  await loadBootstrap({ preserveSelection: true });
}

async function saveHubSettings(event) {
  event.preventDefault();
  const payload = readSettingsForm();
  const response = await fetch('/hub/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Unable to save settings (${response.status})`);
  }
  state.settings = { ...DEFAULT_SETTINGS, ...(body.data || {}) };
  state.hasAppliedDefaultSourceFilter = false;
  applySettingsToUI();
  applyDefaultSourceFilter(true);
  closeSettingsModal();
  await loadBootstrap({ preserveSelection: true, applyDefaultSourceFilter: true });
}

async function runConnectorTest(connectorId, button = null) {
  const trigger = button || els.testConnectorBtn;
  const originalText = trigger.textContent;
  trigger.textContent = 'Testing...';
  trigger.disabled = true;
  try {
    const response = await fetch(`/hub/api/connectors/${encodeURIComponent(connectorId)}/test`, {
      method: 'POST',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Unable to test connector (${response.status})`);
    }
    const result = body.result || {};
    const details = result.details || [];
    const lines = [result.summary || 'Connector test completed'];
    details.forEach((item) => lines.push(`- ${item}`));
    alert(lines.join('\n'));
    await loadBootstrap({ preserveSelection: true });
    const refreshed = state.connectors.find((item) => item.id === connectorId);
    if (refreshed && state.editingConnectorId === connectorId) {
      fillConnectorForm(refreshed);
    }
  } catch (error) {
    alert(error.message);
  } finally {
    trigger.textContent = originalText;
    trigger.disabled = false;
  }
}

function openModal() {
  if (!state.editingConnectorId) {
    refreshConnectorModal();
  }
  els.connectorModal.classList.remove('hidden');
  els.connectorModal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  state.editingConnectorId = null;
  els.connectorForm.reset();
  els.connectorId.value = '';
  els.connectorFields.innerHTML = '';
  els.connectorSetupPanel.classList.add('hidden');
  els.connectorSetupSummary.textContent = '';
  els.connectorSetupDetails.innerHTML = '';
  els.connectGmailBtn.classList.add('hidden');
  els.connectGmailBtn.disabled = true;
  els.deleteConnectorBtn.classList.add('hidden');
  els.deleteConnectorBtn.disabled = true;
  els.connectorModal.classList.add('hidden');
  els.connectorModal.setAttribute('aria-hidden', 'true');
}

function templateForSelection() {
  const message = getSelectedMessage();
  if (!message) return;
  els.draftBox.value = draftFor(message);
}

async function submitConnectorForm(event) {
  event.preventDefault();
  const payload = readConnectorForm();
  if (!payload.name || !payload.kind) {
    alert('Please add a connection name and platform.');
    return;
  }
  const editing = Boolean(state.editingConnectorId || payload.id);
  const connectorId = state.editingConnectorId || payload.id;
  const response = await fetch(
    editing ? `/hub/api/connectors/${encodeURIComponent(connectorId)}` : '/hub/api/connectors',
    {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: payload.name,
        kind: payload.kind,
        enabled: payload.enabled,
        config: payload.config,
      }),
    }
  );
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || `Unable to save connector (${response.status})`);
  }

  await loadBootstrap({ preserveSelection: true });
  const savedConnector = body.data || state.connectors.find((item) => item.id === connectorId) || null;
  if (savedConnector?.kind === 'gmail' && payload.config.transport === 'google_oauth' && payload.config.google_client_id && !savedConnector?.config?.google_email) {
    const authResult = await startGmailOAuthPopup(savedConnector.id);
    if (!authResult) return;
    await loadBootstrap({ preserveSelection: true });
    if (!authResult.ok) {
      throw new Error(authResult.message || 'Google login was not completed.');
    }
    closeModal();
    return;
  }
  els.connectorForm.reset();
  closeModal();
}

async function handleDraftClick() {
  templateForSelection();
}

async function handleClassifyClick() {
  const message = getSelectedMessage();
  if (!message) return;
  await classifyMessage(message.id);
  await loadBootstrap({ preserveSelection: true });
}

async function handleReviewClick() {
  const message = getSelectedMessage();
  if (!message) return;
  await patchMessage(message.id, { status: 'needs_review' });
  await loadBootstrap({ preserveSelection: true });
}

async function handleDoneClick() {
  const message = getSelectedMessage();
  if (!message) return;
  await patchMessage(message.id, { status: 'done' });
  await loadBootstrap({ preserveSelection: true });
}

async function handleCopyDraft() {
  if (!els.draftBox.value.trim()) templateForSelection();
  if (!els.draftBox.value.trim()) return;
  await navigator.clipboard.writeText(els.draftBox.value);
  els.copyDraftBtn.textContent = 'Copied';
  setTimeout(() => {
    els.copyDraftBtn.textContent = 'Copy';
  }, 1200);
}

function bindEvents() {
  els.searchInput.addEventListener('input', () => {
    state.filters.search = els.searchInput.value;
    renderAll();
  });

  els.openSettingsBtn.addEventListener('click', openSettingsModal);
  els.syncBtn.addEventListener('click', async () => {
    els.syncBtn.textContent = 'Refreshing...';
    try {
      await loadBootstrap({ preserveSelection: true });
    } finally {
      els.syncBtn.textContent = 'Refresh inbox';
    }
  });

  els.draftBtn.addEventListener('click', handleDraftClick);
  els.classifyBtn.addEventListener('click', handleClassifyClick);
  els.reviewBtn.addEventListener('click', handleReviewClick);
  els.doneBtn.addEventListener('click', handleDoneClick);
  els.copyDraftBtn.addEventListener('click', handleCopyDraft);
  els.addConnectorOpen.addEventListener('click', () => openConnectorEditor());
  els.closeConnectorModal.addEventListener('click', closeModal);
  els.connectorModal.addEventListener('click', (event) => {
    if (event.target === els.connectorModal) closeModal();
  });
  els.closeSettingsModal.addEventListener('click', closeSettingsModal);
  els.settingsModal.addEventListener('click', (event) => {
    if (event.target === els.settingsModal) closeSettingsModal();
  });
  els.connectorKind.addEventListener('change', () => {
    refreshConnectorModal(els.connectorKind.value);
  });
  els.connectGmailBtn.addEventListener('click', async () => {
    if (!state.editingConnectorId) return;
    try {
      const authResult = await startGmailOAuthPopup(state.editingConnectorId);
      if (!authResult) return;
      await loadBootstrap({ preserveSelection: true });
      const refreshed = state.connectors.find((item) => item.id === state.editingConnectorId);
      if (refreshed) fillConnectorForm(refreshed);
      if (!authResult.ok) {
        alert(authResult.message || 'Google login was not completed.');
      }
    } catch (error) {
      alert(error.message);
    }
  });
  els.testConnectorBtn.addEventListener('click', async () => {
    if (!state.editingConnectorId) return;
    await runConnectorTest(state.editingConnectorId);
  });
  els.deleteConnectorBtn.addEventListener('click', async () => {
    if (!state.editingConnectorId) return;
    const connector = state.connectors.find((item) => item.id === state.editingConnectorId);
    const connectorName = connector?.name || state.editingConnectorId;
    const confirmed = window.confirm(`Delete "${connectorName}" and remove its synced messages from Message Hub?`);
    if (!confirmed) return;
    await deleteConnector(state.editingConnectorId);
  });
  els.connectorForm.addEventListener('submit', (event) => {
    submitConnectorForm(event).catch((error) => {
      alert(error.message);
    });
  });
  els.settingsForm.addEventListener('submit', (event) => {
    saveHubSettings(event).catch((error) => {
      alert(error.message);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModal();
      closeSettingsModal();
    }
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        els.searchInput.focus();
      }
    }
  });
}

bindEvents();
loadBootstrap({ applyDefaultSourceFilter: true }).catch((error) => {
  els.messageList.innerHTML = `
    <div class="detail-empty" style="min-height:320px;">
      <div class="detail-hero-mark"></div>
      <h2>Message Hub could not load</h2>
      <p>${error.message}</p>
    </div>
  `;
});
