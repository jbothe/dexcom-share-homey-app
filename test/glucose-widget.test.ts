'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load the widget's actual presentation logic by extracting the marked block from
 * index.html and evaluating it - tests the exact code the widget runs (the logic is
 * inlined so the widget stays self-contained on Homey), same pattern as
 * test/powerflow.test.ts in the sibling chargeiq app.
 */
function loadGD(): Record<string, (...args: unknown[]) => unknown> {
  const html = readFileSync(
    join(__dirname, '../../widgets/glucose-dashboard/public/index.html'), 'utf8',
  );
  const m = html.match(/GLUCOSE-LOGIC-START[\s\S]*?===\s*([\s\S]*?)\/\/ === GLUCOSE-LOGIC-END/);
  if (!m) throw new Error('Glucose widget logic block not found in index.html');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn GD;`)();
}

const GD = loadGD();

test('fmtValue: mg/dL rounds to an integer, mmol/L keeps one decimal', () => {
  assert.equal(GD.fmtValue(101.6, 'mgdl'), '102');
  assert.equal(GD.fmtValue(70, 'mmol'), '3.9');
  assert.equal(GD.fmtValue(null, 'mgdl'), '–');
});

test('unitSuffix', () => {
  assert.equal(GD.unitSuffix('mgdl'), 'mg/dL');
  assert.equal(GD.unitSuffix('mmol'), 'mmol/L');
});

test('trendIcon: every DEXCOM_TREND_DIRECTIONS key maps to a known shape, unknown falls back to empty', () => {
  const KNOWN_DIRECTIONS = [
    'None', 'DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat',
    'FortyFiveDown', 'SingleDown', 'DoubleDown', 'NotComputable', 'RateOutOfRange',
  ];
  const VALID_SHAPES = new Set(['', 'arrow', 'double', 'question', 'dash']);
  KNOWN_DIRECTIONS.forEach((direction) => {
    const icon = GD.trendIcon(direction) as { shape: string; rotation: number };
    assert.ok(VALID_SHAPES.has(icon.shape), `${direction} maps to a known shape`);
  });
  assert.equal((GD.trendIcon('SomethingUnknown') as { shape: string }).shape, '');
});

test('trendIcon: the five straight/diagonal directions share the "arrow" shape, rotated consistently', () => {
  assert.deepEqual(GD.trendIcon('SingleUp'), { shape: 'arrow', rotation: 0 });
  assert.deepEqual(GD.trendIcon('FortyFiveUp'), { shape: 'arrow', rotation: 45 });
  assert.deepEqual(GD.trendIcon('Flat'), { shape: 'arrow', rotation: 90 });
  assert.deepEqual(GD.trendIcon('FortyFiveDown'), { shape: 'arrow', rotation: 135 });
  assert.deepEqual(GD.trendIcon('SingleDown'), { shape: 'arrow', rotation: 180 });
});

test('trendIcon: DoubleUp/DoubleDown share the "double" shape, mirrored via rotation', () => {
  assert.deepEqual(GD.trendIcon('DoubleUp'), { shape: 'double', rotation: 0 });
  assert.deepEqual(GD.trendIcon('DoubleDown'), { shape: 'double', rotation: 180 });
});

test('trendIcon: None has no icon at all', () => {
  assert.equal((GD.trendIcon('None') as { shape: string }).shape, '');
});

test('severity: mutually exclusive, urgent-low takes precedence, normal when nothing set', () => {
  assert.equal(GD.severity({ urgentLow: true, low: true, high: true }), 'urgent-low');
  assert.equal(GD.severity({ low: true, high: true }), 'low');
  assert.equal(GD.severity({ high: true }), 'high');
  assert.equal(GD.severity({}), 'normal');
  assert.equal(GD.severity(undefined), 'normal');
});

test('badgeText: no-data always wins over severity - a stale reading is not trustworthy enough to still assert its old alarm state', () => {
  // Returns a translation key, not display text - the widget resolves it via Homey.__()
  // (see index.html's badgeLabel(), outside the dependency-free GLUCOSE-LOGIC block).
  assert.equal(GD.badgeText({ noData: true }), 'noData');
  assert.equal(GD.badgeText({ urgentLow: true, noData: true }), 'noData');
  assert.equal(GD.badgeText({ high: true, noData: true }), 'noData');
  assert.equal(GD.badgeText({}), '');
});

test('BADGE_CLASS: every badgeText() key maps to a CSS class, so the pill\'s color can never disagree with its own text', () => {
  const badgeClass = GD.BADGE_CLASS as unknown as Record<string, string>;
  assert.equal(badgeClass.noData, 'no-data');
  assert.equal(badgeClass.urgentLow, 'urgent-low');
  assert.equal(badgeClass.low, 'low');
  assert.equal(badgeClass.high, 'high');
});

test('fmtAgo: relative time formatting', () => {
  // Returns a { key, hours?, minutes? } descriptor, not display text - resolved via
  // Homey.__() in index.html's agoLabel(), same reasoning as badgeText() above.
  const now = 1_000_000_000_000;
  assert.deepEqual(GD.fmtAgo(null, now), { key: 'noDataAgo' });
  assert.deepEqual(GD.fmtAgo(now - 10_000, now), { key: 'justNow' });
  assert.deepEqual(GD.fmtAgo(now - 5 * 60_000, now), { key: 'minutesAgo', minutes: 5 });
  assert.deepEqual(GD.fmtAgo(now - 65 * 60_000, now), { key: 'hoursMinutesAgo', hours: 1, minutes: 5 });
  assert.deepEqual(GD.fmtAgo(now - 120 * 60_000, now), { key: 'hoursAgo', hours: 2 });
});

const SPARK_NOW = 1_700_000_000_000;

test('sparkline: empty history returns no segments, no dots, no zones, and no ticks', () => {
  const result = GD.sparkline([], 'mgdl', { nowMs: SPARK_NOW }) as {
    segments: string[]; dots: unknown[]; zones: unknown[]; yTicks: unknown[];
  };
  assert.deepEqual(result.segments, []);
  assert.deepEqual(result.dots, []);
  assert.deepEqual(result.zones, []);
  assert.deepEqual(result.yTicks, []);
});

test('sparkline: yTicks label the fixed Dexcom sensor-range domain, not the data range', () => {
  const history = [
    { t: SPARK_NOW - 600_000, v: 100 }, { t: SPARK_NOW - 300_000, v: 150 }, { t: SPARK_NOW, v: 80 },
  ];
  const result = GD.sparkline(history, 'mgdl', { width: 260, height: 90, nowMs: SPARK_NOW }) as {
    yTicks: { y: number; label: string }[];
  };
  assert.equal(result.yTicks.length, 2);
  assert.equal(result.yTicks[0].y, 0);
  assert.equal(result.yTicks[1].y, 90);
  assert.equal(result.yTicks[0].label, '400', 'top tick is the fixed sensor max, unaffected by the 80-150 data range');
  assert.equal(result.yTicks[1].label, '40', 'bottom tick is the fixed sensor min, unaffected by the 80-150 data range');
});

test('fmtTick: mg/dL rounds to an integer, mmol/L keeps one decimal', () => {
  assert.equal(GD.fmtTick(101.6, 'mgdl'), '102');
  assert.equal(GD.fmtTick(3.94, 'mmol'), '3.9');
});

test('sparkline: x-axis is a fixed WINDOW_MS-wide window anchored to now, not the data span', () => {
  const windowMs = GD.WINDOW_MS as unknown as number;
  // Two closely-spaced (gap-free) pairs at opposite ends of the window, far apart from each
  // other - close enough within each pair to stay one line segment, far enough apart from the
  // other pair to land in a separate segment (real 3h-window data is this sparse: ~5 min
  // cadence, not a dense line spanning the whole window).
  const history = [
    { t: SPARK_NOW - windowMs, v: 100 }, { t: SPARK_NOW - windowMs + 300_000, v: 150 },
    { t: SPARK_NOW - 300_000, v: 90 }, { t: SPARK_NOW, v: 80 },
  ];
  const result = GD.sparkline(history, 'mgdl', { width: 260, height: 90, nowMs: SPARK_NOW }) as { segments: string[] };
  assert.equal(result.segments.length, 2);
  const first = result.segments[0].split(' ').map((p) => p.split(',').map(Number));
  const last = result.segments[1].split(' ').map((p) => p.split(',').map(Number));
  assert.equal(first[0][0], 0, 'sample at window start lands at x=0');
  assert.equal(last[1][0], 260, 'sample at "now" lands at x=width');
  // Higher glucose draws higher on screen (smaller y, since SVG y grows downward).
  assert.ok(first[1][1] < first[0][1], 'the 150 mg/dL point sits above the 100 mg/dL point');
  assert.ok(last[0][1] < last[1][1], 'the 90 mg/dL point sits above the 80 mg/dL point');
});

test('sparkline: a stale tail (no reading for the last 20 minutes) leaves a trailing gap instead of stretching to fill the width', () => {
  const history = [
    { t: SPARK_NOW - 20 * 60_000 - 300_000, v: 100 }, { t: SPARK_NOW - 20 * 60_000, v: 105 },
  ];
  const result = GD.sparkline(history, 'mgdl', { width: 260, height: 90, nowMs: SPARK_NOW }) as { segments: string[] };
  const lastPoint = result.segments[0].split(' ').slice(-1)[0].split(',').map(Number);
  assert.ok(lastPoint[0] < 260, 'the last actual reading does not reach the right (now) edge');
});

test('sparkline: breaks the line across a gap wider than GAP_THRESHOLD_MS, but still dots the stranded point', () => {
  const gapMs = (GD.GAP_THRESHOLD_MS as unknown as number) + 60_000;
  const history = [
    { t: SPARK_NOW - 3 * 300_000, v: 100 }, { t: SPARK_NOW - 2 * 300_000, v: 105 }, // one connected pair
    { t: SPARK_NOW - 2 * 300_000 + gapMs, v: 110 }, // stranded on both sides by gaps
  ];
  const result = GD.sparkline(history, 'mgdl', { width: 260, height: 90, nowMs: SPARK_NOW }) as {
    segments: string[]; dots: { x: number; y: number }[];
  };
  assert.equal(result.segments.length, 1, 'only the connected pair forms a line segment');
  assert.equal(result.segments[0].split(' ').length, 2);
  assert.equal(result.dots.length, 3, 'every sample gets a dot, including the one stranded between gaps');
});

type Zone = { cls: string; y: number; height: number };

const SPARK_HISTORY = [{ t: SPARK_NOW - 300_000, v: 100 }, { t: SPARK_NOW, v: 105 }];

function sparkZones(opts: Record<string, number> = {}): Zone[] {
  return (GD.sparkline(SPARK_HISTORY, 'mgdl', {
    width: 260, height: 90, urgentLowMgDl: 55, lowMgDl: 70, highMgDl: 180, nowMs: SPARK_NOW, ...opts,
  }) as { zones: Zone[] }).zones;
}

test('sparkline: the three thresholds cut the domain into four contiguous zones', () => {
  const zones = sparkZones();
  assert.deepEqual(zones.map((z) => z.cls), ['urgent-low', 'low', 'normal', 'high']);
  zones.forEach((z) => {
    assert.ok(z.height > 0, `${z.cls} zone has positive height`);
    assert.ok(z.y >= 0 && z.y + z.height <= 90, `${z.cls} zone sits within the viewport`);
  });
  // Contiguous and gapless across the full fixed sensor-range domain. The array runs
  // low-to-high in glucose, which is bottom-to-top in SVG y (inverted), so urgent-low ends at
  // the viewport bottom, high starts at its top, and each zone's top edge is the next one's
  // bottom edge.
  assert.ok(Math.abs((zones[0].y + zones[0].height) - 90) < 1e-9, 'urgent-low zone ends at the viewport bottom');
  zones.slice(1).forEach((z, i) => {
    assert.ok(Math.abs((z.y + z.height) - zones[i].y) < 1e-9, `${z.cls} zone sits directly on top of ${zones[i].cls}`);
  });
  assert.equal(zones[zones.length - 1].y, 0, 'high zone reaches the viewport top');
});

test('sparkline: zones needing an unsupplied threshold are dropped, the rest still draw', () => {
  const zones = sparkZones({ urgentLowMgDl: undefined as unknown as number });
  // Both zones bounded by urgentLow go; low..high and high..max are unaffected.
  assert.deepEqual(zones.map((z) => z.cls), ['normal', 'high']);
});

test('sparkline: a nonsensical threshold ordering drops the inverted zone rather than drawing it', () => {
  // low above high - the normal zone would otherwise come out negative-height.
  const zones = sparkZones({ lowMgDl: 200, highMgDl: 180 });
  assert.ok(!zones.some((z) => z.cls === 'normal'), 'inverted normal zone dropped');
  assert.ok(zones.every((z) => z.height > 0), 'every surviving zone still has positive height');
});
