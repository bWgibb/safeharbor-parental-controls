#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    throw new Error('Install Playwright to run browser smoke tests: npm install --save-dev playwright');
  }

  const root = path.join(__dirname, '..');
  const extensionDir = path.join(root, 'extension');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'safeharbor-browser-smoke-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'safeharbor-chrome-profile-'));
  const port = String(50180 + Math.floor(Math.random() * 1000));
  const server = spawn(process.execPath, ['server/safeharbor-server.js'], {
    cwd: root,
    env: { ...process.env, SAFEHARBOR_HOME: home, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let browser = null;
  try {
    await waitForOutput(server, 'listening');
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    browser = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`
      ]
    });
    const extensionId = await waitForExtensionId(browser);
    const options = await browser.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.fill('#serverUrl', `http://127.0.0.1:${port}`);
    await options.fill('#token', config.parentToken || config.token);
    await options.click('#save');

    const page = await browser.newPage();
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(url => String(url).includes('block.html'), { timeout: 10000 });
    await page.waitForSelector('text=Blocked by SafeHarbor', { timeout: 10000 });
    process.stdout.write('Browser smoke passed: example.com was blocked by the extension.\n');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await waitForExit(server);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function waitForExtensionId(context) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
  const match = worker.url().match(/^chrome-extension:\/\/([^/]+)\//);
  if (!match) throw new Error(`Could not resolve extension ID from ${worker.url()}`);
  return match[1];
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 8000);
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

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
