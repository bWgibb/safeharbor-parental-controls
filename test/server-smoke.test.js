'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('server starts, evaluates policy, and reports SQLite activity', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'safeharbor-server-'));
  const port = String(45180 + Math.floor(Math.random() * 1000));
  const child = spawn(process.execPath, ['server/safeharbor-server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SAFEHARBOR_HOME: home, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForOutput(child, 'listening');
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = await getJson(`${baseUrl}/health`);
    assert.equal(health.ok, true);
    assert.equal(health.host, '127.0.0.1');

    const dashboardHtml = await getText(`${baseUrl}/dashboard`);
    assert.match(dashboardHtml, /SafeHarbor Dashboard/);

    const evaluated = await postJson(`${baseUrl}/policy/evaluate`, config.token, {
      url: 'https://example.com/',
      timestamp: '2026-05-10T12:00:00.000Z',
      source: 'test'
    });
    assert.equal(evaluated.decision.action, 'block');
    assert.equal(evaluated.decision.ruleId, 'block-example');

    const status = await getJson(`${baseUrl}/status`, config.token);
    assert.equal(status.ok, true);
    assert.equal(status.reports.counts.blockedVisits, 1);
    assert.ok(status.databaseFile.endsWith('safeharbor.sqlite'));

    const enrollmentCode = await postJson(`${baseUrl}/enrollment/code`, config.token, {
      profileId: 'default-child'
    });
    assert.match(enrollmentCode.code, /^\d{6}$/);

    const enrolled = await postJsonWithoutToken(`${baseUrl}/devices/enroll`, {
      code: enrollmentCode.code,
      deviceId: 'windows-test-device',
      name: 'Windows Test Device',
      platform: 'win32'
    });
    assert.equal(enrolled.device.id, 'windows-test-device');
    assert.equal(enrolled.device.profileId, 'default-child');
    assert.match(enrolled.deviceToken, /^[a-f0-9]{64}$/);
    assert.notEqual(enrolled.deviceToken, config.deviceToken);

    const syncPolicy = await getJson(`${baseUrl}/sync/policy?deviceId=windows-test-device`, enrolled.deviceToken);
    assert.equal(syncPolicy.device.id, 'windows-test-device');
    assert.equal(syncPolicy.policy.id, 'default-policy');

    const spoofedPolicy = await fetch(`${baseUrl}/sync/policy?deviceId=spoofed-device`, {
      headers: { authorization: `Bearer ${enrolled.deviceToken}` }
    });
    assert.equal(spoofedPolicy.status, 403);

    const heartbeat = await postJson(`${baseUrl}/devices/heartbeat`, enrolled.deviceToken, {
      deviceId: 'windows-test-device',
      version: '0.2.0',
      platform: 'win32'
    });
    assert.equal(heartbeat.device.status, 'online');

    const spoofedEvents = await fetch(`${baseUrl}/sync/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${enrolled.deviceToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        deviceId: 'spoofed-device',
        profileId: 'default-child',
        events: [{ localEventId: 'spoof-1', type: 'visit_decision', timestamp: '2026-05-10T12:09:00.000Z' }]
      })
    });
    assert.equal(spoofedEvents.status, 403);

    const synced = await postJson(`${baseUrl}/sync/events`, enrolled.deviceToken, {
      deviceId: 'windows-test-device',
      profileId: 'default-child',
      events: [
        {
          localEventId: 'visit-1',
          type: 'visit_decision',
          timestamp: '2026-05-10T12:10:00.000Z',
          url: 'https://school.example.org/',
          domain: 'school.example.org',
          decision: 'allow',
          source: 'child-agent'
        },
        {
          localEventId: 'visit-2',
          type: 'visit_decision',
          timestamp: '2026-05-10T12:11:00.000Z',
          url: 'https://games.example.org/',
          domain: 'games.example.org',
          decision: 'block',
          ruleId: 'games',
          reason: 'Games are blocked',
          category: 'games',
          source: 'child-agent'
        }
      ]
    });
    assert.equal(synced.accepted, 2);
    assert.equal(synced.duplicates, 0);
    assert.equal(synced.received, 2);
    assert.equal(synced.lastLocalEventId, 'visit-2');

    const duplicateSync = await postJson(`${baseUrl}/sync/events`, enrolled.deviceToken, {
      deviceId: 'windows-test-device',
      profileId: 'default-child',
      events: [
        {
          localEventId: 'visit-1',
          type: 'visit_decision',
          timestamp: '2026-05-10T12:10:00.000Z',
          url: 'https://school.example.org/',
          domain: 'school.example.org',
          decision: 'allow',
          source: 'child-agent'
        },
        {
          localEventId: 'visit-2',
          type: 'visit_decision',
          timestamp: '2026-05-10T12:11:00.000Z',
          url: 'https://games.example.org/',
          domain: 'games.example.org',
          decision: 'block',
          ruleId: 'games',
          reason: 'Games are blocked',
          category: 'games',
          source: 'child-agent'
        }
      ]
    });
    assert.equal(duplicateSync.accepted, 0);
    assert.equal(duplicateSync.duplicates, 2);
    assert.equal(duplicateSync.received, 2);

    const oversizedSync = await fetch(`${baseUrl}/sync/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${enrolled.deviceToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        deviceId: 'windows-test-device',
        profileId: 'default-child',
        events: Array.from({ length: 101 }, (_, index) => ({
          localEventId: `oversize-${index}`,
          type: 'visit_decision',
          timestamp: '2026-05-10T12:20:00.000Z'
        }))
      })
    });
    const oversizedBody = await oversizedSync.json();
    assert.equal(oversizedSync.status, 413);
    assert.equal(oversizedBody.error, 'sync_batch_too_large');

    const reports = await getJson(`${baseUrl}/reports/local`, config.token);
    const deviceSummary = reports.reports.deviceSummary.find(item => item.deviceId === 'windows-test-device');
    assert.equal(deviceSummary.total, 4);
    assert.equal(deviceSummary.allowed, 1);
    assert.equal(deviceSummary.blocked, 1);

    const exportedJson = await getJson(`${baseUrl}/reports/export.json?deviceId=windows-test-device`, config.token);
    assert.ok(exportedJson.events.length >= 4);

    const csv = await getText(`${baseUrl}/reports/export.csv?deviceId=windows-test-device`, config.token);
    assert.match(csv, /^id,timestamp,type,profileId,deviceId/);

    const backup = await getText(`${baseUrl}/backup/safeharbor.sqlite`, config.token);
    assert.ok(backup.length > 100);
    assert.equal(fs.readdirSync(home).some(file => file.startsWith('safeharbor-backup-')), false);

    const policyExport = await getJson(`${baseUrl}/policy/export.json`, config.token);
    assert.equal(policyExport.policy.id, 'default-policy');

    const invalidPolicy = await fetch(`${baseUrl}/policy/import`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ ...policyExport.policy, defaultAction: 'permit' })
    });
    const invalidPolicyBody = await invalidPolicy.json();
    assert.equal(invalidPolicy.status, 400);
    assert.equal(invalidPolicyBody.error, 'invalid_default_action');

    const deviceReports = await fetch(`${baseUrl}/reports/local`, {
      headers: { authorization: `Bearer ${config.deviceToken}` }
    });
    assert.equal(deviceReports.status, 401);

    const mutedPreferences = await postJson(`${baseUrl}/alerts/preferences`, config.token, {
      alertPreferences: { tamperSignal: false }
    });
    assert.equal(mutedPreferences.alertPreferences.tamperSignal, false);

    await postJson(`${baseUrl}/events`, config.token, {
      type: 'tamper_signal',
      timestamp: '2026-05-10T12:12:00.000Z',
      deviceId: 'windows-test-device',
      profileId: 'default-child',
      reason: 'Simulated extension disabled',
      source: 'test'
    });
    const mutedAlerts = await getJson(`${baseUrl}/alerts`, config.token);
    assert.equal(mutedAlerts.alerts.rows.some(alert => alert.type === 'tamper_signal'), false);

    await postJson(`${baseUrl}/alerts/preferences`, config.token, {
      alertPreferences: { tamperSignal: true }
    });
    await postJson(`${baseUrl}/events`, config.token, {
      type: 'tamper_signal',
      timestamp: '2026-05-10T12:13:00.000Z',
      deviceId: 'windows-test-device',
      profileId: 'default-child',
      reason: 'Simulated extension disabled again',
      source: 'test'
    });
    const alerts = await getJson(`${baseUrl}/alerts`, config.token);
    assert.ok(alerts.alerts.rows.some(alert => alert.type === 'tamper_signal'));
    const alertFiles = fs.readdirSync(path.join(home, 'alerts'));
    assert.ok(alertFiles.some(file => file.endsWith('.eml')));

    const revoked = await postJson(`${baseUrl}/devices/revoke`, config.token, {
      deviceId: 'windows-test-device',
      reason: 'Smoke test revoke'
    });
    assert.equal(revoked.device.status, 'revoked');

    const revokedPolicy = await fetch(`${baseUrl}/sync/policy?deviceId=windows-test-device`, {
      headers: { authorization: `Bearer ${enrolled.deviceToken}` }
    });
    assert.equal(revokedPolicy.status, 403);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
  }
});

