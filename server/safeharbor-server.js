#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const APP_NAME = 'SafeHarbor';
const VERSION = '0.1.0';
const DEFAULT_PORT = 43718;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_ACTIVITY = 50;

const args = new Set(process.argv.slice(2));
const baseDir = process.env.SAFEHARBOR_HOME
  ? path.resolve(process.env.SAFEHARBOR_HOME)
  : path.join(os.homedir(), '.safeharbor', 'local-agent');

const paths = {
  baseDir,
  config: path.join(baseDir, 'config.json'),
  captures: path.join(baseDir, 'captures'),
  logs: path.join(baseDir, 'logs'),
  activity: path.join(baseDir, 'activity.json')
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
    return {
      port: Number(process.env.PORT || existing.port || DEFAULT_PORT),
      capturesDir: path.resolve(existing.capturesDir || paths.captures),
      token: existing.token
    };
  }

  const created = {
    port: Number(process.env.PORT || DEFAULT_PORT),
    capturesDir: paths.captures,
    token: crypto.randomBytes(32).toString('hex')
  };
  writeJson(paths.config, created);
  return created;
}

const config = loadConfig();
ensureDir(config.capturesDir);

if (args.has('--show-token')) {
  process.stdout.write(config.token + '\n');
  process.exit(0);
}

if (args.has('--print-config')) {
  process.stdout.write(JSON.stringify({
    app: APP_NAME,
    version: VERSION,
    host: HOST,
    port: config.port,
    configFile: paths.config,
    capturesDir: config.capturesDir,
    logsDir: paths.logs
  }, null, 2) + '\n');
  process.exit(0);
}

function nowIso() {
  return new Date().toISOString();
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

function rememberActivity(activity) {
  const existing = readJson(paths.activity, []);
  const next = [{ timestamp: nowIso(), ...activity }, ...existing].slice(0, MAX_RECENT_ACTIVITY);
  writeJson(paths.activity, next);
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
    intent: asString(body.intent, 'save'),
    metadata: {
      client: metadata.client || null,
      project: metadata.project || null,
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter(tag => typeof tag === 'string') : []
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

function statusBody() {
  return {
    ok: true,
    app: APP_NAME,
    version: VERSION,
    host: HOST,
    port: config.port,
    configFile: paths.config,
    capturesDir: config.capturesDir,
    recentActivity: readJson(paths.activity, [])
  };
}

function statusHtml(body) {
  const rows = body.recentActivity.map(item => {
    const url = item.url ? `<a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a>` : '';
    return `<tr><td>${escapeHtml(item.timestamp)}</td><td>${escapeHtml(item.type || '')}</td><td>${escapeHtml(item.title || '')}</td><td>${url}</td><td>${escapeHtml(item.file || '')}</td></tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${APP_NAME}</title>
  <style>
    body { color: #17202a; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; }
    code { background: #eef2f6; border-radius: 4px; padding: 2px 5px; }
    table { border-collapse: collapse; margin-top: 20px; width: 100%; }
    th, td { border-bottom: 1px solid #d9e0e8; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f5f7fa; }
  </style>
</head>
<body>
  <h1>${APP_NAME}</h1>
  <p>Server is running on <code>${HOST}:${body.port}</code>.</p>
  <p>Captures directory: <code>${escapeHtml(body.capturesDir)}</code></p>
  <h2>Recent Activity</h2>
  <table>
    <thead><tr><th>Time</th><th>Type</th><th>Title</th><th>URL</th><th>File</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No captures yet.</td></tr>'}</tbody>
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

async function handleCapture(req, res, fallbackType) {
  if (!isAuthorized(req)) {
    unauthorized(res);
    return;
  }

  const body = await readBody(req);
  const payload = normalizePayload(body, fallbackType);
  const filePath = writeCapture(payload);

  rememberActivity({
    type: payload.type,
    intent: payload.intent,
    title: payload.tab.title,
    url: payload.tab.url,
    file: filePath
  });

  logEvent('info', 'capture_saved', {
    type: payload.type,
    url: payload.tab.url,
    file: filePath
  });

  sendJson(res, 200, { ok: true, file: filePath });
}

async function handleAction(req, res) {
  if (!isAuthorized(req)) {
    unauthorized(res);
    return;
  }

  const body = await readBody(req);
  rememberActivity({
    type: 'action',
    intent: asString(body.intent, 'unknown'),
    title: asString(body.title),
    url: asString(body.url)
  });
  logEvent('info', 'action_received', { intent: asString(body.intent, 'unknown') });
  sendJson(res, 202, { ok: true, accepted: true });
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
        port: config.port
      });
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/status') {
      if (!isAuthorized(req)) {
        unauthorized(res);
        return;
      }
      const body = statusBody();
      if ((req.headers.accept || '').includes('text/html')) {
        sendHtml(res, 200, statusHtml(body));
      } else {
        sendJson(res, 200, body);
      }
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

server.listen(config.port, HOST, () => {
  logEvent('info', 'server_started', { host: HOST, port: config.port });
  process.stdout.write(`${APP_NAME} listening at http://${HOST}:${config.port}\n`);
  process.stdout.write(`Config: ${paths.config}\n`);
  process.stdout.write('Run `npm run token` to print the extension token.\n');
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function shutdown(signal) {
  logEvent('info', 'server_stopping', { signal });
  server.close(() => process.exit(0));
}
