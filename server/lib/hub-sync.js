'use strict';

const crypto = require('crypto');

function createHubSync({
  asString,
  config,
  getContext,
  getDeviceId,
  logEvent,
  normalizePolicy,
  nowIso,
  paths,
  store,
  validatePolicy,
  writeJson,
  env = process.env,
  fetchImpl = fetch
}) {
  const defaultIntervalMs = 60 * 1000;
  const defaultTimeoutMs = 10 * 1000;
  const maxBackoffMs = 5 * 60 * 1000;
  let timer = null;
  let inFlight = false;
  let backoffMs = 0;

  function settings() {
    const hubUrl = asString(env.SAFEHARBOR_HUB_URL || config.hubUrl).replace(/\/+$/, '');
    const token = asString(env.SAFEHARBOR_HUB_TOKEN || config.hubToken);
    if (!hubUrl || !token) return null;
    let url;
    try {
      url = new URL(hubUrl);
    } catch {
      throw new Error('Invalid SAFEHARBOR_HUB_URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('SAFEHARBOR_HUB_URL must start with http:// or https://.');
    }
    return {
      url: hubUrl,
      token,
      intervalMs: Math.max(5000, Number(env.SAFEHARBOR_HUB_SYNC_INTERVAL_MS || defaultIntervalMs)),
      timeoutMs: Math.max(1000, Number(env.SAFEHARBOR_HUB_SYNC_TIMEOUT_MS || defaultTimeoutMs))
    };
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = defaultTimeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      return { response, body };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Hub request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function run() {
    const hub = settings();
    if (!hub) return;

    const { profile, device } = getContext();
    const deviceId = getDeviceId();
    const activeDevice = store.getDevice(deviceId) || device;
    const headers = {
      authorization: `Bearer ${hub.token}`,
      'content-type': 'application/json'
    };

    const policyUrl = `${hub.url}/sync/policy?deviceId=${encodeURIComponent(deviceId)}`;
    const { response: policyResponse, body: policyBody } = await fetchJsonWithTimeout(policyUrl, { headers }, hub.timeoutMs);
    if (!policyResponse.ok || !policyBody.ok) {
      throw new Error(policyBody.error || `Hub policy sync returned ${policyResponse.status}`);
    }
    if (policyBody.policy) {
      const nextPolicy = normalizePolicy(policyBody.policy);
      const validationError = validatePolicy(nextPolicy);
      if (validationError) throw new Error(`Hub policy sync failed: ${validationError}`);
      const currentPolicy = store.getPolicyRecord(nextPolicy.profileId);
      const nextUpdatedAt = policyBody.policyUpdatedAt || policyBody.policyRevision || null;
      if (!currentPolicy || !nextUpdatedAt || Date.parse(nextUpdatedAt) > Date.parse(currentPolicy.updatedAt || 0)) {
        store.upsertPolicy(nextPolicy, { updatedAt: nextUpdatedAt || undefined });
      }
    }

    const events = store.eventsAfterId(config.hubLastEventId, 100);
    if (!events.length) {
      config.hubLastSyncAt = nowIso();
      config.hubLastSyncError = null;
      writeJson(paths.config, config);
      return;
    }

    const batchId = crypto.randomUUID();
    const { response: eventsResponse, body: eventsBody } = await fetchJsonWithTimeout(`${hub.url}/sync/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        batchId,
        deviceId,
        profileId: activeDevice.profileId || profile.id,
        device: {
          id: deviceId,
          name: activeDevice.name,
          platform: activeDevice.platform,
          profileId: activeDevice.profileId || profile.id,
          createdAt: activeDevice.createdAt
        },
        events: events.map(event => ({
          ...event,
          deviceId: event.deviceId || deviceId,
          profileId: event.profileId || activeDevice.profileId || profile.id,
          metadata: {
            ...(event.metadata || {}),
            localEventId: event.id
          },
          localEventId: event.id
        }))
      })
    }, hub.timeoutMs);
    if (!eventsResponse.ok || !eventsBody.ok) {
      throw new Error(eventsBody.error || `Hub event sync returned ${eventsResponse.status}`);
    }
    const confirmed = eventsBody.batchId === batchId
      && Number(eventsBody.received) === events.length
      && Number(eventsBody.accepted || 0) + Number(eventsBody.duplicates || 0) === events.length
      && Number(eventsBody.lastLocalEventId) === events[events.length - 1].id;
    if (!confirmed) {
      throw new Error('Hub event sync acknowledgement did not match the sent batch.');
    }

    config.hubLastEventId = events[events.length - 1].id;
    config.hubLastSyncAt = nowIso();
    config.hubLastSyncError = null;
    writeJson(paths.config, config);
    logEvent('info', 'hub_sync_completed', {
      hub: hub.url,
      accepted: eventsBody.accepted,
      lastEventId: config.hubLastEventId
    });
  }

  function nextBackoff() {
    if (!backoffMs) return 5000;
    return Math.min(backoffMs * 2, maxBackoffMs);
  }

  function schedule(delayMs) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runScheduled, delayMs);
    timer.unref();
  }

  function runScheduled() {
    const hub = settings();
    if (!hub) return;
    if (inFlight) {
      logEvent('warn', 'hub_sync_skipped_in_flight');
      schedule(hub.intervalMs);
      return;
    }

    inFlight = true;
    run()
      .then(() => {
        backoffMs = 0;
        schedule(hub.intervalMs);
      })
      .catch(error => {
        backoffMs = nextBackoff();
        config.hubLastSyncError = error.message;
        writeJson(paths.config, config);
        logEvent('error', 'hub_sync_failed', { error: error.message, retryInMs: backoffMs });
        schedule(backoffMs);
      })
      .finally(() => {
        inFlight = false;
      });
  }

  function start() {
    const hub = settings();
    if (!hub) return;
    schedule(0);
  }

  function stop() {
    if (timer) clearTimeout(timer);
  }

  return {
    run,
    settings,
    start,
    stop
  };
}

module.exports = {
  createHubSync
};
