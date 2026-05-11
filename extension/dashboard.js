'use strict';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:43718';
const REGINA_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Regina',
  month: 'short',
  day: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZoneName: 'shortOffset'
});

let settings = null;
let state = null;
let policy = null;

const $ = id => document.getElementById(id);
const hasChromeApi = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

$('refresh').addEventListener('click', loadDashboard);
$('options').addEventListener('click', openOptions);
$('backupDb').addEventListener('click', backupDatabase);
$('exportPolicy').addEventListener('click', exportPolicy);
$('importPolicy').addEventListener('click', importPolicy);
$('defaultAction').addEventListener('change', () => {
  policy.defaultAction = $('defaultAction').value;
  savePolicy();
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

for (const id of ['alertBlocked', 'alertTamper', 'alertOffline']) {
  $(id).addEventListener('change', saveAlertPrefs);
}

loadDashboard();

async function loadDashboard() {
  setStatus('Loading...', '');
  try {
    settings = await getStoredSettings({
      serverUrl: DEFAULT_SERVER_URL,
      token: '',
      alertBlocked: true,
      alertTamper: true,
      alertOffline: true
    });
    settings.serverUrl = String(settings.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
    if (!settings.token) throw new Error('Missing token. Add it in extension options.');

    state = await fetchJson('/status');
    policy = structuredClone(state.policy);
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
    alertBlocked: localStorage.getItem('safeharborAlertBlocked') !== 'false',
    alertTamper: localStorage.getItem('safeharborAlertTamper') !== 'false',
    alertOffline: localStorage.getItem('safeharborAlertOffline') !== 'false'
  };
}

function saveWebSettings(values) {
  if (values.serverUrl != null) localStorage.setItem('safeharborServerUrl', values.serverUrl);
  if (values.token != null) localStorage.setItem('safeharborToken', values.token);
  if (values.alertBlocked != null) localStorage.setItem('safeharborAlertBlocked', String(Boolean(values.alertBlocked)));
  if (values.alertTamper != null) localStorage.setItem('safeharborAlertTamper', String(Boolean(values.alertTamper)));
  if (values.alertOffline != null) localStorage.setItem('safeharborAlertOffline', String(Boolean(values.alertOffline)));
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
  renderDomainList('allowList', 'allowedDomains');
  renderDomainList('blockList', 'blockedDomains');
  renderCategories();
  renderSchedules();
  renderOverrides();
}

function renderDomainList(targetId, listName) {
  const nodes = policy[listName].map(rule => {
    const row = document.createElement('div');
    row.className = 'tag';
    row.append(el('span', rule.value || rule.domain));
    row.append(removeButton(() => {
      policy[listName] = policy[listName].filter(item => item.id !== rule.id);
      savePolicy();
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
      savePolicy();
    });
    label.append(input, document.createTextNode(category));
    return label;
  }));
}

function renderSchedules() {
  const nodes = policy.schedules.map(rule => {
    const text = `${rule.action} ${rule.start}-${rule.end} ${rule.reason || ''}`;
    return stackItem(text, () => {
      policy.schedules = policy.schedules.filter(item => item.id !== rule.id);
      savePolicy();
    });
  });
  $('scheduleList').replaceChildren(...nodes);
}

function renderOverrides() {
  const nodes = policy.temporaryOverrides.map(rule => {
    const text = `${rule.action} ${rule.value || rule.domain} until ${formatReginaTime(rule.expiresAt)}`;
    return stackItem(text, () => {
      policy.temporaryOverrides = policy.temporaryOverrides.filter(item => item.id !== rule.id);
      savePolicy();
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
  $('alertBlocked').checked = Boolean(settings.alertBlocked);
  $('alertTamper').checked = Boolean(settings.alertTamper);
  $('alertOffline').checked = Boolean(settings.alertOffline);
}

function addDomain(event, listName, inputId, action) {
  event.preventDefault();
  const input = $(inputId);
  const value = normalizeDomain(input.value);
  if (!value) return;
  policy[listName].push({
    id: `${action}-${value}-${Date.now()}`,
    value,
    reason: `Parent ${action} rule`,
    category: 'custom'
  });
  input.value = '';
  savePolicy();
}

function addSchedule(event) {
  event.preventDefault();
  policy.schedules.push({
    id: `schedule-${Date.now()}`,
    action: $('scheduleAction').value,
    start: $('scheduleStart').value,
    end: $('scheduleEnd').value,
    reason: $('scheduleReason').value.trim() || 'Scheduled rule'
  });
  $('scheduleReason').value = '';
  savePolicy();
}

function addOverride(event) {
  event.preventDefault();
  const value = normalizeDomain($('overrideDomain').value);
  const minutes = Math.max(5, Number($('overrideMinutes').value) || 60);
  if (!value) return;
  policy.temporaryOverrides.push({
    id: `override-${Date.now()}`,
    action: $('overrideAction').value,
    value,
    expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
    reason: 'Parent temporary override'
  });
  $('overrideDomain').value = '';
  savePolicy();
}

async function savePolicy() {
  setStatus('Saving policy...', '');
  try {
    const result = await fetchJson('/policy', {
      method: 'POST',
      body: JSON.stringify({ policy })
    });
    policy = structuredClone(result.policy);
    await loadDashboard();
  } catch (error) {
    setStatus(error.message, 'error');
  }
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
  const values = {
    alertBlocked: $('alertBlocked').checked,
    alertTamper: $('alertTamper').checked,
    alertOffline: $('alertOffline').checked
  };
  if (hasChromeApi) await chrome.storage.local.set(values);
  else saveWebSettings(values);
  setStatus('Alert preferences saved.', 'success');
}

function openOptions() {
  if (hasChromeApi && chrome.runtime && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const token = prompt('SafeHarbor parent token', settings?.token || '');
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
      body: JSON.stringify({ profileId: state.profiles[0]?.id })
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

function setStatus(text, className) {
  $('status').textContent = text;
  $('status').className = className;
}
