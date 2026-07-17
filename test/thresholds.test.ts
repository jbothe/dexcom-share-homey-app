'use strict';

import test from 'node:test';
import assert from 'node:assert';
import {
  resolveThresholdsOnSave, THRESHOLD_ORDER_MESSAGE,
} from '../lib/dexcom/thresholds';

/** Defaults as driver.settings.compose.json ships them, in mg/dL. */
const MGDL_SETTINGS = {
  units: 'mgdl', urgentLowThreshold: 55, lowThreshold: 70, highThreshold: 180,
};

/** The same three thresholds as resolvePairList would offer an "outside US" (mmol/L) account. */
const MMOL_SETTINGS = {
  units: 'mmol', urgentLowThreshold: 3.1, lowThreshold: 3.9, highThreshold: 10,
};

function resolve(oldSettings: Record<string, unknown>, newSettings: Record<string, unknown>, changedKeys: string[]) {
  const result = resolveThresholdsOnSave({ oldSettings, newSettings, changedKeys });
  assert.ok(!('error' in result), `expected a resolved result, got error: ${(result as { error?: string }).error}`);
  return result as Exclude<typeof result, { error: string }>;
}

test('a save that changes nothing passes the thresholds through untouched', () => {
  const result = resolve(MGDL_SETTINGS, MGDL_SETTINGS, []);
  assert.equal(result.unitsChanged, false);
  assert.deepEqual(result.thresholds, {
    urgentLowThreshold: 55, lowThreshold: 70, highThreshold: 180,
  });
});

test('thresholds the user did not touch are converted when units change mg/dL -> mmol/L', () => {
  const result = resolve(MGDL_SETTINGS, { ...MGDL_SETTINGS, units: 'mmol' }, ['units']);
  assert.equal(result.unitsChanged, true);
  assert.equal(result.units, 'mmol');
  // Homey hands back newSettings holding the raw, still-mg/dL numbers for every untouched field -
  // left alone, a "180" would be read as 180 mmol/L (~3244 mg/dL) rather than 10.0 mmol/L.
  assert.deepEqual(result.thresholds, {
    urgentLowThreshold: 3.1, lowThreshold: 3.9, highThreshold: 10,
  });
});

test('thresholds the user did not touch are converted when units change mmol/L -> mg/dL', () => {
  const result = resolve(MMOL_SETTINGS, { ...MMOL_SETTINGS, units: 'mgdl' }, ['units']);
  assert.equal(result.unitsChanged, true);
  assert.deepEqual(result.thresholds, {
    // 3.1 mmol/L round-trips to 56, not the 55 it was converted from - mgdlToMmol's own one-decimal
    // rounding isn't loss-free in both directions. Cosmetic, and only visible to a user who
    // switches units twice; the alternative (remembering the pre-conversion mg/dL) would mean
    // storing a shadow copy of every threshold purely to undo a rounding step.
    urgentLowThreshold: 56, lowThreshold: 70, highThreshold: 180,
  });
});

test('a threshold edited in the same save as a units change is trusted as already being in the new unit', () => {
  // The user switched to mmol/L and typed 4.5 into Low on that same form: 4.5 is already mmol/L
  // and must not be converted again (a second pass would read it as 4.5 mg/dL -> 0.2 mmol/L).
  const result = resolve(
    MGDL_SETTINGS,
    { ...MGDL_SETTINGS, units: 'mmol', lowThreshold: 4.5 },
    ['units', 'lowThreshold'],
  );
  assert.deepEqual(result.thresholds, {
    urgentLowThreshold: 3.1, // untouched -> converted from 55 mg/dL
    lowThreshold: 4.5, // edited on the mmol/L form -> taken verbatim
    highThreshold: 10, // untouched -> converted from 180 mg/dL
  });
});

test('editing thresholds without touching units takes every value verbatim', () => {
  const result = resolve(
    MGDL_SETTINGS,
    { ...MGDL_SETTINGS, highThreshold: 200 },
    ['highThreshold'],
  );
  assert.equal(result.unitsChanged, false);
  assert.equal(result.thresholds.highThreshold, 200);
  assert.equal(result.thresholds.lowThreshold, 70, 'an untouched threshold is not converted when units did not change');
});

test('rejects thresholds saved out of order', () => {
  const result = resolveThresholdsOnSave({
    oldSettings: MGDL_SETTINGS,
    newSettings: { ...MGDL_SETTINGS, lowThreshold: 200 }, // above High
    changedKeys: ['lowThreshold'],
  });
  assert.deepEqual(result, { error: THRESHOLD_ORDER_MESSAGE });
});

test('rejects two thresholds saved equal to each other', () => {
  // Equal bounds would make classifyGlucose's bands ambiguous and collapse a widget zone to
  // zero height - the ordering is strict, not merely non-decreasing.
  const result = resolveThresholdsOnSave({
    oldSettings: MGDL_SETTINGS,
    newSettings: { ...MGDL_SETTINGS, urgentLowThreshold: 70 },
    changedKeys: ['urgentLowThreshold'],
  });
  assert.deepEqual(result, { error: THRESHOLD_ORDER_MESSAGE });
});

test('ordering is judged in canonical mg/dL, so correctly-ordered mmol/L values are accepted', () => {
  // The bare numbers 3.1/3.9/10 are only meaningful once read as mmol/L - a validator comparing
  // them against mg/dL-scale expectations would be judging the wrong quantity entirely.
  const result = resolve(MMOL_SETTINGS, MMOL_SETTINGS, []);
  assert.deepEqual(result.thresholds, {
    urgentLowThreshold: 3.1, lowThreshold: 3.9, highThreshold: 10,
  });
});

test('rejects out-of-order mmol/L thresholds that would look ordered as raw mg/dL numbers', () => {
  const result = resolveThresholdsOnSave({
    oldSettings: MMOL_SETTINGS,
    newSettings: { ...MMOL_SETTINGS, urgentLowThreshold: 9 }, // 9 mmol/L sits above Low (3.9)
    changedKeys: ['urgentLowThreshold'],
  });
  assert.deepEqual(result, { error: THRESHOLD_ORDER_MESSAGE });
});

test('a units change that would put converted thresholds out of order is still rejected', () => {
  // Guards the conversion path itself, not just verbatim input: the error must be reachable from
  // values that were only invalid *after* being converted.
  const result = resolveThresholdsOnSave({
    oldSettings: { ...MGDL_SETTINGS, urgentLowThreshold: 55 },
    newSettings: { ...MGDL_SETTINGS, units: 'mmol', lowThreshold: 2 }, // 2 mmol/L is below 3.1
    changedKeys: ['units', 'lowThreshold'],
  });
  assert.deepEqual(result, { error: THRESHOLD_ORDER_MESSAGE });
});
