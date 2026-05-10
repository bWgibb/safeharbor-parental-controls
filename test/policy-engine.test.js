'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluatePolicy } = require('../server/lib/policy-engine');
const { defaultPolicy } = require('../server/lib/defaults');

test('blocks exact domains and subdomains', () => {
  const policy = defaultPolicy();

  assert.equal(evaluatePolicy({ url: 'https://example.com/', policy }).action, 'block');
  assert.equal(evaluatePolicy({ url: 'https://kids.example.com/path', policy }).action, 'block');
});

test('allow list wins over blocked category', () => {
  const policy = {
    ...defaultPolicy(),
    allowedDomains: [{ id: 'allow-social', value: 'facebook.com', reason: 'Parent allowed' }],
    blockedCategories: ['social']
  };

  const result = evaluatePolicy({ url: 'https://facebook.com/home', policy });
  assert.equal(result.action, 'allow');
  assert.equal(result.ruleId, 'allow-social');
});

test('blocks configured categories', () => {
  const policy = {
    ...defaultPolicy(),
    blockedCategories: ['video']
  };

  const result = evaluatePolicy({ url: 'https://www.youtube.com/watch?v=test', policy });
  assert.equal(result.action, 'block');
  assert.equal(result.ruleId, 'category:video');
  assert.equal(result.category, 'video');
});

test('temporary overrides expire', () => {
  const policy = {
    ...defaultPolicy(),
    temporaryOverrides: [
      {
        id: 'expired-allow',
        action: 'allow',
        value: 'example.com',
        expiresAt: '2026-01-01T00:00:00.000Z'
      }
    ]
  };

  const result = evaluatePolicy({
    url: 'https://example.com/',
    timestamp: '2026-01-02T00:00:00.000Z',
    policy
  });
  assert.equal(result.action, 'block');
  assert.equal(result.ruleId, 'block-example');
});

test('schedule rules apply without network access', () => {
  const policy = {
    ...defaultPolicy(),
    blockedDomains: [],
    schedules: [
      {
        id: 'homework',
        action: 'block',
        start: '10:00',
        end: '12:00',
        reason: 'Homework focus'
      }
    ]
  };

  const result = evaluatePolicy({
    url: 'https://news.ycombinator.com/',
    timestamp: '2026-05-10T10:30:00',
    policy
  });
  assert.equal(result.action, 'block');
  assert.equal(result.ruleId, 'homework');
});

test('default action is used when no rule matches', () => {
  const policy = {
    ...defaultPolicy(),
    blockedDomains: [],
    defaultAction: 'allow'
  };

  const result = evaluatePolicy({ url: 'https://openai.com/', policy });
  assert.equal(result.action, 'allow');
  assert.equal(result.ruleId, 'default-policy');
});
