'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { resolvePairList, maskUsername, DUPLICATE_ACCOUNT_MESSAGE } from '../lib/pairing';

const alice = {
  username: 'alice', password: 'secret', region: 'us', accountId: 'aaaaaaaa-0000-0000-0000-000000000000',
};

test('offers a newly-authenticated US account, units and thresholds in mg/dL', () => {
  const result = resolvePairList([], alice);
  assert.deepEqual(result, {
    devices: [{
      name: 'alice',
      data: { id: alice.accountId },
      settings: {
        username: 'alice',
        password: 'secret',
        region: 'us',
        units: 'mgdl',
        urgentLowThreshold: 55,
        lowThreshold: 70,
        highThreshold: 180,
      },
    }],
  });
});

test('infers mmol/L units and converted thresholds for an "outside US" region candidate', () => {
  const bob = { ...alice, region: 'ous', accountId: 'bbbbbbbb-0000-0000-0000-000000000000' };
  const result = resolvePairList([], bob);
  if (!('devices' in result)) throw new Error('expected devices, got error');
  const { settings } = result.devices[0];
  assert.equal(settings.units, 'mmol');
  assert.equal(settings.urgentLowThreshold, 3.1);
  assert.equal(settings.lowThreshold, 3.9);
  assert.equal(settings.highThreshold, 10);
});

test('offers a new follower even when other accounts are already paired, independent of their units', () => {
  const result = resolvePairList(['bbbbbbbb-0000-0000-0000-000000000000'], alice);
  assert.ok('devices' in result);
});

test('refuses re-pairing the same Dexcom Share account twice', () => {
  const result = resolvePairList([alice.accountId], alice);
  assert.deepEqual(result, { error: DUPLICATE_ACCOUNT_MESSAGE });
});

test('maskUsername keeps only the first two characters, whatever the login format', () => {
  // driver.ts logs every pairing step; the username is a real Dexcom login (often an email or
  // phone number), so enough must survive to tell two attempts apart and no more.
  assert.equal(maskUsername('john@example.com'), 'jo**************');
  assert.equal(maskUsername('+61400123456'), '+6**********');
  assert.equal(maskUsername('alice'), 'al***');
});

test('maskUsername reveals nothing at all for a username too short to mask partially', () => {
  // At <=2 characters the "first two" would be the whole string, so it's masked outright.
  assert.equal(maskUsername('ab'), '**');
  assert.equal(maskUsername('a'), '*');
  assert.equal(maskUsername(''), '');
});

test('maskUsername never lengthens or shortens the value it masks', () => {
  for (const username of ['', 'a', 'ab', 'abc', 'john@example.com']) {
    assert.equal(maskUsername(username).length, username.length);
  }
});
