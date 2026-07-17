'use strict';

import test from 'node:test';
import assert from 'node:assert';
import {
  classifyGlucose, severityToAlarms, isRapidChange, rapidChangeDirection, isStale,
  minutesSinceReading,
} from '../lib/dexcom/glucoseAlarms';

const thresholds = { urgentLowMgDl: 55, lowMgDl: 70, highMgDl: 180 };

test('classifyGlucose: boundary values are inclusive on the low/urgent-low side', () => {
  assert.equal(classifyGlucose(55, thresholds), 'urgent_low');
  assert.equal(classifyGlucose(54, thresholds), 'urgent_low');
  assert.equal(classifyGlucose(56, thresholds), 'low');
  assert.equal(classifyGlucose(70, thresholds), 'low');
  assert.equal(classifyGlucose(71, thresholds), 'normal');
  assert.equal(classifyGlucose(179, thresholds), 'normal');
  assert.equal(classifyGlucose(180, thresholds), 'high');
  assert.equal(classifyGlucose(400, thresholds), 'high');
});

test('classifyGlucose: urgent-low takes precedence over low', () => {
  assert.equal(classifyGlucose(40, thresholds), 'urgent_low');
});

test('severityToAlarms: mutually exclusive, only one true at a time', () => {
  assert.deepEqual(severityToAlarms('urgent_low'), { urgentLow: true, low: false, high: false });
  assert.deepEqual(severityToAlarms('low'), { urgentLow: false, low: true, high: false });
  assert.deepEqual(severityToAlarms('high'), { urgentLow: false, low: false, high: true });
  assert.deepEqual(severityToAlarms('normal'), { urgentLow: false, low: false, high: false });
});

test('isRapidChange / rapidChangeDirection', () => {
  assert.equal(isRapidChange('DoubleUp'), true);
  assert.equal(isRapidChange('DoubleDown'), true);
  assert.equal(isRapidChange('SingleUp'), false);
  assert.equal(isRapidChange(null), false);
  assert.equal(rapidChangeDirection('DoubleUp'), 'rising');
  assert.equal(rapidChangeDirection('DoubleDown'), 'falling');
  assert.equal(rapidChangeDirection('Flat'), null);
});

test('isStale: null last reading is always stale', () => {
  assert.equal(isStale(null, Date.now(), 20), true);
});

test('isStale: exactly at the timeout boundary is not yet stale, just over is', () => {
  const now = 1_000_000_000_000;
  const timeoutMin = 20;
  const lastReadingAt = now - timeoutMin * 60_000;
  assert.equal(isStale(lastReadingAt, now, timeoutMin), false, 'exactly at boundary');
  assert.equal(isStale(lastReadingAt - 1, now, timeoutMin), true, 'one ms past boundary');
  assert.equal(isStale(lastReadingAt + 1, now, timeoutMin), false, 'one ms under boundary');
});

test('minutesSinceReading: null last reading has no age', () => {
  assert.equal(minutesSinceReading(null, Date.now()), null);
});

test('minutesSinceReading: rounds to the nearest minute and never goes negative', () => {
  const now = 1_000_000_000_000;
  assert.equal(minutesSinceReading(now, now), 0, 'exactly now');
  assert.equal(minutesSinceReading(now + 30_000, now), 0, 'reading time slightly ahead of now (clock skew)');
  assert.equal(minutesSinceReading(now - 29_000, now), 0, 'rounds down under 30s');
  assert.equal(minutesSinceReading(now - 30_000, now), 1, 'rounds up at 30s');
  assert.equal(minutesSinceReading(now - 5 * 60_000, now), 5, 'whole minutes');
  assert.equal(minutesSinceReading(now - 90 * 60_000, now), 90, 'over an hour stays in minutes, unlike the widget\'s fmtAgo display string');
});
