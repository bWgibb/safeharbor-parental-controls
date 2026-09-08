'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const installerPath = path.join(__dirname, '..', 'scripts', 'install-windows.ps1');

test('Windows installer prepares and enrolls a fresh checkout before startup', () => {
  const installer = fs.readFileSync(installerPath, 'utf8');
  const applicationCopy = installer.indexOf('Copy-SafeHarborApplication');
  const dependencyInstall = installer.indexOf('& $Npm ci');
  const enrollment = installer.lastIndexOf('& $Node @EnrollArgs');
  const startupRegistration = installer.indexOf('Register-ScheduledTask');

  assert.match(installer, /\[switch\]\$InstallNode/);
  assert.match(installer, /\[switch\]\$ForceEnroll/);
  assert.match(installer, /OpenJS\.NodeJS\.LTS/);
  assert.match(installer, /\[string\]\$HubUrl/);
  assert.match(installer, /\[string\]\$PairingCode/);
  assert.match(installer, /LOCALAPPDATA.*SafeHarbor/);
  assert.ok(applicationCopy >= 0, 'installer must copy the application to its fixed location');
  assert.ok(dependencyInstall >= 0, 'installer must run npm ci');
  assert.ok(enrollment > dependencyInstall, 'installer must enroll after dependencies are installed');
  assert.ok(startupRegistration > enrollment, 'installer must register startup after enrollment');
});

test('Windows installer verifies sync and safely replaces prior startup', () => {
  const installer = fs.readFileSync(installerPath, 'utf8');

  assert.match(installer, /function Stop-SafeHarbor/);
  assert.match(installer, /Get-NetTCPConnection/);
  assert.match(installer, /Wait-ForSafeHarborStatus/);
  assert.match(installer, /Wait-ForHubSync/);
  assert.match(installer, /hubLastSyncAt/);
  assert.match(installer, /Unregister-ScheduledTask/);
  assert.match(installer, /Application files remain/);
});
