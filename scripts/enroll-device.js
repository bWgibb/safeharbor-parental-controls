#!/usr/bin/env node
'use strict';

const os = require('os');
const { createPaths, loadConfig, resolveBaseDir, writeJson } = require('../server/lib/config');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hubUrl = stringOption(options.hub || options.url || process.env.SAFEHARBOR_HUB_URL).replace(/\/+$/, '');
  const code = stringOption(options.code).replace(/\D/g, '');
  if (!hubUrl || !/^\d{6}$/.test(code)) {
    usage();
    process.exit(1);
  }

  validateHubUrl(hubUrl);
  const deviceId = stringOption(options.deviceId || process.env.SAFEHARBOR_DEVICE_ID || `device-${slug(os.hostname())}`);
  const name = stringOption(options.name || os.hostname() || 'Child Device');
  const platform = stringOption(options.platform || process.platform);

  const response = await fetch(`${hubUrl}/devices/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceId, name, platform })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Hub returned ${response.status}`);
  }

  const paths = createPaths(resolveBaseDir());
  const config = loadConfig(paths);
  config.hubUrl = hubUrl;
  config.hubToken = body.deviceToken;
  config.deviceId = body.device.id;
  config.profileId = body.profileId || body.device.profileId || '';
  config.enrolledDevice = {
    id: body.device.id,
    name: body.device.name || name,
    platform: body.device.platform || platform,
    profileId: body.device.profileId || body.profileId || '',
    createdAt: body.device.createdAt || new Date().toISOString()
  };
  config.hubLastEventId = 0;
  config.hubLastSyncAt = null;
  config.hubLastSyncError = null;
  writeJson(paths.config, config);

  process.stdout.write(`Enrolled ${config.enrolledDevice.name} as ${config.deviceId}.\n`);
  process.stdout.write(`Saved hub sync config to ${paths.config}.\n`);
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    values[key] = args[index + 1] || '';
    index += 1;
  }
  return values;
}

function validateHubUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Hub URL must be a valid http:// or https:// URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Hub URL must start with http:// or https://.');
  }
}

function stringOption(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function slug(value) {
  return String(value || 'child')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'child';
}

function usage() {
  process.stderr.write([
    'Usage:',
    '  npm run enroll-device -- --hub http://homeautomation.local:43718 --code 123456 [--name "Child Laptop"] [--deviceId child-laptop-1]',
    ''
  ].join('\n'));
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
