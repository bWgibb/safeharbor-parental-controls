#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const extensionDir = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.service_worker, 'background.js');
for (const permission of ['storage', 'tabs', 'webNavigation', 'scripting', 'declarativeNetRequest']) {
  assert.ok(manifest.permissions.includes(permission), `missing permission: ${permission}`);
}
for (const file of [
  'background.js',
  'block.html',
  'block.js',
  'dashboard.html',
  'dashboard.js',
  'policy-cache.js',
  'options.html',
  'options.js',
  'popup.html',
  'popup.js'
]) {
  assert.ok(fs.existsSync(path.join(extensionDir, file)), `missing extension file: ${file}`);
}

const background = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
assert.match(background, /webNavigation\.onBeforeNavigate/);
assert.match(background, /declarativeNetRequest/);
assert.match(background, /\/policy\/evaluate/);
assert.match(background, /block\.html/);

process.stdout.write('Extension manifest and enforcement wiring look valid.\n');
