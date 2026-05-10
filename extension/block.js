'use strict';

const params = new URLSearchParams(location.search);

setText('reason', params.get('reason') || 'Blocked by SafeHarbor');
setText('url', params.get('url') || '');
setText('timestamp', formatTimestamp(params.get('timestamp')));
setText('ruleId', params.get('ruleId') || 'policy');

document.getElementById('back').addEventListener('click', () => {
  history.back();
});

document.getElementById('status').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('status.html') });
});

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function formatTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}
