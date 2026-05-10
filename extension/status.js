'use strict';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:43718';
const REGINA_TIME_ZONE = 'America/Regina';
const REGINA_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: REGINA_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZoneName: 'shortOffset'
});

const refreshButton = document.getElementById('refresh');
const summaryEl = document.getElementById('summary');
const metricsEl = document.getElementById('metrics');
const activityEl = document.getElementById('activity');
const topDomainsEl = document.getElementById('topDomains');
const statusEl = document.getElementById('status');

refreshButton.addEventListener('click', loadStatus);
loadStatus();

async function loadStatus() {
  setStatus('Loading...', '');
  try {
    const settings = await chrome.storage.local.get({
      serverUrl: DEFAULT_SERVER_URL,
      token: ''
    });
    const serverUrl = String(settings.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
    if (!settings.token) throw new Error('Missing token. Add it in extension options.');

    const response = await fetch(`${serverUrl}/status`, {
      headers: {
        authorization: `Bearer ${settings.token}`
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || `Server returned ${response.status}`);

    renderSummary(body);
    renderMetrics(body.reports?.counts || {});
    renderActivity(body.recentActivity || []);
    renderTopDomains(body.reports?.topDomains || []);
    setStatus(`Updated ${formatReginaTime(new Date().toISOString())}.`, '');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function renderSummary(body) {
  summaryEl.replaceChildren(
    summaryRow('Server', `${body.host}:${body.port}`),
    summaryRow('Database', body.databaseFile),
    summaryRow('Profile', (body.profiles || []).map(item => item.name).join(', ')),
    summaryRow('Config', body.configFile)
  );
}

function renderMetrics(counts) {
  metricsEl.replaceChildren(
    metric('Total events', counts.totalEvents || 0),
    metric('Allowed', counts.allowedVisits || 0),
    metric('Blocked', counts.blockedVisits || 0),
    metric('Tamper signals', counts.tamperSignals || 0)
  );
}

function metric(label, value) {
  const card = document.createElement('div');
  card.className = 'metric';
  const strong = document.createElement('strong');
  strong.textContent = String(value);
  const span = document.createElement('span');
  span.textContent = label;
  card.append(strong, span);
  return card;
}

function summaryRow(label, value) {
  const row = document.createElement('div');
  row.className = 'summary-row';
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  const code = document.createElement('code');
  code.textContent = value || '';
  row.append(strong, code);
  return row;
}

function renderActivity(items) {
  activityEl.replaceChildren();
  if (!items.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'No events yet.';
    row.append(cell);
    activityEl.append(row);
    return;
  }

  for (const item of items) {
    const row = document.createElement('tr');
    row.append(
      td(formatReginaTime(item.timestamp)),
      td(item.type),
      td(item.decision),
      td(item.reason),
      td(item.title),
      urlCell(item.url)
    );
    activityEl.append(row);
  }
}

function formatReginaTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return REGINA_TIME_FORMAT.format(date)
    .replace('GMT-06:00', 'GMT-6')
    .replace('GMT-06', 'GMT-6');
}

function td(value) {
  const cell = document.createElement('td');
  cell.textContent = value || '';
  return cell;
}

function urlCell(value) {
  const cell = document.createElement('td');
  if (!value) return cell;
  const link = document.createElement('a');
  link.href = value;
  link.textContent = value;
  link.target = '_blank';
  link.rel = 'noreferrer';
  cell.append(link);
  return cell;
}

function renderTopDomains(items) {
  topDomainsEl.replaceChildren();
  if (!items.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 2;
    cell.textContent = 'No domain activity yet.';
    row.append(cell);
    topDomainsEl.append(row);
    return;
  }

  for (const item of items) {
    const row = document.createElement('tr');
    row.append(td(item.domain), td(item.count));
    topDomainsEl.append(row);
  }
}

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = className;
}
