'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 43718;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ALERT_PREFERENCES = {
  repeatedBlock: true,
  scheduleViolation: true,
  tamperSignal: true,
  deviceOffline: true,
  deviceRevoked: true
};

function resolveBaseDir(env = process.env) {
  return env.SAFEHARBOR_HOME
    ? path.resolve(env.SAFEHARBOR_HOME)
    : path.join(os.homedir(), '.safeharbor', 'local-agent');
}

function createPaths(baseDir) {
  return {
    baseDir,
    config: path.join(baseDir, 'config.json'),
    captures: path.join(baseDir, 'captures'),
    logs: path.join(baseDir, 'logs'),
    alerts: path.join(baseDir, 'alerts'),
    database: path.join(baseDir, 'safeharbor.sqlite')
  };
}

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

function loadConfig(paths, env = process.env) {
  ensureDir(paths.baseDir);
  ensureDir(paths.captures);
  ensureDir(paths.logs);
  ensureDir(paths.alerts);

  const existing = readJson(paths.config, null);
  if (existing && existing.token) {
    let changed = false;
    if (!existing.parentToken) {
      existing.parentToken = existing.token;
      changed = true;
    }
    if (!existing.deviceToken) {
      existing.deviceToken = crypto.randomBytes(32).toString('hex');
      changed = true;
    }
    const next = {
      host: env.SAFEHARBOR_HOST || existing.host || DEFAULT_HOST,
      port: Number(env.PORT || existing.port || DEFAULT_PORT),
      capturesDir: path.resolve(existing.capturesDir || paths.captures),
      token: existing.parentToken,
      parentToken: existing.parentToken,
      deviceToken: existing.deviceToken,
      deviceId: stringOr(env.SAFEHARBOR_DEVICE_ID, existing.deviceId || ''),
      profileId: stringOr(existing.profileId, ''),
      enrolledDevice: normalizeEnrolledDevice(existing.enrolledDevice),
      hubUrl: stringOr(env.SAFEHARBOR_HUB_URL, existing.hubUrl || ''),
      hubToken: stringOr(env.SAFEHARBOR_HUB_TOKEN, existing.hubToken || ''),
      hubLastEventId: Number(existing.hubLastEventId || 0),
      hubLastSyncAt: existing.hubLastSyncAt || null,
      hubLastSyncError: existing.hubLastSyncError || null,
      alertPreferences: normalizeAlertPreferences(existing.alertPreferences)
    };
    validateConfig(next);
    if (changed) writeJson(paths.config, { ...existing, ...next });
    return next;
  }

  const parentToken = crypto.randomBytes(32).toString('hex');
  const created = {
    host: env.SAFEHARBOR_HOST || DEFAULT_HOST,
    port: Number(env.PORT || DEFAULT_PORT),
    capturesDir: paths.captures,
    token: parentToken,
    parentToken,
    deviceToken: crypto.randomBytes(32).toString('hex'),
    deviceId: stringOr(env.SAFEHARBOR_DEVICE_ID, ''),
    profileId: '',
    enrolledDevice: null,
    hubUrl: stringOr(env.SAFEHARBOR_HUB_URL, ''),
    hubToken: stringOr(env.SAFEHARBOR_HUB_TOKEN, ''),
    hubLastEventId: 0,
    hubLastSyncAt: null,
    hubLastSyncError: null,
    alertPreferences: { ...DEFAULT_ALERT_PREFERENCES }
  };
  validateConfig(created);
  writeJson(paths.config, created);
  return created;
}

function validateConfig(value) {
  if (typeof value.host !== 'string' || !value.host.trim()) {
    throw new Error('Invalid bind host in config.');
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error(`Invalid port in config: ${value.port}`);
  }
  if (typeof value.token !== 'string' || value.token.length < 32) {
    throw new Error('Invalid local parent auth token in config.');
  }
  if (typeof value.parentToken !== 'string' || value.parentToken.length < 32) {
    throw new Error('Invalid local parent auth token in config.');
  }
  if (typeof value.deviceToken !== 'string' || value.deviceToken.length < 32) {
    throw new Error('Invalid local device auth token in config.');
  }
  if (typeof value.capturesDir !== 'string' || !value.capturesDir.trim()) {
    throw new Error('Invalid captures directory in config.');
  }
  if (!Number.isFinite(value.hubLastEventId) || value.hubLastEventId < 0) {
    throw new Error('Invalid hub sync cursor in config.');
  }
  if (typeof value.deviceId !== 'string') {
    throw new Error('Invalid device ID in config.');
  }
  if (typeof value.profileId !== 'string') {
    throw new Error('Invalid profile ID in config.');
  }
  if (typeof value.hubUrl !== 'string') {
    throw new Error('Invalid hub URL in config.');
  }
  if (typeof value.hubToken !== 'string') {
    throw new Error('Invalid hub token in config.');
  }
}

function normalizeAlertPreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_ALERT_PREFERENCES)
      .map(([key, fallback]) => [key, source[key] == null ? fallback : Boolean(source[key])])
  );
}

function normalizeEnrolledDevice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    id: stringOr(value.id, ''),
    name: stringOr(value.name, ''),
    platform: stringOr(value.platform, ''),
    profileId: stringOr(value.profileId, ''),
    createdAt: stringOr(value.createdAt, '')
  };
}

function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

module.exports = {
  DEFAULT_ALERT_PREFERENCES,
  DEFAULT_HOST,
  DEFAULT_PORT,
  createPaths,
  ensureDir,
  loadConfig,
  readJson,
  resolveBaseDir,
  validateConfig,
  writeJson
};
