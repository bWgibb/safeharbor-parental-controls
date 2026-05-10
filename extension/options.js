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
    setStatus(`Server OK on port ${result.body.port}.`, 'success');
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
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(serverUrl)) {
    setStatus('Server URL must be localhost or 127.0.0.1.', 'error');
    return;
  }
  await chrome.storage.local.set({ serverUrl, token });
  setStatus('Options saved.', 'success');
}

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = className;
}
