'use strict';

import test from 'node:test';
import assert from 'node:assert';
import {
  mgdlToMmol, mmolToMgdl, toDisplay, toMgdl, unitLabel, unitDecimals, defaultUnitsForRegion,
} from '../lib/dexcom/units';

test('mgdlToMmol matches dexcom-share-client GlucoseReading.mmolL rounding', () => {
  assert.equal(mgdlToMmol(100), 5.6);
  assert.equal(mgdlToMmol(70), 3.9);
  assert.equal(mgdlToMmol(180), 10);
});

test('mmolToMgdl round-trips close to the original mg/dL value', () => {
  assert.equal(mmolToMgdl(5.6), 101);
  assert.equal(mmolToMgdl(3.9), 70);
});

test('toDisplay rounds mg/dL to an integer and mmol/L to one decimal', () => {
  assert.equal(toDisplay(101.6, 'mgdl'), 102);
  assert.equal(toDisplay(70, 'mmol'), 3.9);
});

test('toMgdl converts a display-unit value back to canonical mg/dL', () => {
  assert.equal(toMgdl(70, 'mgdl'), 70);
  assert.equal(toMgdl(3.9, 'mmol'), 70);
});

test('unitLabel and unitDecimals', () => {
  assert.equal(unitLabel('mgdl'), 'mg/dL');
  assert.equal(unitLabel('mmol'), 'mmol/L');
  assert.equal(unitDecimals('mgdl'), 0);
  assert.equal(unitDecimals('mmol'), 1);
});

test('defaultUnitsForRegion: US and Japan default to mg/dL, everywhere else to mmol/L', () => {
  assert.equal(defaultUnitsForRegion('us'), 'mgdl');
  assert.equal(defaultUnitsForRegion('jp'), 'mgdl');
  assert.equal(defaultUnitsForRegion('ous'), 'mmol');
});
