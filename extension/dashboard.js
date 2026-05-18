'use strict';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:43718';
const REGINA_TIME_FORMAT = createReginaTimeFormatter();

let settings = null;
let state = null;
let policy = null;
let originalPolicy = null;
let policyDirty = false;
const POLICY_ACTIONS = new Set(['allow', 'block']);

const $ = id => document.getElementById(id);
const hasChromeApi = typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local;

window.addEventListener('error', event => {
  showFatalDashboardError(event.error ? event.error.message : event.message);
});
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason || {};
  showFatalDashboardError(reason.message || String(reason));
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeDashboard);
} else {
  initializeDashboard();
}

function initializeDashboard() {
  try {
    requireDashboardElements([
      'refresh',
      'options',
      'backupDb',
      'exportPolicy',
      'importPolicy',
      'savePolicy',
      'discardPolicy',
      'defaultAction',
      'allowForm',
      'blockForm',
      'scheduleForm',
      'overrideForm',
      'generateCode',
      'applyFilters',
      'clearFilters',
      'exportCsv',
      'exportJson',
      'alertRepeatedBlock',
      'alertSchedule',
      'alertTamper',
      'alertOffline',
      'alertRevoked',
      'scheduleDays',
      'status'
    ]);

    $('refresh').addEventListener('click', loadDashboard);
    $('options').addEventListener('click', openOptions);
    $('backupDb').addEventListener('click', backupDatabase);
    $('exportPolicy').addEventListener('click', exportPolicy);
    $('importPolicy').addEventListener('click', importPolicy);
    $('savePolicy').addEventListener('click', savePolicy);
    $('discardPolicy').addEventListener('click', discardPolicyDraft);
    $('defaultAction').addEventListener('change', () => {
      policy = normalizeDashboardPolicy(policy);
      policy.defaultAction = $('defaultAction').value;
      markPolicyDirty();
    });
    $('allowForm').addEventListener('submit', event => addDomain(event, 'allowedDomains', 'allowDomain', 'allow'));
    $('blockForm').addEventListener('submit', event => addDomain(event, 'blockedDomains', 'blockDomain', 'block'));
    $('scheduleForm').addEventListener('submit', addSchedule);
    $('overrideForm').addEventListener('submit', addOverride);
    $('generateCode').addEventListener('click', generateEnrollmentCode);
    $('applyFilters').addEventListener('click', loadFilteredReports);
    $('clearFilters').addEventListener('click', clearReportFilters);
    $('exportCsv').addEventListener('click', () => exportReport('csv'));
    $('exportJson').addEventListener('click', () => exportReport('json'));

    for (const id of ['alertRepeatedBlock', 'alertSchedule', 'alertTamper', 'alertOffline', 'alertRevoked']) {
      $(id).addEventListener('change', saveAlertPrefs);
    }

    renderScheduleDayPicker();
    loadDashboard();
  } catch (error) {
    showFatalDashboardError(error.message);
  }
}

function requireDashboardElements(ids) {
  const missing = ids.filter(id => !$(id));
  if (missing.length) throw new Error(`Dashboard is missing required elements: ${missing.join(', ')}`);
}

function showFatalDashboardError(message) {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = `Dashboard error: ${message || 'unknown error'}`;
    status.className = 'error';
  }
}

