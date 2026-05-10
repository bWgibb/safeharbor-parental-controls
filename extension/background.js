'use strict';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:43718';

chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  if (!/^https?:\/\//.test(details.url || '')) return;

  evaluateNavigation(details)
    .catch(error => showBadge(details.tabId, 'ERR', '#a22222', error.message));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'send-current-page') {
    sendCurrentPage(Boolean(message.includeReadableText))
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'check-health') {
    checkHealth()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'open-status-page') {
    openStatusPage()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function getSettings() {
  const values = await chrome.storage.local.get({
    serverUrl: DEFAULT_SERVER_URL,
    token: ''
  });
  return {
    serverUrl: trimTrailingSlash(values.serverUrl || DEFAULT_SERVER_URL),
    token: values.token || ''
  };
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab found.');
  if (!/^https?:\/\//.test(tab.url || '')) {
    throw new Error('This page cannot be captured. Open an http or https page first.');
  }
  return tab;
}

async function collectPageContext(tabId, includeReadableText) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageContextCollector,
    args: [includeReadableText]
  });
  return result && result.result ? result.result : {};
}

function pageContextCollector(includeReadableText) {
  const selectedText = String(window.getSelection ? window.getSelection() : '').trim();
  const description = document.querySelector('meta[name="description"]')?.content || '';
  const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
  const headings = Array.from(document.querySelectorAll('h1,h2'))
    .slice(0, 12)
    .map(node => node.textContent.trim())
    .filter(Boolean);

  let readableText = '';
  if (includeReadableText) {
    const source = document.querySelector('main, article') || document.body;
    readableText = source ? source.innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 180000) : '';
  }

  return {
    selectedText,
    readableText,
    metadata: {
      description,
      canonical,
      headings
    }
  };
}

async function sendCurrentPage(includeReadableText) {
  const settings = await getSettings();
  if (!settings.token) throw new Error('Missing token. Add it in extension options.');

  const tab = await getActiveTab();
  const context = await collectPageContext(tab.id, includeReadableText);
  const payload = {
    type: context.selectedText ? 'selection_capture' : 'page_capture',
    timestamp: new Date().toISOString(),
    source: 'chrome-extension',
    tab: {
      url: tab.url || '',
      title: tab.title || '',
      origin: new URL(tab.url).origin
    },
    content: {
      selectedText: context.selectedText || '',
      readableText: context.readableText || '',
      html: null
    },
    intent: 'save',
    metadata: {
      client: null,
      project: null,
      tags: [],
      page: context.metadata || {}
    }
  };

  const endpoint = payload.type === 'selection_capture' ? '/capture/selection' : '/capture/page';
  const response = await fetch(`${settings.serverUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Server returned ${response.status}`);
  }

  await chrome.action.setBadgeText({ text: 'OK', tabId: tab.id });
  await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32', tabId: tab.id });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 2500);
  return { ok: true, file: body.file };
}

async function evaluateNavigation(details) {
  const settings = await getSettings();
  if (!settings.token) {
    await showBadge(details.tabId, 'SET', '#8a6116');
    return;
  }

  const response = await fetch(`${settings.serverUrl}/policy/evaluate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      url: details.url,
      timestamp: new Date().toISOString(),
      source: 'chrome-extension'
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Server returned ${response.status}`);
  }

  if (body.decision && body.decision.action === 'block') {
    const blockUrl = chrome.runtime.getURL(`block.html?${new URLSearchParams({
      url: details.url,
      reason: body.decision.reason || 'Blocked by SafeHarbor',
      ruleId: body.decision.ruleId || '',
      timestamp: body.decision.timestamp || new Date().toISOString()
    })}`);
    await chrome.tabs.update(details.tabId, { url: blockUrl });
    await showBadge(details.tabId, 'NO', '#a22222');
    return;
  }

  await chrome.action.setBadgeText({ text: '', tabId: details.tabId });
}

async function checkHealth() {
  const settings = await getSettings();
  const response = await fetch(`${settings.serverUrl}/health`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `Server returned ${response.status}`);
  if (body.app !== 'SafeHarbor') {
    throw new Error(`Wrong server at ${settings.serverUrl}: ${body.app || 'unknown app'}. Use the SafeHarbor server URL.`);
  }
  if (!body.database) {
    throw new Error(`SafeHarbor server at ${settings.serverUrl} is missing Phase 2 policy storage.`);
  }

  if (settings.token) {
    const policyResponse = await fetch(`${settings.serverUrl}/policy`, {
      headers: {
        authorization: `Bearer ${settings.token}`
      }
    });
    const policyBody = await policyResponse.json().catch(() => ({}));
    if (!policyResponse.ok || !policyBody.ok) {
      throw new Error(policyBody.error || `Policy check returned ${policyResponse.status}`);
    }
    body.policy = policyBody.policy;
  }
  return { ok: true, body };
}

async function openStatusPage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('status.html') });
  return { ok: true };
}

async function showBadge(tabId, text, color) {
  await chrome.action.setBadgeText({ text, tabId });
  await chrome.action.setBadgeBackgroundColor({ color, tabId });
}
