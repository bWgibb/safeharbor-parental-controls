#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { defaultDevice, defaultPolicy, defaultProfile } = require('./lib/defaults');
const { EventStore } = require('./lib/event-store');
const { evaluatePolicy, normalizePolicy } = require('./lib/policy-engine');

const APP_NAME = 'SafeHarbor';
const VERSION = '0.2.0';
const DEFAULT_PORT = 43718;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_ACTIVITY = 50;
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
const baseDir = process.env.SAFEHARBOR_HOME
  ? path.resolve(process.env.SAFEHARBOR_HOME)
  : path.join(os.homedir(), '.safeharbor', 'local-agent');

const paths = {
  baseDir,
  config: path.join(baseDir, 'config.json'),
  captures: path.join(baseDir, 'captures'),
  logs: path.join(baseDir, 'logs'),
  database: path.join(baseDir, 'safeharbor.sqlite')
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function loadConfig() {
  ensureDir(paths.baseDir);
  ensureDir(paths.captures);
  ensureDir(paths.logs);

  const existing = readJson(paths.config, null);
  if (existing && existing.token) {
    const next = {
      port: Number(process.env.PORT || existing.port || DEFAULT_PORT),
      capturesDir: path.resolve(existing.capturesDir || paths.captures),
      token: existing.token
    };
    validateConfig(next);
    return next;
  }

  const created = {
    port: Number(process.env.PORT || DEFAULT_PORT),
    capturesDir: paths.captures,
    token: crypto.randomBytes(32).toString('hex')
  };
  validateConfig(created);
  writeJson(paths.config, created);
  return created;
}

function validateConfig(value) {
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error(`Invalid port in config: ${value.port}`);
  }
  if (typeof value.token !== 'string' || value.token.length < 32) {
    throw new Error('Invalid local auth token in config.');
  }
  if (typeof value.capturesDir !== 'string' || !value.capturesDir.trim()) {
    throw new Error('Invalid captures directory in config.');
  }
}

const config = loadConfig();
ensureDir(config.capturesDir);

if (args.has('--show-token')) {
  process.stdout.write(config.token + '\n');
  process.exit(0);
}

const store = new EventStore(paths.database);
store.seed({
  profile: defaultProfile(),
  device: defaultDevice(),
  policy: defaultPolicy()
});

if (args.has('--print-config')) {
  process.stdout.write(JSON.stringify(configBody(), null, 2) + '\n');
  process.exit(0);
}

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
  return {
    app: APP_NAME,
    version: VERSION,
    host: HOST,
    port: config.port,
    configFile: paths.config,
    capturesDir: config.capturesDir,
    databaseFile: paths.database,
    logsDir: paths.logs
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

function sendJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    ...extraHeaders
  });
  res.end(JSON.stringify(body, null, 2) + '\n');
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(html);
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, error: 'missing_or_invalid_token' });
}

function isAuthorized(req) {
  const value = req.headers.authorization || '';
  const prefix = 'Bearer ';
  if (!value.startsWith(prefix)) return false;
  const received = Buffer.from(value.slice(prefix.length));
  const expected = Buffer.from(config.token);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request_body_too_large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid_json'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
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
  const [profile] = store.getProfiles();
  const device = store.getDevices().find(item => item.profileId === profile.id) || store.getDevices()[0];
  const policy = store.getPolicy(profile.id);
  return { profile, device, policy };
}

