'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileDynamicRules, evaluateCachedPolicy } = require('../extension/policy-cache');
const { defaultPolicy } = require('../server/lib/defaults');

test('cached policy blocks known domains without server access', () => {
  const decision = evaluateCachedPolicy({
    url: 'https://kids.example.com/path',
    timestamp: '2026-05-10T12:00:00.000Z',
    policy: defaultPolicy()
  });

  assert.equal(decision.action, 'block');
  assert.equal(decision.ruleId, 'block-example');
});

test('dynamic rules include allow and redirect block rules', () => {
  const rules = compileDynamicRules({
    ...defaultPolicy(),
    blockedCategories: ['games']
  }, new Date('2026-05-10T12:00:00.000Z'));

  assert.ok(rules.some(rule => rule.action.type === 'allow' && rule.condition.requestDomains.includes('wikipedia.org')));
  assert.ok(rules.some(rule => rule.action.type === 'redirect' && rule.condition.requestDomains.includes('example.com')));
  assert.ok(rules.some(rule => rule.action.type === 'redirect' && rule.condition.requestDomains.includes('roblox.com')));
});