async function loadDashboard() {
  setStatus('Loading...', '');
  try {
    settings = await getStoredSettings({
      serverUrl: DEFAULT_SERVER_URL,
      token: ''
    });
    settings.serverUrl = String(settings.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
    if (!settings.token) throw new Error('Missing token. Add it in extension options.');

    state = await fetchJson('/status');
    state.policy = normalizeDashboardPolicy(state.policy);
    policy = cloneJson(state.policy);
    originalPolicy = cloneJson(state.policy);
    policyDirty = false;
    renderDashboard();
    setStatus(`Updated ${formatReginaTime(new Date().toISOString())}.`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function getStoredSettings(defaults) {
  if (hasChromeApi) return chrome.storage.local.get(defaults);
  return loadWebSettings(defaults);
}

function loadWebSettings(defaults = {}) {
  const query = new URLSearchParams(window.location.search);
  const queryToken = query.get('token') || '';
  if (queryToken) localStorage.setItem('safeharborToken', queryToken);
  return {
    serverUrl: localStorage.getItem('safeharborServerUrl') || window.location.origin || defaults.serverUrl || DEFAULT_SERVER_URL,
    token: queryToken || localStorage.getItem('safeharborToken') || defaults.token || '',
    alertRepeatedBlock: localStorage.getItem('safeharborAlertRepeatedBlock') !== 'false',
    alertSchedule: localStorage.getItem('safeharborAlertSchedule') !== 'false',
    alertTamper: localStorage.getItem('safeharborAlertTamper') !== 'false',
    alertOffline: localStorage.getItem('safeharborAlertOffline') !== 'false',
    alertRevoked: localStorage.getItem('safeharborAlertRevoked') !== 'false'
  };
}

function saveWebSettings(values) {
  if (values.serverUrl != null) localStorage.setItem('safeharborServerUrl', values.serverUrl);
  if (values.token != null) localStorage.setItem('safeharborToken', values.token);
  if (values.alertRepeatedBlock != null) localStorage.setItem('safeharborAlertRepeatedBlock', String(Boolean(values.alertRepeatedBlock)));
  if (values.alertSchedule != null) localStorage.setItem('safeharborAlertSchedule', String(Boolean(values.alertSchedule)));
  if (values.alertTamper != null) localStorage.setItem('safeharborAlertTamper', String(Boolean(values.alertTamper)));
  if (values.alertOffline != null) localStorage.setItem('safeharborAlertOffline', String(Boolean(values.alertOffline)));
  if (values.alertRevoked != null) localStorage.setItem('safeharborAlertRevoked', String(Boolean(values.alertRevoked)));
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${settings.serverUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${settings.token}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `Server returned ${response.status}`);
  return body;
}

function renderDashboard() {
  $('subtitle').textContent = `${state.app} ${state.version} on ${state.host}:${state.port}`;
  renderMetrics(state.reports.counts);
  renderHubSyncWarning();
  renderFamily();
  renderReportFilters();
  renderPolicy();
  renderReports();
  renderAlerts();
  renderAlertPrefs();
}

function renderMetrics(counts) {
  $('metrics').replaceChildren(
    metric('Total events', counts.totalEvents || 0),
    metric('Allowed', counts.allowedVisits || 0),
    metric('Blocked', counts.blockedVisits || 0),
    metric('Online min 7d', counts.estimatedOnlineMinutes7d || 0),
    metric('Tamper', counts.tamperSignals || 0)
  );
}

function metric(label, value) {
  const node = document.createElement('div');
  node.className = 'metric';
  node.append(el('strong', String(value)), el('span', label));
  return node;
}

function renderHubSyncWarning() {
  const warning = $('hubSyncWarning');
  if (state.hubSyncEnabled && state.hubLastSyncError) {
    warning.hidden = false;
    warning.textContent = `Hub sync error: ${state.hubLastSyncError}`;
    return;
  }
  warning.hidden = true;
  warning.textContent = '';
}

function renderFamily() {
  $('profiles').replaceChildren(
    ...state.profiles.map(profile => summaryRow(profile.name, profile.id))
  );
  $('devices').replaceChildren(
    ...state.devices.map(device => deviceRow(device))
  );
  renderEnrollmentCodes();
}

function deviceRow(device) {
  const row = summaryRow(
    device.name,
    `${device.status} · ${device.platform} · ${formatReginaTime(device.lastSeenAt)}`
  );
  if (device.revokedAt) row.classList.add('revoked');
  else {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Revoke';
    button.addEventListener('click', () => revokeDevice(device));
    row.append(button);
  }
  return row;
}

function renderEnrollmentCodes() {
  const rows = Array.isArray(state.enrollmentCodes) ? state.enrollmentCodes : [];
  $('enrollmentCodes').replaceChildren(...rows.slice(0, 5).map(code => {
    const status = code.usedAt ? `used ${formatReginaTime(code.usedAt)}` : `expires ${formatReginaTime(code.expiresAt)}`;
    return stackItem(`Profile ${code.profileId} · ${status}`, null);
  }));
}

function renderPolicy() {
  $('defaultAction').value = policy.defaultAction;
  renderPolicyDraftControls();
  renderDomainList('allowList', 'allowedDomains');
  renderDomainList('blockList', 'blockedDomains');
  renderCategories();
  renderSchedules();
  renderOverrides();
}

function renderPolicyDraftControls() {
  $('savePolicy').disabled = !policyDirty;
  $('discardPolicy').disabled = !policyDirty;
  $('policyDraftStatus').textContent = policyDirty ? 'Unsaved policy changes' : '';
}

function renderDomainList(targetId, listName) {
  const nodes = asArray(policy[listName]).map(rule => {
    const row = document.createElement('div');
    row.className = 'tag';
    row.append(el('span', rule.value || rule.domain));
    row.append(removeButton(() => {
      policy[listName] = policy[listName].filter(item => item.id !== rule.id);
      markPolicyDirty();
      renderPolicy();
    }));
    return row;
  });
  $(targetId).replaceChildren(...nodes);
}

function renderCategories() {
  const categories = Object.keys(policy.categories || {});
  const blocked = new Set(policy.blockedCategories || []);
  $('categoryList').replaceChildren(...categories.map(category => {
    const label = document.createElement('label');
    label.className = 'check-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = blocked.has(category);
    input.addEventListener('change', () => {
      const next = new Set(policy.blockedCategories || []);
      if (input.checked) next.add(category);
      else next.delete(category);
      policy.blockedCategories = Array.from(next);
      markPolicyDirty();
      renderPolicy();
    });
    label.append(input, document.createTextNode(category));
    return label;
  }));
}

function renderSchedules() {
  const nodes = asArray(policy.schedules).map(rule => {
    const days = Array.isArray(rule.days) && rule.days.length ? ` ${rule.days.join(',')}` : '';
    const text = `${rule.action} ${rule.start}-${rule.end}${days} ${rule.reason || ''}`;
    return stackItem(text, () => {
      policy.schedules = policy.schedules.filter(item => item.id !== rule.id);
      markPolicyDirty();
      renderPolicy();
    });
  });
  $('scheduleList').replaceChildren(...nodes);
}

function renderOverrides() {
  const nodes = asArray(policy.temporaryOverrides).map(rule => {
    const text = `${rule.action} ${rule.value || rule.domain} until ${formatReginaTime(rule.expiresAt)}`;
    return stackItem(text, () => {
      policy.temporaryOverrides = policy.temporaryOverrides.filter(item => item.id !== rule.id);
      markPolicyDirty();
      renderPolicy();
    });
  });
  $('overrideList').replaceChildren(...nodes);
}

function renderReports() {
  renderTable('blockedAttempts', state.reports.blockedAttempts, item => [
    formatReginaTime(item.timestamp),
    item.reason,
    item.url
  ]);
  renderTable('topDomains', state.reports.topDomains, item => [item.domain, item.count]);
  renderTable('dailySummary', state.reports.dailySummary, item => [item.day, item.total, item.blocked]);
  renderTable('deviceSummary', state.reports.deviceSummary, item => [
    item.name || item.deviceId,
    item.total,
    item.blocked
  ]);
  renderTable('recentActivity', state.recentActivity, item => [
    formatReginaTime(item.timestamp),
    item.decision || item.type,
    item.domain || ''
  ]);
}

function renderReportFilters() {
  const currentProfile = $('reportProfile').value;
  const currentDevice = $('reportDevice').value;
  $('reportProfile').replaceChildren(
    option('', 'All profiles'),
    ...state.profiles.map(profile => option(profile.id, profile.name))
  );
  $('reportDevice').replaceChildren(
    option('', 'All devices'),
    ...state.devices.map(device => option(device.id, device.name))
  );
  $('reportProfile').value = currentProfile;
  $('reportDevice').value = currentDevice;
}

function renderAlerts() {
  const alerts = state.alerts && Array.isArray(state.alerts.rows) ? state.alerts.rows : [];
  if (!alerts.length) {
    $('alerts').replaceChildren(stackItem('No open alerts', null));
    return;
  }
  $('alerts').replaceChildren(...alerts.slice(0, 8).map(alert => {
    const row = stackItem(`${alert.severity} · ${alert.title} · ${alert.message}`, () => resolveAlert(alert.id));
    row.classList.add(`alert-${alert.severity}`);
    return row;
  }));
}

function renderTable(targetId, items, mapper) {
  const body = $(targetId);
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.textContent = 'None';
    row.append(cell);
    body.replaceChildren(row);
    return;
  }
  body.replaceChildren(...rows.slice(0, 12).map(item => {
    const row = document.createElement('tr');
    row.append(...mapper(item).map(value => el('td', value)));
    return row;
  }));
}

function renderAlertPrefs() {
  const preferences = state.alertPreferences || {};
  $('alertRepeatedBlock').checked = preferences.repeatedBlock !== false;
  $('alertSchedule').checked = preferences.scheduleViolation !== false;
  $('alertTamper').checked = preferences.tamperSignal !== false;
  $('alertOffline').checked = preferences.deviceOffline !== false;
  $('alertRevoked').checked = preferences.deviceRevoked !== false;
}

function addDomain(event, listName, inputId, action) {
  event.preventDefault();
  const input = $(inputId);
  const value = normalizeDomain(input.value);
  if (!value) return;
  policy[listName] = asArray(policy[listName]);
  policy[listName].push({
    id: `${action}-${value}-${Date.now()}`,
    value,
    reason: `Parent ${action} rule`,
    category: 'custom'
  });
  input.value = '';
  markPolicyDirty();
  renderPolicy();
}

function addSchedule(event) {
  event.preventDefault();
  const days = selectedScheduleDays();
  policy.schedules = asArray(policy.schedules);
  policy.schedules.push({
    id: `schedule-${Date.now()}`,
    action: $('scheduleAction').value,
    start: $('scheduleStart').value,
    end: $('scheduleEnd').value,
    reason: $('scheduleReason').value.trim() || 'Scheduled rule',
    days
  });
  $('scheduleReason').value = '';
  markPolicyDirty();
  renderPolicy();
}

function renderScheduleDayPicker() {
  const days = [
    ['sun', 'Sun'],
    ['mon', 'Mon'],
    ['tue', 'Tue'],
    ['wed', 'Wed'],
    ['thu', 'Thu'],
    ['fri', 'Fri'],
    ['sat', 'Sat']
  ];
  $('scheduleDays').replaceChildren(...days.map(([value, labelText]) => {
    const label = document.createElement('label');
    label.className = 'check-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = value;
    label.append(input, document.createTextNode(labelText));
    return label;
  }));
}

function selectedScheduleDays() {
  return Array.from($('scheduleDays').querySelectorAll('input:checked'))
    .map(input => input.value);
}

function markPolicyDirty() {
  policyDirty = JSON.stringify(policy) !== JSON.stringify(originalPolicy);
  renderPolicyDraftControls();
  setStatus(policyDirty ? 'Policy changes are not saved yet.' : '', '');
}

function addOverride(event) {
  event.preventDefault();
  const value = normalizeDomain($('overrideDomain').value);
  const minutes = Math.max(5, Number($('overrideMinutes').value) || 60);
  if (!value) return;
  policy.temporaryOverrides = asArray(policy.temporaryOverrides);
  policy.temporaryOverrides.push({
    id: `override-${Date.now()}`,
    action: $('overrideAction').value,
    value,
    expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
    reason: 'Parent temporary override'
  });
  $('overrideDomain').value = '';
  markPolicyDirty();
  renderPolicy();
}

async function savePolicy() {
  if (!policyDirty) return;
  setStatus('Saving policy...', '');
  try {
    const result = await fetchJson('/policy', {
      method: 'POST',
      body: JSON.stringify({ policy })
    });
    policy = cloneJson(result.policy);
    originalPolicy = cloneJson(result.policy);
    policyDirty = false;
    await loadDashboard();
  } catch (error) {
    setStatus(error.message, 'error');
    renderPolicyDraftControls();
  }
}

function discardPolicyDraft() {
  policy = cloneJson(originalPolicy || state.policy);
  policyDirty = false;
  renderPolicy();
  setStatus('Policy changes discarded.', '');
}

async function revokeDevice(device) {
  if (!confirm(`Revoke ${device.name}? It will stop syncing until re-enrolled.`)) return;
  setStatus('Revoking device...', '');
  try {
    await fetchJson('/devices/revoke', {
      method: 'POST',
      body: JSON.stringify({ deviceId: device.id, reason: 'Revoked from dashboard' })
    });
    await loadDashboard();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function resolveAlert(alertId) {
  setStatus('Resolving alert...', '');
  try {
    await fetchJson('/alerts/resolve', {
      method: 'POST',
      body: JSON.stringify({ alertId })
    });
    await loadDashboard();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function loadFilteredReports() {
  setStatus('Loading reports...', '');
  try {
    const result = await fetchJson(`/reports/local?${reportQuery()}`);
    state.reports = result.reports;
    state.recentActivity = result.recentActivity;
    state.alerts = result.alerts || state.alerts;
    renderMetrics(state.reports.counts);
    renderReports();
    renderAlerts();
    setStatus('Reports updated.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function clearReportFilters() {
  $('reportProfile').value = '';
  $('reportDevice').value = '';
  $('reportFrom').value = '';
  $('reportTo').value = '';
  loadFilteredReports();
}

function reportQuery() {
  const params = new URLSearchParams();
  if ($('reportProfile').value) params.set('profileId', $('reportProfile').value);
  if ($('reportDevice').value) params.set('deviceId', $('reportDevice').value);
  if ($('reportFrom').value) params.set('dateFrom', $('reportFrom').value);
  if ($('reportTo').value) params.set('dateTo', $('reportTo').value);
  return params.toString();
}

async function exportReport(format) {
  setStatus(`Preparing ${format.toUpperCase()}...`, '');
  try {
    const response = await fetch(`${settings.serverUrl}/reports/export.${format}?${reportQuery()}`, {
      headers: { authorization: `Bearer ${settings.token}` }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Server returned ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `safeharbor-report.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`${format.toUpperCase()} ready.`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function backupDatabase() {
  setStatus('Preparing database backup...', '');
  try {
    await downloadAuthenticated('/backup/safeharbor.sqlite', 'safeharbor-backup.sqlite');
    setStatus('Database backup ready.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function exportPolicy() {
  setStatus('Exporting policy...', '');
  try {
    await downloadAuthenticated('/policy/export.json', 'safeharbor-policy.json');
    setStatus('Policy export ready.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function importPolicy() {
  const raw = prompt('Paste SafeHarbor policy JSON');
  if (!raw) return;
  setStatus('Importing policy...', '');
  try {
    const parsed = JSON.parse(raw);
    await fetchJson('/policy/import', {
      method: 'POST',
      body: JSON.stringify(parsed.policy || parsed)
    });
    await loadDashboard();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function downloadAuthenticated(path, fileName) {
  const response = await fetch(`${settings.serverUrl}${path}`, {
    headers: { authorization: `Bearer ${settings.token}` }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Server returned ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function saveAlertPrefs() {
  const preferences = {
    repeatedBlock: $('alertRepeatedBlock').checked,
    scheduleViolation: $('alertSchedule').checked,
    tamperSignal: $('alertTamper').checked,
    deviceOffline: $('alertOffline').checked,
    deviceRevoked: $('alertRevoked').checked
  };
  const values = {
    alertRepeatedBlock: $('alertRepeatedBlock').checked,
    alertSchedule: $('alertSchedule').checked,
    alertTamper: $('alertTamper').checked,
    alertOffline: $('alertOffline').checked,
    alertRevoked: $('alertRevoked').checked
  };
  try {
    const result = await fetchJson('/alerts/preferences', {
      method: 'POST',
      body: JSON.stringify({ alertPreferences: preferences })
    });
    state.alertPreferences = result.alertPreferences;
    if (hasChromeApi) await chrome.storage.local.set(values);
    else saveWebSettings(values);
    setStatus('Alert preferences saved.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function openOptions() {
  if (hasChromeApi && chrome.runtime && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const token = prompt('SafeHarbor parent token', settings && settings.token ? settings.token : '');
  if (token != null) {
    saveWebSettings({ token, serverUrl: window.location.origin });
    loadDashboard();
  }
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\.+|\.+$/g, '');
}

function normalizeDashboardPolicy(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    id: stringOr(source.id, 'local-policy'),
    name: stringOr(source.name, 'Local Policy'),
    profileId: stringOr(source.profileId, 'default-child'),
    defaultAction: POLICY_ACTIONS.has(source.defaultAction) ? source.defaultAction : 'allow',
    blockedDomains: arrayOfObjects(source.blockedDomains),
    allowedDomains: arrayOfObjects(source.allowedDomains),
    categories: normalizeCategories(source.categories),
    blockedCategories: Array.isArray(source.blockedCategories)
      ? source.blockedCategories.filter(item => typeof item === 'string')
      : [],
    schedules: arrayOfObjects(source.schedules),
    temporaryOverrides: arrayOfObjects(source.temporaryOverrides)
  };
}

function arrayOfObjects(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeCategories(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const categories = {};
  for (const [name, domains] of Object.entries(value)) {
    if (Array.isArray(domains)) categories[name] = domains.filter(item => typeof item === 'string');
  }
  return categories;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function summaryRow(label, value) {
  const row = document.createElement('div');
  row.className = 'summary-row';
  row.append(el('strong', label), el('span', value || ''));
  return row;
}

function stackItem(text, onRemove) {
  const row = document.createElement('div');
  row.className = 'stack-item';
  row.append(el('span', text));
  if (onRemove) row.append(removeButton(onRemove));
  return row;
}

async function generateEnrollmentCode() {
  setStatus('Generating pairing code...', '');
  try {
    const result = await fetchJson('/enrollment/code', {
      method: 'POST',
      body: JSON.stringify({ profileId: state.profiles[0] ? state.profiles[0].id : '' })
    });
    $('pairingCode').textContent = `${result.code} · expires ${formatReginaTime(result.expiresAt)}`;
    await loadDashboard();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function removeButton(onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Remove';
  button.addEventListener('click', onClick);
  return button;
}

function option(value, text) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = text;
  return node;
}

function el(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text == null ? '' : String(text);
  return node;
}

function formatReginaTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return REGINA_TIME_FORMAT.format(date)
    .replace('GMT-06:00', 'GMT-6')
    .replace('GMT-06', 'GMT-6');
}

function createReginaTimeFormatter() {
  const baseOptions = {
    timeZone: 'America/Regina',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  };
  try {
    return new Intl.DateTimeFormat('en-US', Object.assign({}, baseOptions, {
      timeZoneName: 'shortOffset'
    }));
  } catch (error) {
    return new Intl.DateTimeFormat('en-US', Object.assign({}, baseOptions, {
      timeZoneName: 'short'
    }));
  }
}

function cloneJson(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function setStatus(text, className) {
  $('status').textContent = text;
  $('status').className = className;
}
