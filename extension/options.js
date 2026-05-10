'use strict';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:43718';

const serverUrlInput = document.getElementById('serverUrl');
const tokenInput = document.getElementById('token');
const saveButton = document.getElementById('save');
const showTokenButton = document.getElementById('showToken');
const healthButton = document.getElementById('health');
const statusEl = document.getElementById('status');

loadSettings();

saveButton.addEventListener('click', saveSettings);

showTokenButton.addEventListener('click', () => {
  tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
  showTokenButton.textContent = tokenInput.type === 'password' ? 'Show token' : 'Hide token';
});

healthButton.addEventListener('click', async () => {
  setStatus('Checking server...', '');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'check-health' });
    if (!result || !result.ok) throw new Error(result?.error || 'Health check failed.');
    const policy = result.body.policy ? ` Policy: ${result.body.policy.name}.` : '';
    setStatus(`SafeHarbor OK on port ${result.body.port}.${policy}`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

async function loadSettings() {
  const values = await chrome.storage.local.get({
    serverUrl: DEFAULT_SERVER_URL,
    token: ''
  });
  serverUrlInput.value = values.serverUrl || DEFAULT_SERVER_URL;
  tokenInput.value = values.token || '';
}

async function saveSettings() {
  const serverUrl = serverUrlInput.value.trim().replace(/\/+$/, '') || DEFAULT_SERVER_URL;
  const token = tokenInput.value.trim();
  if (!isAllowedServerUrl(serverUrl)) {
    setStatus('Server URL must be localhost or a private home-network address.', 'error');
    return;
  }
  await chrome.storage.local.set({ serverUrl, token });
  setStatus('Options saved.', 'success');
}

function isAllowedServerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  return isPrivateIpv4(host);
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = className;
}