test('child agent syncs local events to a hub process', async () => {
  const root = path.join(__dirname, '..');
  const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'safeharbor-hub-proc-'));
  const childHome = fs.mkdtempSync(path.join(os.tmpdir(), 'safeharbor-child-proc-'));
  const hubPort = String(47180 + Math.floor(Math.random() * 1000));
  const childPort = String(48180 + Math.floor(Math.random() * 1000));
  const hub = spawn(process.execPath, ['server/safeharbor-server.js'], {
    cwd: root,
    env: { ...process.env, SAFEHARBOR_HOME: hubHome, PORT: hubPort },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let child = null;
  try {
    await waitForOutput(hub, 'listening');
    const hubConfig = JSON.parse(fs.readFileSync(path.join(hubHome, 'config.json'), 'utf8'));
    const hubUrl = `http://127.0.0.1:${hubPort}`;
    const enrollmentCode = await postJson(`${hubUrl}/enrollment/code`, hubConfig.token, {
      profileId: 'default-child'
    });
    const enroll = spawnSync(process.execPath, [
      'scripts/enroll-device.js',
      '--hub',
      hubUrl,
      '--code',
      enrollmentCode.code,
      '--deviceId',
      'child-agent-1',
      '--name',
      'Child Agent 1',
      '--platform',
      'test'
    ], {
      cwd: root,
      env: { ...process.env, SAFEHARBOR_HOME: childHome },
      encoding: 'utf8'
    });
    assert.equal(enroll.status, 0, enroll.stderr || enroll.stdout);

    child = spawn(process.execPath, ['server/safeharbor-server.js'], {
      cwd: root,
      env: {
        ...process.env,
        SAFEHARBOR_HOME: childHome,
        PORT: childPort,
        SAFEHARBOR_HUB_SYNC_INTERVAL_MS: '5000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForOutput(child, 'listening');
    const childConfig = JSON.parse(fs.readFileSync(path.join(childHome, 'config.json'), 'utf8'));
    assert.equal(childConfig.deviceId, 'child-agent-1');
    assert.equal(childConfig.hubUrl, hubUrl);
    assert.match(childConfig.hubToken, /^[a-f0-9]{64}$/);
    const childUrl = `http://127.0.0.1:${childPort}`;
    await postJson(`${childUrl}/policy/evaluate`, childConfig.token, {
      url: 'https://example.com/',
      timestamp: '2026-05-10T13:00:00.000Z',
      source: 'test-child-agent'
    });
    await waitFor(async () => {
      const reports = await getJson(`${hubUrl}/reports/local?deviceId=child-agent-1`, hubConfig.token);
      return reports.reports.counts.blockedVisits >= 1;
    }, 10000);

    const hubReports = await getJson(`${hubUrl}/reports/local?deviceId=child-agent-1`, hubConfig.token);
    assert.equal(hubReports.reports.counts.blockedVisits, 1);
    const syncStatus = await getJson(`${hubUrl}/devices/sync-status`, hubConfig.token);
    assert.ok(syncStatus.devices.some(device => device.id === 'child-agent-1' && device.lastSyncAt));
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await waitForExit(child);
    }
    hub.kill('SIGTERM');
    await waitForExit(hub);
  }
});

test('server can bind to a LAN hub host', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'safeharbor-hub-'));
  const port = String(46180 + Math.floor(Math.random() * 1000));
  const child = spawn(process.execPath, ['server/safeharbor-server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SAFEHARBOR_HOME: home, SAFEHARBOR_HOST: '0.0.0.0', PORT: port },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForOutput(child, 'listening');
    const health = await getJson(`http://127.0.0.1:${port}/health`);
    assert.equal(health.ok, true);
    assert.equal(health.host, '0.0.0.0');
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
  }
});

