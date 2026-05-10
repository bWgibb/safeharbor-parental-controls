'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
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
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
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

async function getJson(url, token) {
  const response = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
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
