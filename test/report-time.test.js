'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { endOfReginaDay, startOfReginaDay } = require('../server/lib/report-time');

test('report date filters use America Regina day boundaries', () => {
  assert.equal(startOfReginaDay('2026-05-10'), '2026-05-10T06:00:00.000Z');
  assert.equal(endOfReginaDay('2026-05-10'), '2026-05-11T05:59:59.999Z');
});
