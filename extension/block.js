'use strict';

const params = new URLSearchParams(location.search);
const REGINA_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Regina',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZoneName: 'shortOffset'
});

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
  return REGINA_TIME_FORMAT.format(date)
    .replace('GMT-06:00', 'GMT-6')
    .replace('GMT-06', 'GMT-6');
}