function statusBody() {
  const reports = store.reports();
  return {
    ok: true,
    ...configBody(),
    profiles: store.getProfiles(),
    devices: store.getDevices(),
    policy: getDefaultContext().policy,
    reports,
    recentActivity: store.recentEvents(MAX_RECENT_ACTIVITY)
  };
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
  <p>Server is running on <code>${HOST}:${body.port}</code>.</p>
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

function escapeHtml(value) {
  return asString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function requireAuthorized(req, res) {
  if (isAuthorized(req)) return true;
  unauthorized(res);
  return false;
}

async function handleCapture(req, res, fallbackType) {
  if (!requireAuthorized(req, res)) return;

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

async function handleEvaluate(req, res) {
  if (!requireAuthorized(req, res)) return;

  const body = await readBody(req);
  const { profile, device, policy } = getDefaultContext();
  const profileId = asString(body.profileId, profile.id);
  const deviceId = asString(body.deviceId, device.id);
  const activePolicy = store.getPolicy(profileId) || policy;
  const decision = evaluatePolicy({
    url: asString(body.url),
    timestamp: asString(body.timestamp, nowIso()),
    profileId,
    deviceId,
    policy: activePolicy
  });

  store.recordEvent({
    type: 'visit_decision',
    timestamp: decision.timestamp,
    url: asString(body.url),
    domain: decision.domain,
    title: asString(body.title),
    profileId,
    deviceId,
    decision: decision.action,
    ruleId: decision.ruleId,
    reason: decision.reason,
    category: decision.category,
    source: asString(body.source, 'chrome-extension'),
    metadata: { policyId: activePolicy.id }
  });
  store.touchDevice(deviceId, decision.timestamp);

  sendJson(res, 200, {
    ok: true,
    profileId,
    deviceId,
    policyId: activePolicy.id,
    decision
  });
}

async function handleAction(req, res) {
  if (!requireAuthorized(req, res)) return;

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
  if (!requireAuthorized(req, res)) return;

  const body = await readBody(req);
  const type = asString(body.type);
  if (!type) {
    sendJson(res, 400, { ok: false, error: 'event_type_required' });
    return;
  }

  const { profile, device } = getDefaultContext();
  const timestamp = asString(body.timestamp, nowIso());
  store.recordEvent({
    type,
    timestamp,
    url: asString(body.url),
    domain: asString(body.domain) || domainFromUrl(asString(body.url)),
    title: asString(body.title),
    profileId: asString(body.profileId, profile.id),
    deviceId: asString(body.deviceId, device.id),
    decision: asString(body.decision),
    ruleId: asString(body.ruleId),
    reason: asString(body.reason),
    category: asString(body.category),
    source: asString(body.source, 'local-agent'),
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
  });
  sendJson(res, 202, { ok: true, accepted: true });
}

async function handlePolicyUpdate(req, res) {
  if (!requireAuthorized(req, res)) return;

  const body = await readBody(req);
  const rawPolicy = body.policy && typeof body.policy === 'object' ? body.policy : body;
  const policy = normalizePolicy(rawPolicy);
  const validationError = validatePolicy(policy);
  if (validationError) {
    sendJson(res, 400, { ok: false, error: validationError });
    return;
  }
  store.upsertPolicy(policy);
  sendJson(res, 200, { ok: true, policy });
}

function validatePolicy(policy) {
  if (!['allow', 'block'].includes(policy.defaultAction)) return 'invalid_default_action';
  if (!policy.id) return 'policy_id_required';
  if (!policy.profileId) return 'policy_profile_id_required';
  const listNames = ['blockedDomains', 'allowedDomains', 'temporaryOverrides'];
  for (const listName of listNames) {
    for (const rule of policy[listName]) {
      if (!rule.value && !rule.domain) return `${listName}_rule_domain_required`;
    }
  }
  for (const rule of policy.schedules) {
    if (!['allow', 'block'].includes(rule.action)) return 'schedule_action_invalid';
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(asString(rule.start))) return 'schedule_start_invalid';
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(asString(rule.end))) return 'schedule_end_invalid';
  }
  return '';
}

async function handleTokenRotate(req, res) {
  if (!requireAuthorized(req, res)) return;

  config.token = crypto.randomBytes(32).toString('hex');
  writeJson(paths.config, config);
  logEvent('info', 'token_rotated');
  sendJson(res, 200, { ok: true, token: config.token });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${HOST}:${config.port}`);

    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        app: APP_NAME,
        version: VERSION,
        host: HOST,
        port: config.port,
        database: Boolean(store)
      });
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/status') {
      if (!requireAuthorized(req, res)) return;
      const body = statusBody();
      if ((req.headers.accept || '').includes('text/html')) {
        sendHtml(res, 200, statusHtml(body));
      } else {
        sendJson(res, 200, body);
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/policy') {
      if (!requireAuthorized(req, res)) return;
      sendJson(res, 200, {
        ok: true,
        profiles: store.getProfiles(),
        devices: store.getDevices(),
        policy: getDefaultContext().policy
      });
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/policy') {
      await handlePolicyUpdate(req, res);
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/policy/evaluate') {
      await handleEvaluate(req, res);
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/reports/local') {
      if (!requireAuthorized(req, res)) return;
      sendJson(res, 200, { ok: true, reports: store.reports(), recentActivity: store.recentEvents(MAX_RECENT_ACTIVITY) });
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
    process.stderr.write(`${APP_NAME} could not start because ${HOST}:${config.port} is already in use.\n`);
    process.stderr.write(`Start with another port, for example: PORT=${config.port + 1} npm start\n`);
    store.close();
    process.exit(1);
    return;
  }
  store.close();
  throw error;
});

server.listen(config.port, HOST, () => {
  store.recordEvent({
    type: 'agent_started',
    timestamp: nowIso(),
    source: 'local-agent',
    metadata: { host: HOST, port: config.port, version: VERSION }
  });
  logEvent('info', 'server_started', { host: HOST, port: config.port });
  process.stdout.write(`${APP_NAME} listening at http://${HOST}:${config.port}\n`);
  process.stdout.write(`Config: ${paths.config}\n`);
  process.stdout.write(`SQLite: ${paths.database}\n`);
  process.stdout.write('Run `npm run token` to print the extension token.\n');
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function shutdown(signal) {
  logEvent('info', 'server_stopping', { signal });
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
