'use strict';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:43718';

const refreshButton = document.getElementById('refresh');
const summaryEl = document.getElementById('summary');
const activityEl = document.getElementById('activity');
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
    renderActivity(body.recentActivity || []);
    setStatus(`Updated ${new Date().toLocaleTimeString()}.`, '');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function renderSummary(body) {
  summaryEl.replaceChildren(
    summaryRow('Server', `${body.host}:${body.port}`),
    summaryRow('Captures', body.capturesDir),
    summaryRow('Config', body.configFile)
  );
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
    cell.colSpan = 5;
    cell.textContent = 'No captures yet.';
    row.append(cell);
    activityEl.append(row);
    return;
  }

  for (const item of items) {
    const row = document.createElement('tr');
    row.append(
      td(item.timestamp),
      td(item.type),
      td(item.title),
      urlCell(item.url),
      td(item.file)
    );
    activityEl.append(row);
  }
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

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = className;
}