test('child hub sync records timeout errors without blocking startup', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'safeharbor-hub-timeout-'));
  const port = String(49180 + Math.floor(Math.random() * 1000));
  const hungHub = http.createServer(() => {});
  await listen(hungHub);
  const hubUrl = `http://127.0.0.1:${hungHub.address().port}`;
  const child = spawn(process.execPath, ['server/safeharbor-server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SAFEHARBOR_HOME: home,
      PORT: port,
      SAFEHARBOR_HUB_URL: hubUrl,
      SAFEHARBOR_HUB_TOKEN: '0'.repeat(64),
      SAFEHARBOR_HUB_SYNC_TIMEOUT_MS: '1000',
      SAFEHARBOR_HUB_SYNC_INTERVAL_MS: '5000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForOutput(child, 'listening');
    await waitFor(() => {
      const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
      return /timed out/.test(config.hubLastSyncError || '');
    }, 5000);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await closeServer(hungHub);
  }
});

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 6000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes(pattern)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      if (text.includes('Error:')) {
        clearTimeout(timer);
        reject(new Error(text));
      }
    });
    child.on('exit', code => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Server exited with ${code}`));
      }
    });
  });
}

function waitForExit(child) {
  return new Promise(resolve => {
    child.on('exit', resolve);
    setTimeout(resolve, 1000);
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function waitFor(check, timeoutMs = 7000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw lastError || new Error('Timed out waiting for condition');
}

async function getJson(url, token) {
  const response = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
  return body;
}

async function getText(url, token) {
  const response = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const body = await response.text();
  assert.equal(response.ok, true, body);
  return body;
}

async function postJson(url, token, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
  return body;
}

async function postJsonWithoutToken(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
  return body;
}
