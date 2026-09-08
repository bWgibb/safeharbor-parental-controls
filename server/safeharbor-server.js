#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { createAuth, hashDeviceToken } = require('./lib/auth');
const { sendSqliteBackup } = require('./lib/backup');
const { createPaths, ensureDir, loadConfig, resolveBaseDir, writeJson } = require('./lib/config');
const { defaultDevice, defaultPolicy, defaultProfile } = require('./lib/defaults');
const { EventStore } = require('./lib/event-store');
const { createHubSync } = require('./lib/hub-sync');
const {
  readBody: readRequestBody,
  sendFile,
  sendHtml,
  sendJson,
  sendText,
  staticContentType
} = require('./lib/http-utils');
const { createPolicyHandlers } = require('./lib/policy-handlers');
const { evaluatePolicy, normalizePolicy } = require('./lib/policy-engine');
const { validateNormalizedPolicy, validateRawPolicy } = require('./lib/policy-validation');
const { parseReportFilters } = require('./lib/report-time');

const APP_NAME = 'SafeHarbor';
const VERSION = '0.3.0';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_ACTIVITY = 50;
const ENROLLMENT_CODE_MINUTES = 15;
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

const args = new Set(process.argv.slice(2));
const rootDir = path.resolve(__dirname, '..');
const extensionDir = path.join(rootDir, 'extension');
const paths = createPaths(resolveBaseDir());
const config = loadConfig(paths);
ensureDir(config.capturesDir);
ensureDir(paths.alerts);

if (args.has('--show-token')) {
  process.stdout.write(config.parentToken + '\n');
  process.exit(0);
}

if (args.has('--show-device-token')) {
  process.stdout.write(config.deviceToken + '\n');
  process.exit(0);
}

const store = new EventStore(paths.database);
store.seed({
  profile: defaultProfile(),
  device: defaultDevice(),
  policy: defaultPolicy()
});
store.setDeviceTokenHash(defaultDevice().id, hashDeviceToken(config.deviceToken), { onlyIfMissing: true });
ensureConfiguredDevice();
const {
  authScope,
  forbidden,
  requireDeviceForIdOrParent,
  requireDeviceOrParent,
  requireParent
} = createAuth({ config, store, defaultDevice, sendJson });
const policyHandlers = createPolicyHandlers({
  asString,
  domainFromUrl,
  evaluatePolicy,
  getDefaultContext,
  normalizePolicy,
  nowIso,
  readBody,
  requireDeviceForIdOrParent,
  requireDeviceOrParent,
  requireParent,
  sendJson,
  store,
  validateNormalizedPolicy,
  validateRawPolicy
});

function nowIso() {
  return new Date().toISOString();
}

function formatReginaTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return REGINA_TIME_FORMAT.format(date)
    .replace('GMT-06:00', 'GMT-6')
    .replace('GMT-06', 'GMT-6');
}

function configBody() {
  const hubSettings = hubSyncSettings();
  return {
    app: APP_NAME,
    version: VERSION,
    host: config.host,
    port: config.port,
    configFile: paths.config,
    capturesDir: config.capturesDir,
    databaseFile: paths.database,
    logsDir: paths.logs,
    alertsDir: paths.alerts,
    hubSyncEnabled: Boolean(hubSettings),
    hubUrl: hubSettings ? hubSettings.url : '',
    deviceId: configuredDeviceId(),
    hubLastEventId: config.hubLastEventId,
    hubLastSyncAt: config.hubLastSyncAt,
    hubLastSyncError: config.hubLastSyncError,
    hubPendingEvents: store ? store.eventsAfterId(config.hubLastEventId, 500).length : 0,
    alertPreferences: config.alertPreferences
  };
}

function rotateLogIfNeeded(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= 1024 * 1024) return;
    const rotated = `${file}.${Date.now()}.old`;
    fs.renameSync(file, rotated);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function logEvent(level, message, details = {}) {
  const line = JSON.stringify({ timestamp: nowIso(), level, message, ...details }) + '\n';
  const file = path.join(paths.logs, 'server.log');
  rotateLogIfNeeded(file);
  fs.appendFileSync(file, line);
}

