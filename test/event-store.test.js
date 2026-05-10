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
  const inserted = store.recordEvent({
    eventKey: 'local-device:duplicate-test',
    type: 'visit_decision',
    timestamp: '2026-05-10T12:02:00.000Z',
    url: 'https://games.example.org/',
    domain: 'games.example.org',
    profileId: 'default-child',
    deviceId: 'local-device',
    decision: 'block',
    ruleId: 'games',
    reason: 'Games are blocked',
    category: 'games',
    source: 'test'
  });
  const duplicate = store.recordEvent({
    eventKey: 'local-device:duplicate-test',
    type: 'visit_decision',
    timestamp: '2026-05-10T12:02:00.000Z',
    url: 'https://games.example.org/',
    domain: 'games.example.org',
    profileId: 'default-child',
    deviceId: 'local-device',
    decision: 'block',
    ruleId: 'games',
    reason: 'Games are blocked',
    category: 'games',
    source: 'test'
  });
  assert.equal(inserted.inserted, true);
  assert.equal(duplicate.inserted, false);

  const reports = store.reports();
  assert.equal(reports.counts.totalEvents, 2);
  assert.equal(reports.counts.blockedVisits, 2);
  assert.equal(reports.topDomains[0].domain, 'example.com');
  assert.equal(reports.categoryCounts[0].category, 'demo');
  assert.equal(reports.deviceSummary[0].deviceId, 'local-device');
  assert.equal(reports.deviceSummary[0].blocked, 2);
  assert.equal(reports.profileSummary[0].profileId, 'default-child');
  const eventsToSync = store.eventsAfterId(0);
  assert.equal(eventsToSync.length, 2);
  assert.equal(eventsToSync[0].id, 1);
  assert.equal(eventsToSync[0].metadata.policyId, undefined);

  store.recordEvent({
    type: 'tamper_signal',
    timestamp: '2026-05-10T12:03:00.000Z',
    profileId: 'default-child',
    deviceId: 'local-device',
    reason: 'Extension disabled',
    source: 'test'
  });
  store.generateAlerts('2026-05-10T12:04:00.000Z');
  assert.ok(store.alerts().rows.some(alert => alert.type === 'tamper_signal'));

  const revoked = store.revokeDevice('local-device', 'Test revoke', '2026-05-10T12:05:00.000Z');
  assert.equal(revoked.status, 'revoked');

  store.close();
});

test('creates enrollment codes and registers devices', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeharbor-enroll-'));
  const store = new EventStore(path.join(dir, 'test.sqlite'));
  store.seed({
    profile: defaultProfile(),
    device: defaultDevice(),
    policy: defaultPolicy()
  });

  store.createEnrollmentCode({
    codeHash: 'hash-123',
    profileId: 'default-child',
    createdAt: '2026-05-10T12:00:00.000Z',
    expiresAt: '2026-05-10T12:15:00.000Z'
  });

  const enrollment = store.consumeEnrollmentCode(
    'hash-123',
    'device-test',
    '2026-05-10T12:01:00.000Z'
  );
  assert.equal(enrollment.profileId, 'default-child');

  store.upsertDevice({
    id: 'device-test',
    name: 'Test Device',
    platform: 'win32',
    profileId: enrollment.profileId,
    createdAt: '2026-05-10T12:01:00.000Z',
    lastSeenAt: '2026-05-10T12:01:00.000Z'
  });
  store.completeEnrollmentCode(enrollment.id, 'device-test');

  assert.equal(store.getDevice('device-test').name, 'Test Device');
  assert.equal(store.consumeEnrollmentCode('hash-123', 'other-device'), null);
  assert.equal(store.recentEnrollmentCodes()[0].usedByDeviceId, 'device-test');

  store.close();
});
