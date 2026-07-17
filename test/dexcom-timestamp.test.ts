'use strict';

import test from 'node:test';
import assert from 'node:assert';
import parseCorrectedEpoch from '../lib/dexcom/timestamp';

test('parseCorrectedEpoch: ignores the offset suffix entirely, ticks alone are the UTC instant', () => {
  // Same numeric ticks, three different (irrelevant) offset suffixes - must all parse identically,
  // since the offset is only informational metadata per Dexcom's own Microsoft/.NET JSON date
  // convention, not a delta to apply (that's exactly the bug in dexcom-share-client's own parser).
  assert.equal(parseCorrectedEpoch('/Date(1700000000000+1000)/'), 1700000000000);
  assert.equal(parseCorrectedEpoch('/Date(1700000000000-0500)/'), 1700000000000);
  assert.equal(parseCorrectedEpoch('/Date(1700000000000)/'), 1700000000000);
});

test('parseCorrectedEpoch: invalid input returns null rather than throwing', () => {
  assert.equal(parseCorrectedEpoch('not a dexcom date'), null);
  assert.equal(parseCorrectedEpoch(''), null);
});