function readBody(req) {
  return readRequestBody(req, MAX_BODY_BYTES);
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function configuredDeviceId() {
  return asString(process.env.SAFEHARBOR_DEVICE_ID || config.deviceId, defaultDevice().id);
}

function configuredProfileId() {
  const enrolled = config.enrolledDevice && typeof config.enrolledDevice === 'object' ? config.enrolledDevice : {};
  return asString(config.profileId || enrolled.profileId, defaultProfile().id);
}

function ensureConfiguredDevice() {
  const deviceId = configuredDeviceId();
  if (!deviceId || deviceId === defaultDevice().id) return;
  const enrolled = config.enrolledDevice && typeof config.enrolledDevice === 'object' ? config.enrolledDevice : {};
  store.upsertDevice({
    id: deviceId,
    name: asString(enrolled.name, 'Enrolled Device'),
    platform: asString(enrolled.platform, process.platform),
    profileId: configuredProfileId(),
    createdAt: asString(enrolled.createdAt, nowIso())
  });
}

function truncate(value, limit) {
  const text = asString(value);
  if (text.length <= limit) return text;
  return text.slice(0, limit - 20) + '\n\n[truncated]';
}

function slugify(value) {
  const text = asString(value, 'capture')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return text || 'capture';
}

function domainFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hashEnrollmentCode(code) {
  return crypto
    .createHash('sha256')
    .update(`${config.parentToken}:${code}`)
    .digest('hex');
}

function generateEnrollmentCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function normalizePayload(body, fallbackType) {
  const tab = body && typeof body.tab === 'object' && body.tab ? body.tab : {};
  const content = body && typeof body.content === 'object' && body.content ? body.content : {};
  const metadata = body && typeof body.metadata === 'object' && body.metadata ? body.metadata : {};
  const url = asString(tab.url);

  let origin = asString(tab.origin);
  if (!origin && url) {
    try {
      origin = new URL(url).origin;
    } catch {
      origin = '';
    }
  }

  return {
    type: asString(body.type, fallbackType),
    timestamp: asString(body.timestamp, nowIso()),
    source: asString(body.source, 'chrome-extension'),
    tab: {
      url,
      title: asString(tab.title),
      origin
    },
    content: {
      selectedText: truncate(content.selectedText, 20000),
      readableText: truncate(content.readableText, 200000),
      html: null
    },
    intent: asString(body.intent, 'debug-export'),
    metadata: {
      client: metadata.client || null,
      project: metadata.project || null,
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter(tag => typeof tag === 'string') : [],
      page: metadata.page || null
    }
  };
}

function markdownEscape(text) {
  return asString(text).replace(/\r\n/g, '\n').trim();
}

function writeCapture(payload) {
  const stamp = payload.timestamp.replace(/[:.]/g, '-');
  const nameHint = payload.tab.title || payload.tab.url || payload.type;
  const fileName = `${stamp}-${slugify(nameHint)}.md`;
  const filePath = path.join(config.capturesDir, fileName);
  const selectedText = markdownEscape(payload.content.selectedText);
  const readableText = markdownEscape(payload.content.readableText);

  const lines = [
    '---',
    `type: ${payload.type}`,
    `timestamp: ${payload.timestamp}`,
    `source: ${payload.source}`,
    `intent: ${payload.intent}`,
    `url: ${JSON.stringify(payload.tab.url)}`,
    `title: ${JSON.stringify(payload.tab.title)}`,
    `origin: ${JSON.stringify(payload.tab.origin)}`,
    `client: ${JSON.stringify(payload.metadata.client)}`,
    `project: ${JSON.stringify(payload.metadata.project)}`,
    `tags: ${JSON.stringify(payload.metadata.tags)}`,
    '---',
    '',
    `# ${payload.tab.title || payload.tab.url || 'Browser Capture'}`,
    '',
    payload.tab.url ? `Source: ${payload.tab.url}` : '',
    '',
    selectedText ? '## Selected Text' : '',
    selectedText,
    '',
    readableText ? '## Readable Text' : '',
    readableText,
    ''
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');

  fs.writeFileSync(filePath, lines.join('\n'), { mode: 0o600 });
  return filePath;
}

function getDefaultContext() {
  ensureConfiguredDevice();
  const profile = store.getProfiles().find(item => item.id === configuredProfileId()) || store.getProfiles()[0];
  const device = store.getDevice(configuredDeviceId())
    || store.getDevices().find(item => item.profileId === profile.id)
    || store.getDevices()[0];
  const policy = normalizePolicy(store.getPolicy(profile.id) || defaultPolicy());
  return { profile, device, policy };
}

function statusBody() {
  generateConfiguredAlerts();
  deliverOpenAlerts();
  const reports = store.reports();
  const alerts = store.alerts();
  return {
    ok: true,
    ...configBody(),
    profiles: store.getProfiles(),
    devices: store.getDevices(),
    enrollmentCodes: store.recentEnrollmentCodes(),
    policy: getDefaultContext().policy,
    reports,
    alerts,
    recentActivity: store.recentEvents(MAX_RECENT_ACTIVITY)
  };
}

function generateConfiguredAlerts() {
  store.generateAlerts(nowIso(), config.alertPreferences);
}

function statusHtml(body) {
  const rows = body.recentActivity.map(item => {
    const url = item.url ? `<a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a>` : '';
    return `<tr><td>${escapeHtml(formatReginaTime(item.timestamp))}</td><td>${escapeHtml(item.type || '')}</td><td>${escapeHtml(item.decision || '')}</td><td>${escapeHtml(item.reason || '')}</td><td>${url}</td></tr>`;
  }).join('');

  const counts = body.reports.counts;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${APP_NAME}</title>
  <style>
    body { color: #17202a; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; }
    code { background: #eef2f6; border-radius: 4px; padding: 2px 5px; }
    .metrics { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin: 20px 0; }
    .metric { border: 1px solid #d9e0e8; border-radius: 6px; padding: 12px; }
    .metric strong { display: block; font-size: 22px; }
    table { border-collapse: collapse; margin-top: 20px; width: 100%; }
    th, td { border-bottom: 1px solid #d9e0e8; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f5f7fa; }
  </style>
</head>
<body>
  <h1>${APP_NAME}</h1>
  <p>Server is running on <code>${escapeHtml(body.host)}:${body.port}</code>.</p>
  <p>SQLite database: <code>${escapeHtml(body.databaseFile)}</code></p>
  <div class="metrics">
    <div class="metric"><strong>${counts.totalEvents}</strong>Total Events</div>
    <div class="metric"><strong>${counts.allowedVisits}</strong>Allowed</div>
    <div class="metric"><strong>${counts.blockedVisits}</strong>Blocked</div>
    <div class="metric"><strong>${counts.tamperSignals}</strong>Tamper Signals</div>
  </div>
  <h2>Recent Activity</h2>
  <table>
    <thead><tr><th>Time (America/Regina)</th><th>Type</th><th>Decision</th><th>Reason</th><th>URL</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No events yet.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

function dashboardHtml() {
  const html = fs.readFileSync(path.join(extensionDir, 'dashboard.html'), 'utf8');
  const script = fs.readFileSync(path.join(extensionDir, 'dashboard.js'), 'utf8');
  return html.replace(
    /<script src="dashboard\.js[^"]*"><\/script>/,
    `<script>\n${script}\n</script>`
  );
}

function escapeHtml(value) {
  return asString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function eventsToCsv(events) {
  const header = ['id', 'timestamp', 'type', 'profileId', 'deviceId', 'decision', 'domain', 'url', 'category', 'ruleId', 'reason', 'source'];
  const lines = [header.join(',')];
  for (const event of events) {
    lines.push(header.map(key => csvEscape(event[key])).join(','));
  }
  return lines.join('\n') + '\n';
}

function safeFileStamp() {
  return nowIso().replace(/[:.]/g, '-');
}

function alertEml(alert) {
  return [
    `From: SafeHarbor <safeharbor@local>`,
    `To: Parent <parent@local>`,
    `Subject: [SafeHarbor] ${alert.title}`,
    `Date: ${new Date(alert.createdAt).toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    alert.title,
    '',
    alert.message,
    '',
    `Severity: ${alert.severity}`,
    `Type: ${alert.type}`,
    `Profile: ${alert.profileId || ''}`,
    `Device: ${alert.deviceId || ''}`,
    `Created: ${alert.createdAt}`,
    ''
  ].join('\n');
}

function deliverOpenAlerts() {
  if (process.env.SAFEHARBOR_ALERT_DELIVERY === 'off') return;
  ensureDir(paths.alerts);
  const alerts = store.alerts(50).rows.filter(alert => !alert.deliveredAt && alertDeliveryEnabled(alert.type));
  for (const alert of alerts) {
    const fileName = `${safeFileStamp()}-alert-${alert.id}-${slugify(alert.type)}.eml`;
    fs.writeFileSync(path.join(paths.alerts, fileName), alertEml(alert), { mode: 0o600 });
    store.markAlertDelivered(alert.id);
  }
}

function alertDeliveryEnabled(type) {
  const preferences = config.alertPreferences || {};
  const map = {
    repeated_block: 'repeatedBlock',
    schedule_violation: 'scheduleViolation',
    tamper_signal: 'tamperSignal',
    device_offline: 'deviceOffline',
    device_revoked: 'deviceRevoked'
  };
  const key = map[type];
  return !key || preferences[key] !== false;
}

function deviceIsRevoked(deviceId) {
  const device = store.getDevice(deviceId);
  return Boolean(device && device.revokedAt);
}

async function handleCapture(req, res, fallbackType) {
  if (!requireDeviceOrParent(req, res)) return;

  const body = await readBody(req);
  const payload = normalizePayload(body, fallbackType);
  const filePath = writeCapture(payload);
  const { profile, device } = getDefaultContext();

  store.recordEvent({
    type: payload.type,
    timestamp: payload.timestamp,
    url: payload.tab.url,
    domain: domainFromUrl(payload.tab.url),
    title: payload.tab.title,
    profileId: profile.id,
    deviceId: device.id,
    source: payload.source,
    metadata: { file: filePath, intent: payload.intent, page: payload.metadata.page }
  });

  logEvent('info', 'capture_saved', {
    type: payload.type,
    url: payload.tab.url,
    file: filePath
  });

  sendJson(res, 200, { ok: true, file: filePath });
}

async function handleAction(req, res) {
  if (!requireDeviceOrParent(req, res)) return;

  const body = await readBody(req);
  const { profile, device } = getDefaultContext();
  const timestamp = nowIso();
  store.recordEvent({
    type: 'action',
    timestamp,
    title: asString(body.title),
    url: asString(body.url),
    domain: domainFromUrl(asString(body.url)),
    profileId: profile.id,
    deviceId: device.id,
    source: 'chrome-extension',
    metadata: { intent: asString(body.intent, 'unknown') }
  });
  logEvent('info', 'action_received', { intent: asString(body.intent, 'unknown') });
  sendJson(res, 202, { ok: true, accepted: true });
}

async function handleEvent(req, res) {
  const body = await readBody(req);
  const type = asString(body.type);
  if (!type) {
    sendJson(res, 400, { ok: false, error: 'event_type_required' });
    return;
  }

  const { profile, device } = getDefaultContext();
  const timestamp = asString(body.timestamp, nowIso());
  const deviceId = asString(body.deviceId, device.id);
  if (!requireDeviceForIdOrParent(req, res, deviceId)) return;

  store.recordEvent({
    type,
    timestamp,
    url: asString(body.url),
    domain: asString(body.domain) || domainFromUrl(asString(body.url)),
    title: asString(body.title),
    profileId: asString(body.profileId, profile.id),
    deviceId,
    decision: asString(body.decision),
    ruleId: asString(body.ruleId),
    reason: asString(body.reason),
    category: asString(body.category),
    source: asString(body.source, 'local-agent'),
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
  });
  sendJson(res, 202, { ok: true, accepted: true });
}

async function handleEnrollmentCodeCreate(req, res) {
  if (!requireParent(req, res)) return;

  const body = await readBody(req);
  const { profile } = getDefaultContext();
  const profileId = asString(body.profileId, profile.id);
  const code = generateEnrollmentCode();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_MINUTES * 60 * 1000).toISOString();
  store.createEnrollmentCode({
    codeHash: hashEnrollmentCode(code),
    profileId,
    createdAt,
    expiresAt
  });
  store.recordEvent({
    type: 'enrollment_code_created',
    timestamp: createdAt,
    profileId,
    source: 'parent-dashboard',
    metadata: { expiresAt }
  });
  sendJson(res, 201, { ok: true, code, profileId, expiresAt });
}

async function handleDeviceEnroll(req, res) {
  const body = await readBody(req);
  const code = asString(body.code).replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) {
    sendJson(res, 400, { ok: false, error: 'valid_6_digit_code_required' });
    return;
  }

  const deviceId = asString(body.deviceId, `device-${crypto.randomUUID()}`);
  const timestamp = nowIso();
  const deviceToken = crypto.randomBytes(32).toString('hex');
  const device = {
    id: deviceId,
    name: asString(body.name, 'Enrolled Device'),
    platform: asString(body.platform, 'unknown'),
    createdAt: timestamp,
    lastSeenAt: timestamp,
    deviceTokenHash: hashDeviceToken(deviceToken)
  };
  const enrollment = store.enrollDevice(hashEnrollmentCode(code), device, timestamp);
  if (!enrollment) {
    sendJson(res, 400, { ok: false, error: 'invalid_or_expired_enrollment_code' });
    return;
  }

  const policyRecord = store.getPolicyRecord(enrollment.profileId);
  store.recordEvent({
    type: 'device_enrolled',
    timestamp,
    profileId: enrollment.profileId,
    deviceId,
    source: 'device-enrollment',
    metadata: { platform: device.platform }
  });
  sendJson(res, 201, {
    ok: true,
    device: store.getDevice(deviceId),
    deviceToken,
    profileId: enrollment.profileId,
    policy: policyRecord ? policyRecord.policy : null,
    policyUpdatedAt: policyRecord ? policyRecord.updatedAt : null,
    serverTime: timestamp
  });
}

async function handleHeartbeat(req, res) {
  const body = await readBody(req);
  const { device } = getDefaultContext();
  const deviceId = asString(body.deviceId, device.id);
  if (!requireDeviceForIdOrParent(req, res, deviceId)) return;

  const timestamp = nowIso();
  const existingDevice = store.getDevice(deviceId);
  if (existingDevice && existingDevice.revokedAt) {
    forbidden(res, 'device_revoked');
    return;
  }
  if (!existingDevice && body.device && typeof body.device === 'object') {
    store.upsertDevice({
      id: deviceId,
      name: asString(body.device.name, 'Synced Device'),
      platform: asString(body.device.platform, asString(body.platform, 'unknown')),
      profileId: asString(body.device.profileId, device.profileId),
      createdAt: asString(body.device.createdAt, timestamp),
      lastSeenAt: timestamp
    });
  }
  store.touchDevice(deviceId, timestamp);
  store.recordEvent({
    type: 'device_heartbeat',
    timestamp,
    deviceId,
    source: asString(body.source, 'local-agent'),
    metadata: {
      version: asString(body.version),
      platform: asString(body.platform)
    }
  });
  sendJson(res, 200, { ok: true, device: store.getDevice(deviceId), serverTime: timestamp });
}

async function handleSyncEvents(req, res) {
  const body = await readBody(req);
  const events = Array.isArray(body.events) ? body.events : [];
  if (!events.length) {
    sendJson(res, 400, { ok: false, error: 'events_required' });
    return;
  }
  if (events.length > 100) {
    sendJson(res, 413, { ok: false, error: 'sync_batch_too_large', maxEvents: 100, received: events.length });
    return;
  }

  const { device: fallbackDevice } = getDefaultContext();
  const syncedDevice = body.device && typeof body.device === 'object' ? body.device : null;
  const bodyDeviceId = asString(body.deviceId, syncedDevice ? syncedDevice.id : '');
  const bodyProfileId = asString(body.profileId, syncedDevice ? syncedDevice.profileId : '');
  if (!requireDeviceForIdOrParent(req, res, bodyDeviceId, { unknownStatusCode: 403 })) return;
  const scope = authScope(req);
  if (bodyDeviceId && !store.getDevice(bodyDeviceId)) {
    store.upsertDevice({
      id: bodyDeviceId,
      name: asString(syncedDevice && syncedDevice.name, 'Synced Device'),
      platform: asString(syncedDevice && syncedDevice.platform, 'unknown'),
      profileId: bodyProfileId || fallbackDevice.profileId,
      createdAt: asString(syncedDevice && syncedDevice.createdAt, nowIso()),
      lastSeenAt: nowIso()
    });
  }

  const accepted = [];
  let duplicates = 0;
  const seenDeviceIds = new Set();
  let lastLocalEventId = null;
  const processedEvents = events;
  for (const event of processedEvents) {
    const timestamp = asString(event.timestamp, nowIso());
    const deviceId = asString(event.deviceId, bodyDeviceId);
    if (scope !== 'parent' && deviceId !== bodyDeviceId) {
      sendJson(res, 403, { ok: false, error: 'event_device_mismatch' });
      return;
    }
    const profileId = asString(event.profileId, bodyProfileId);
    const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    const rawLocalEventId = event.localEventId ?? metadata.localEventId ?? event.id;
    const localEventId = rawLocalEventId == null ? '' : String(rawLocalEventId);
    lastLocalEventId = localEventId;
    const eventKey = deviceId && localEventId ? `${deviceId}:${localEventId}` : '';
    const result = store.recordEvent({
      type: asString(event.type, 'sync_event'),
      timestamp,
      url: asString(event.url),
      domain: asString(event.domain) || domainFromUrl(asString(event.url)),
      title: asString(event.title),
      profileId,
      deviceId,
      decision: asString(event.decision),
      ruleId: asString(event.ruleId),
      reason: asString(event.reason),
      category: asString(event.category),
      source: asString(event.source, 'sync'),
      eventKey,
      metadata
    });
    if (deviceId) seenDeviceIds.add(deviceId);
    if (result.inserted) accepted.push(timestamp);
    else duplicates += 1;
  }

  const serverTime = nowIso();
  for (const deviceId of seenDeviceIds) {
    store.touchDevice(deviceId, serverTime);
    store.markDeviceSynced(deviceId, serverTime);
  }

  sendJson(res, 202, {
    ok: true,
    batchId: asString(body.batchId),
    received: processedEvents.length,
    accepted: accepted.length,
    duplicates,
    lastLocalEventId,
    serverTime
  });
}

function syncPolicyBody(deviceId) {
  const fallback = getDefaultContext();
  const device = store.getDevice(deviceId) || fallback.device;
  if (device.revokedAt) {
    return { ok: false, error: 'device_revoked' };
  }
  const profileId = device.profileId || fallback.profile.id;
  const policyRecord = store.getPolicyRecord(profileId);
  store.touchDevice(device.id);
  return {
    ok: true,
    device: store.getDevice(device.id),
    profile: store.getProfiles().find(item => item.id === profileId) || fallback.profile,
    policy: policyRecord ? normalizePolicy(policyRecord.policy) : fallback.policy,
    policyUpdatedAt: policyRecord ? policyRecord.updatedAt : null,
    policyRevision: policyRecord ? policyRecord.updatedAt : null,
    serverTime: nowIso()
  };
}

async function handleTokenRotate(req, res) {
  if (!requireParent(req, res)) return;

  const body = await readBody(req);
  config.parentToken = crypto.randomBytes(32).toString('hex');
  config.token = config.parentToken;
  if (body.rotateDeviceToken === true || asString(body.rotateDeviceToken) === 'true') {
    config.deviceToken = crypto.randomBytes(32).toString('hex');
    store.setDeviceTokenHash(defaultDevice().id, hashDeviceToken(config.deviceToken));
  }
  writeJson(paths.config, config);
  logEvent('info', 'token_rotated');
  sendJson(res, 200, { ok: true, token: config.parentToken, parentToken: config.parentToken, deviceToken: config.deviceToken });
}

async function handleDeviceRevoke(req, res) {
  if (!requireParent(req, res)) return;

  const body = await readBody(req);
  const deviceId = asString(body.deviceId);
  if (!deviceId) {
    sendJson(res, 400, { ok: false, error: 'device_id_required' });
    return;
  }
  const timestamp = nowIso();
  const device = store.revokeDevice(deviceId, asString(body.reason, 'Revoked by parent'), timestamp);
  if (!device) {
    sendJson(res, 404, { ok: false, error: 'device_not_found' });
    return;
  }
  store.recordEvent({
    type: 'device_revoked',
    timestamp,
    profileId: device.profileId,
    deviceId,
    source: 'parent-dashboard',
    metadata: { reason: device.revokedReason }
  });
  if ((config.alertPreferences || {}).deviceRevoked !== false) {
    store.upsertAlert({
      alertKey: `device-revoked:${deviceId}:${timestamp}`,
      type: 'device_revoked',
      severity: 'medium',
      title: 'Device revoked',
      message: `${device.name} was revoked.`,
      profileId: device.profileId,
      deviceId,
      createdAt: timestamp,
      metadata: { reason: device.revokedReason }
    });
  }
  sendJson(res, 200, { ok: true, device });
}

async function handleAlertResolve(req, res) {
  if (!requireParent(req, res)) return;

  const body = await readBody(req);
  const alertId = Number(body.alertId);
  if (!Number.isInteger(alertId) || alertId < 1) {
    sendJson(res, 400, { ok: false, error: 'alert_id_required' });
    return;
  }
  sendJson(res, 200, { ok: true, resolved: store.resolveAlert(alertId) });
}

async function handleAlertPreferencesUpdate(req, res) {
  if (!requireParent(req, res)) return;

  const body = await readBody(req);
  const source = body.alertPreferences && typeof body.alertPreferences === 'object'
    ? body.alertPreferences
    : body;
  const next = { ...config.alertPreferences };
  for (const key of Object.keys(next)) {
    if (source[key] != null) next[key] = Boolean(source[key]);
  }
  config.alertPreferences = next;
  writeJson(paths.config, config);
  sendJson(res, 200, { ok: true, alertPreferences: config.alertPreferences });
}

async function handleBackup(req, res) {
  if (!requireParent(req, res)) return;

  await sendSqliteBackup({ res, store, nowIso });
}

const hubSync = createHubSync({
  asString,
  config,
  getContext: getDefaultContext,
  getDeviceId: configuredDeviceId,
  logEvent,
  normalizePolicy,
  nowIso,
  paths,
  store,
  validatePolicy: validateNormalizedPolicy,
  writeJson
});

if (args.has('--print-config')) {
  process.stdout.write(JSON.stringify(configBody(), null, 2) + '\n');
  store.close();
  process.exit(0);
}

function hubSyncSettings() {
  return hubSync.settings();
}

function startHubSync() {
  hubSync.start();
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${config.host}:${config.port}`);

    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        app: APP_NAME,
        version: VERSION,
        host: config.host,
        port: config.port,
        database: Boolean(store),
        hubSyncEnabled: Boolean(hubSyncSettings())
      });
      return;
    }

    if (req.method === 'GET' && (parsed.pathname === '/dashboard' || parsed.pathname === '/dashboard.html')) {
      sendHtml(res, 200, dashboardHtml());
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/favicon.ico') {
      sendText(res, 204, '', 'image/x-icon');
      return;
    }

    if (req.method === 'GET' && ['/dashboard.css', '/dashboard.js'].includes(parsed.pathname)) {
      const fileName = parsed.pathname.slice(1);
      sendFile(res, path.join(extensionDir, fileName), staticContentType(fileName));
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/status') {
      if (!requireParent(req, res)) return;
      const body = statusBody();
      if ((req.headers.accept || '').includes('text/html')) {
        sendHtml(res, 200, statusHtml(body));
      } else {
        sendJson(res, 200, body);
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/policy') {
      policyHandlers.handlePolicyRead(req, res);
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/devices') {
      if (!requireParent(req, res)) return;
      sendJson(res, 200, { ok: true, devices: store.getDevices() });
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/devices/sync-status') {
      if (!requireParent(req, res)) return;
      sendJson(res, 200, {
        ok: true,
        devices: store.getDevices().map(device => ({
          id: device.id,
          name: device.name,
          status: device.status,
          lastSeenAt: device.lastSeenAt,
          lastSyncAt: device.lastSyncAt,
          revokedAt: device.revokedAt,
          revokedReason: device.revokedReason
        }))
      });
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/devices/heartbeat') {
      await handleHeartbeat(req, res);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/devices/revoke') {
      await handleDeviceRevoke(req, res);
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/enrollment/codes') {
      if (!requireParent(req, res)) return;
      sendJson(res, 200, { ok: true, enrollmentCodes: store.recentEnrollmentCodes() });
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/enrollment/code') {
      await handleEnrollmentCodeCreate(req, res);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/devices/enroll') {
      await handleDeviceEnroll(req, res);
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/sync/policy') {
      const { device } = getDefaultContext();
      const deviceId = asString(parsed.searchParams.get('deviceId'), device.id);
      if (!requireDeviceForIdOrParent(req, res, deviceId)) return;
      const body = syncPolicyBody(deviceId);
      sendJson(res, body.ok ? 200 : 403, body);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/sync/events') {
      await handleSyncEvents(req, res);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/policy') {
      await policyHandlers.handlePolicyUpdate(req, res);
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/policy/export.json') {
      policyHandlers.handlePolicyExport(req, res);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/policy/import') {
      await policyHandlers.handlePolicyImport(req, res);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/policy/evaluate') {
      await policyHandlers.handleEvaluate(req, res);
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/reports/local') {
      if (!requireParent(req, res)) return;
      generateConfiguredAlerts();
      const filters = parseReportFilters(parsed.searchParams);
      sendJson(res, 200, {
        ok: true,
        filters,
        reports: store.reports(filters),
        recentActivity: store.recentEvents(MAX_RECENT_ACTIVITY, filters),
        alerts: store.alerts()
      });
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/reports/export.json') {
      if (!requireParent(req, res)) return;
      const filters = parseReportFilters(parsed.searchParams);
      sendJson(res, 200, { ok: true, filters, events: store.exportEvents(filters, 5000) });
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/reports/export.csv') {
      if (!requireParent(req, res)) return;
      const filters = parseReportFilters(parsed.searchParams);
      sendText(res, 200, eventsToCsv(store.exportEvents(filters, 5000)), 'text/csv; charset=utf-8', 'safeharbor-report.csv');
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/alerts') {
      if (!requireParent(req, res)) return;
      generateConfiguredAlerts();
      deliverOpenAlerts();
      sendJson(res, 200, { ok: true, alerts: store.alerts(50, parsed.searchParams.get('includeResolved') === 'true') });
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/alerts/resolve') {
      await handleAlertResolve(req, res);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/alerts/preferences') {
      await handleAlertPreferencesUpdate(req, res);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/events') {
      await handleEvent(req, res);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/capture/page') {
      await handleCapture(req, res, 'page_capture');
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/capture/selection') {
      await handleCapture(req, res, 'selection_capture');
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/action') {
      await handleAction(req, res);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/token/rotate') {
      await handleTokenRotate(req, res);
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/backup/safeharbor.sqlite') {
      await handleBackup(req, res);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    logEvent('error', 'request_failed', { error: error.message, statusCode });
    if (!res.headersSent) {
      sendJson(res, statusCode, { ok: false, error: error.message });
    } else {
      res.end();
    }
  }
});

server.on('error', error => {
  logEvent('error', 'server_start_failed', { error: error.message, code: error.code });
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(`${APP_NAME} could not start because ${config.host}:${config.port} is already in use.\n`);
    process.stderr.write(`Start with another port, for example: PORT=${config.port + 1} npm start\n`);
    store.close();
    process.exit(1);
    return;
  }
  store.close();
  throw error;
});

server.listen(config.port, config.host, () => {
  store.recordEvent({
    type: 'agent_started',
    timestamp: nowIso(),
    source: 'local-agent',
    metadata: { host: config.host, port: config.port, version: VERSION }
  });
  logEvent('info', 'server_started', { host: config.host, port: config.port });
  process.stdout.write(`${APP_NAME} listening at http://${config.host}:${config.port}\n`);
  process.stdout.write(`Config: ${paths.config}\n`);
  process.stdout.write(`SQLite: ${paths.database}\n`);
  process.stdout.write('Run `npm run token` to print the extension token.\n');
  startHubSync();
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function shutdown(signal) {
  logEvent('info', 'server_stopping', { signal });
  hubSync.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
