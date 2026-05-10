'use strict';

const sendButton = document.getElementById('send');
const healthButton = document.getElementById('health');
const statusButton = document.getElementById('statusPage');
const optionsButton = document.getElementById('options');
const readableInput = document.getElementById('readable');
const statusEl = document.getElementById('status');

sendButton.addEventListener('click', async () => {
  await runWithStatus(sendButton, 'Sending...', async () => {
    const result = await chrome.runtime.sendMessage({
      type: 'send-current-page',
      includeReadableText: readableInput.checked
    });
    if (!result || !result.ok) throw new Error(result?.error || 'Capture failed.');
    setStatus(`Saved: ${result.file}`, 'success');
  });
});

healthButton.addEventListener('click', async () => {
  await runWithStatus(healthButton, 'Checking...', async () => {
    const result = await chrome.runtime.sendMessage({ type: 'check-health' });
    if (!result || !result.ok) throw new Error(result?.error || 'Health check failed.');
    setStatus(`SafeHarbor OK on port ${result.body.port}`, 'success');
  });
});

statusButton.addEventListener('click', async () => {
  await runWithStatus(statusButton, 'Opening...', async () => {
    const result = await chrome.runtime.sendMessage({ type: 'open-status-page' });
    if (!result || !result.ok) throw new Error(result?.error || 'Could not open status page.');
    setStatus('Status page opened.', 'success');
  });
});

optionsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function runWithStatus(button, pendingText, task) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  setStatus('', '');
  try {
    await task();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = className;
}
