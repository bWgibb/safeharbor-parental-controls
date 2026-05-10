'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { defaultDevice, defaultPolicy, defaultProfile } = require('../server/lib/defaults');
const { EventStore } = require('../server/lib/event-store');

test('seeds local profile, device, policy, and reports events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeharbor-store-'));
  const store = new EventStore(path.join(dir, 'test.sqlite'));
  store.seed({
    profile: defaultProfile(),
    device: defaultDevice(),
    policy: defaultPolicy()
  });

  assert.equal(store.getProfiles()[0].id, 'default-child');
  assert.equal(store.getDevices()[0].id, 'local-device');
  assert.equal(store.getPolicy('default-child').id, 'default-policy');

  store.recordEvent({
    type: 'visit_decision',
    timestamp: '2026-05-10T12:00:00.000Z',
    url: 'https://example.com/',
    domain: 'example.com',
    profileId: 'default-child',
    deviceId: 'local-device',
    decision: 'block',
    ruleId: 'block-example',
    reason: 'Demo blocked domain',
    category: 'demo',
    source: 'test'
  });

  const reports = store.reports();
  assert.equal(reports.counts.totalEvents, 1);
  assert.equal(reports.counts.blockedVisits, 1);
  assert.equal(reports.topDomains[0].domain, 'example.com');
  assert.equal(reports.categoryCounts[0].category, 'demo');

  store.close();
});
