'use strict';

importScripts('policy-cache.js');

const DEFAULT_SERVER_URL = 'http://127.0.0.1:43718';
const POLICY_CACHE_KEY = 'safeharborPolicyCache';
const POLICY_REFRESH_MS = 5 * 60 * 1000;
const {
  DYNAMIC_RULE_ID_END,
  DYNAMIC_RULE_ID_START,
  compileDynamicRules,
  evaluateCachedPolicy
} = SafeHarborPolicyCache;

refreshPolicyCache()
  .catch(() => {});

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

  if (message.type === 'open-dashboard-page') {
    openDashboardPage()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function getSettings() {
  const values = await chrome.storage.local.get({
    serverUrl: DEFAULT_SERVER_URL,
    token: '',
    [POLICY_CACHE_KEY]: null
  });
  return {
    serverUrl: trimTrailingSlash(values.serverUrl || DEFAULT_SERVER_URL),
    token: values.token || '',
    policyCache: values[POLICY_CACHE_KEY] || null
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
  const cachedDecision = settings.policyCache
    ? evaluateCachedPolicy({
      url: details.url,
      timestamp: new Date().toISOString(),
      policy: settings.policyCache.policy
    })
    : null;
  if (cachedDecision && cachedDecision.action === 'block') {
    await showBlockPage(details.tabId, details.url, cachedDecision, 'NO');
    if (settings.token) {
      sendPolicyEvaluation(settings, details)
        .then(body => updatePolicyFromEvaluation(settings, body))
        .catch(error => reportAgentUnavailable(settings, details.url, error));
    }
    return;
  }

  if (!settings.token) {
    await showBadge(details.tabId, 'SET', '#8a6116');
    return;
  }

  try {
    const body = await sendPolicyEvaluation(settings, details);
    updatePolicyFromEvaluation(settings, body)
      .catch(() => {});
    if (body.decision && body.decision.action === 'block') {
      await showBlockPage(details.tabId, details.url, body.decision, 'NO');
      return;
    }
    await chrome.action.setBadgeText({ text: '', tabId: details.tabId });
  } catch (error) {
    await reportAgentUnavailable(settings, details.url, error);
    throw error;
  }
}

async function sendPolicyEvaluation(settings, details) {
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
  return body;
}

async function showBlockPage(tabId, url, decision, badgeText) {
  const blockUrl = chrome.runtime.getURL(`block.html?${new URLSearchParams({
    url,
    reason: decision.reason || 'Blocked by SafeHarbor',
    ruleId: decision.ruleId || '',
    timestamp: decision.timestamp || new Date().toISOString()
  })}`);
  await chrome.tabs.update(tabId, { url: blockUrl });
  await showBadge(tabId, badgeText, '#a22222');
}

async function updatePolicyFromEvaluation(settings, body) {
  if (body && body.policy && body.policyUpdatedAt) {
    await cachePolicy(body.policy, body.policyUpdatedAt);
    return;
  }
  if (!settings.policyCache || Date.now() - Date.parse(settings.policyCache.cachedAt || 0) > POLICY_REFRESH_MS) {
    await refreshPolicyCache(settings);
  }
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
    body.policyUpdatedAt = policyBody.policyUpdatedAt || null;
    await cachePolicy(policyBody.policy, policyBody.policyUpdatedAt || null);
  }
  return { ok: true, body };
}

async function refreshPolicyCache(existingSettings = null) {
  const settings = existingSettings || await getSettings();
  if (!settings.token) return null;
  const response = await fetch(`${settings.serverUrl}/policy`, {
    headers: { authorization: `Bearer ${settings.token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `Policy check returned ${response.status}`);
  await cachePolicy(body.policy, body.policyUpdatedAt || null);
  return body.policy;
}

async function cachePolicy(policy, policyUpdatedAt) {
  const cache = {
    policy,
    policyUpdatedAt: policyUpdatedAt || null,
    cachedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [POLICY_CACHE_KEY]: cache });
  await syncDynamicPolicyRules(policy);
}

async function syncDynamicPolicyRules(policy) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return;
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .map(rule => rule.id)
    .filter(id => id >= DYNAMIC_RULE_ID_START && id <= DYNAMIC_RULE_ID_END);
  const addRules = compileDynamicRules(policy);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

async function reportAgentUnavailable(settings, url, error) {
  if (!settings.token) return;
  await fetch(`${settings.serverUrl}/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      type: 'tamper_signal',
      timestamp: new Date().toISOString(),
      url,
      reason: `Local SafeHarbor agent unavailable: ${error.message}`,
      source: 'chrome-extension',
      metadata: { signal: 'agent_unavailable' }
    })
  }).catch(() => {});
}

async function openStatusPage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('status.html') });
  return { ok: true };
}

async function openDashboardPage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  return { ok: true };
}

async function showBadge(tabId, text, color) {
  await chrome.action.setBadgeText({ text, tabId });
  await chrome.action.setBadgeBackgroundColor({ color, tabId });
}
