#!/usr/bin/env node
'use strict';

const DEFAULT_URL = 'http://127.0.0.1:43718';

const serverUrl = String(process.env.SAFEHARBOR_SERVER_URL || DEFAULT_URL).replace(/\/+$/, '');
const token = process.env.SAFEHARBOR_TOKEN || process.env.SAFEHARBOR_HUB_TOKEN || '';

if (!token) {
  process.stderr.write('Set SAFEHARBOR_TOKEN to the hub/server bearer token.\n');
  process.exit(1);
}

const now = Date.now();
const devices = [
  { id: 'sim-laptop-1', name: 'Avery Laptop', platform: 'win32', profileId: 'default-child' },
  { id: 'sim-laptop-2', name: 'Riley Laptop', platform: 'darwin', profileId: 'default-child' },
  { id: 'sim-tablet-1', name: 'Kitchen Tablet', platform: 'linux', profileId: 'default-child' }
];

const domains = [
  ['https://school.example.org/math', 'school.example.org', 'allow', '', 'education'],
  ['https://games.example.org/play', 'games.example.org', 'block', 'Games are blocked', 'games'],
  ['https://video.example.org/watch', 'video.example.org', 'allow', '', 'video'],
  ['https://chat.example.org/room', 'chat.example.org', 'block', 'Chat is blocked', 'social'],
  ['https://example.com/', 'example.com', 'block', 'Demo blocked domain', 'demo']
];

async function main() {
  const duplicate = process.argv.includes('--duplicate');
  for (const device of devices) {
    const events = buildEvents(device);
    const payload = {
      deviceId: device.id,
      profileId: device.profileId,
      device,
      events
    };
    const first = await postJson('/sync/events', payload);
    process.stdout.write(`${device.name}: accepted ${first.accepted}, duplicates ${first.duplicates || 0}\n`);
    if (duplicate) {
      const second = await postJson('/sync/events', payload);
      process.stdout.write(`${device.name} duplicate run: accepted ${second.accepted}, duplicates ${second.duplicates || 0}\n`);
    }
  }

  const tamper = await postJson('/events', {
    type: 'tamper_signal',
    timestamp: new Date(now - 10 * 60 * 1000).toISOString(),
    profileId: 'default-child',
    deviceId: devices[0].id,
    reason: 'Simulated extension disabled signal',
    source: 'simulator',
    metadata: { simulated: true }
  });
  process.stdout.write(`tamper event accepted: ${tamper.accepted || tamper.ok}\n`);
}

function buildEvents(device) {
  const events = [];
  for (let index = 0; index < 14; index += 1) {
    const [url, domain, decision, reason, category] = domains[(index + device.id.length) % domains.length];
    events.push({
      localEventId: `${device.id}-${index + 1}`,
      type: 'visit_decision',
      timestamp: new Date(now - (index + 1) * 5 * 60 * 1000).toISOString(),
      url,
      domain,
      decision,
      ruleId: decision === 'block' ? `sim-${category}` : '',
      reason,
      category,
      source: 'simulator',
      metadata: { simulated: true }
    });
  }
  return events;
}

async function postJson(path, payload) {
  const response = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Server returned ${response.status}`);
  }
  return body;
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
