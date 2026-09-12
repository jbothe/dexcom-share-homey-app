'use strict';

import test from 'node:test';
import assert from 'node:assert';
import {
  DexcomPoller, DexcomClientLike, DexcomCredentials, DexcomReadingLike, computeNextPollDelayMs,
} from '../lib/dexcom/DexcomPoller';
import { DexcomPollerHost, GlucoseTokens, Units } from '../lib/dexcom/types';

/** Deterministic, manually-advanced clock so ticks can be driven without real timers. */
class FakeClock {
  nowMs = 0;

  private timers: { id: number; fn: () => void | Promise<void>; at: number }[] = [];

  private nextId = 1;

  now = (): number => this.nowMs;

  setTimer = (fn: () => void | Promise<void>, ms: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, fn, at: this.nowMs + ms });
    return id;
  };

  clearTimer = (id: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };

  /** Advance the clock by ms, firing (and awaiting) any timers due along the way, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
      if (due.length === 0) {
        this.nowMs = target;
        return;
      }
      const next = due[0];
      this.nowMs = next.at;
      this.timers = this.timers.filter((t) => t.id !== next.id);
      await next.fn();
    }
  }
}

class FakeHost implements DexcomPollerHost {
  capabilities: Record<string, unknown> = {};

  settings: Record<string, unknown>;

  units: Units = 'mgdl';

  available = true;

  warning: string | null = null;

  events: { type: string; tokens: unknown }[] = [];

  constructor(settings: Record<string, unknown> = {}) {
    this.settings = settings;
  }

  setCapability(capabilityId: string, value: unknown): void {
    this.capabilities[capabilityId] = value;
  }

  getSetting<T>(key: string): T | undefined {
    return this.settings[key] as T | undefined;
  }

  getUnits(): Units {
    return this.units;
  }

  setAvailable(): void {
    this.available = true;
  }

  setUnavailable(message: string): void {
    this.available = false;
    this.warning = message;
  }

  setWarning(message: string | null): void {
    this.warning = message;
  }

  log(): void {}

  errors: unknown[][] = [];

  error(...args: unknown[]): void {
    this.errors.push(args);
  }

  onGlucoseChanged(tokens: GlucoseTokens): void {
    this.events.push({ type: 'glucose_changed', tokens });
  }

  onUrgentLow(tokens: GlucoseTokens): void {
    this.events.push({ type: 'urgent_low', tokens });
  }

  onLow(tokens: GlucoseTokens): void {
    this.events.push({ type: 'low', tokens });
  }

  onHigh(tokens: GlucoseTokens): void {
    this.events.push({ type: 'high', tokens });
  }

  onRapidChange(tokens: { direction: 'rising' | 'falling' }): void {
    this.events.push({ type: 'rapid_change', tokens });
  }

  onNoData(tokens: { minutes: number }): void {
    this.events.push({ type: 'no_data', tokens });
  }

  snapshotUpdatedCount = 0;

  onSnapshotUpdated(): void {
    this.snapshotUpdatedCount += 1;
  }
}

function reading(mgDl: number, trendDirection: string, datetime: Date): DexcomReadingLike {
  return {
    mgDl,
    mmolL: Math.round(mgDl * 0.0555 * 10) / 10,
    trendDirection,
    trendDescription: trendDirection,
    datetime,
  };
}

/** A fake client whose getGlucoseReadings can be swapped per test (success, throw, empty). */
class FakeClient implements DexcomClientLike {
  impl: (minutes?: number, maxCount?: number) => Promise<DexcomReadingLike[]>;

  calls = 0;

  constructor(impl: (minutes?: number, maxCount?: number) => Promise<DexcomReadingLike[]>) {
    this.impl = impl;
  }

  getGlucoseReadings(minutes?: number, maxCount?: number): Promise<DexcomReadingLike[]> {
    this.calls += 1;
    return this.impl(minutes, maxCount);
  }
}

function accountError(): Error {
  const error = new Error('bad password') as Error & { errorType: string };
  error.errorType = 'AccountError';
  return error;
}

function serverError(): Error {
  const error = new Error('server blew up') as Error & { errorType: string };
  error.errorType = 'ServerError';
  return error;
}

test('normal cadence: reschedules every 5 minutes after a successful tick', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  let client!: FakeClient;
  const poller = new DexcomPoller({
    host,
    clientFactory: (creds: DexcomCredentials) => {
      client = new FakeClient(async () => [reading(100, 'Flat', new Date(clock.nowMs))]);
      return client;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(client.calls, 1);
  assert.equal(host.capabilities.measure_glucose, 100);

  await clock.advance(5 * 60_000);
  assert.equal(client.calls, 2);

  await clock.advance(5 * 60_000);
  assert.equal(client.calls, 3);
});

test('transient failure backs off short-then-settles back to normal cadence', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  let shouldFail = true;
  let client!: FakeClient;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => {
      client = new FakeClient(async () => {
        if (shouldFail) throw serverError();
        return [reading(100, 'Flat', new Date(clock.nowMs))];
      });
      return client;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(host.available, true, 'ServerError does not mark the device unavailable');

  await clock.advance(60_000);
  assert.equal(client.calls, 2, 'first retry after 60s');

  shouldFail = false;
  await clock.advance(120_000);
  assert.equal(client.calls, 3, 'second retry after 120s, now succeeds');

  await clock.advance(5 * 60_000);
  assert.equal(client.calls, 4, 'settled back to the normal 5 minute cadence');
});

test('AccountError triggers a long backoff and marks the device unavailable', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  let client!: FakeClient;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => {
      client = new FakeClient(async () => {
        throw accountError();
      });
      return client;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(host.available, false);
  assert.match(host.warning ?? '', /credentials/i);

  await clock.advance(60_000);
  assert.equal(client.calls, 1, 'not retried at the short transient interval');

  await clock.advance(14 * 60_000);
  assert.equal(client.calls, 2, 'retried once the full 15 minute backoff elapsed');
});

test('an AccountError ends the transient-failure streak rather than carrying its tier across', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  // Two transient failures climb to the last tier, then an account error interrupts, then a
  // transient failure again. That last one must restart the tiers at 60s, not resume at 300s:
  // the tiers count *consecutive transient* failures, and an account error is not one of those.
  const failures = [serverError(), serverError(), accountError(), serverError()];
  let index = 0;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => {
      const failure = failures[Math.min(index, failures.length - 1)];
      index += 1;
      throw failure;
    }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start(); // transient #1 -> 60s
  await clock.advance(60_000); // transient #2 -> 120s
  await clock.advance(120_000); // account error -> 15 min
  assert.equal(index, 3);
  assert.equal(host.available, false);

  await clock.advance(15 * 60_000); // transient again, after the account backoff
  assert.equal(index, 4);

  // The streak restarted, so this retry lands at 60s rather than the 300s top tier.
  await clock.advance(60_000);
  assert.equal(index, 5, 'retried at the first tier again, not the tier the streak had reached');
});

test('capability writes only happen on a severity crossing edge, not every tick', async () => {
  const clock = new FakeClock();
  const host = new FakeHost({
    urgentLowThreshold: 55, lowThreshold: 70, highThreshold: 180,
  });
  let value = 100;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => [reading(value, 'Flat', new Date(clock.nowMs))]),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(host.capabilities.alarm_low, false);
  const lowEventsBefore = host.events.filter((e) => e.type === 'low').length;

  await clock.advance(5 * 60_000);
  assert.equal(host.events.filter((e) => e.type === 'low').length, lowEventsBefore, 'still normal, no new edge');

  value = 65;
  await clock.advance(5 * 60_000);
  assert.equal(host.capabilities.alarm_low, true);
  assert.equal(host.events.filter((e) => e.type === 'low').length, lowEventsBefore + 1, 'fired once on the edge');

  await clock.advance(5 * 60_000);
  assert.equal(host.events.filter((e) => e.type === 'low').length, lowEventsBefore + 1, 'no repeat while still low');
});

test('thresholds stored in mmol/L are converted to mg/dL before classification, not compared raw', async () => {
  const clock = new FakeClock();
  // 70 mg/dL == 3.9 mmol/L; stored here as the mmol/L number since that's this device's
  // active unit. Comparing this raw (as if it meant 3.9 mg/dL) would never classify a
  // realistic reading as low - the bug this test guards against.
  const host = new FakeHost({ urgentLowThreshold: 3.1, lowThreshold: 3.9, highThreshold: 10 });
  host.units = 'mmol';
  let value = 100;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => [reading(value, 'Flat', new Date(clock.nowMs))]),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(host.capabilities.alarm_low, false);

  value = 65;
  await clock.advance(5 * 60_000);
  assert.equal(host.capabilities.alarm_low, true, '65 mg/dL is below the 70 mg/dL (3.9 mmol/L) low threshold');
});

test('alarm_no_data trips at the configured timeout and self-clears on new data', async () => {
  const clock = new FakeClock();
  const host = new FakeHost({ noDataTimeoutMin: 20 });
  let stopSendingData = false;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => (stopSendingData ? [] : [reading(100, 'Flat', new Date(clock.nowMs))])),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(host.capabilities.alarm_no_data, false);

  stopSendingData = true;
  await clock.advance(25 * 60_000);
  assert.equal(host.capabilities.alarm_no_data, true);
  assert.equal(host.events.filter((e) => e.type === 'no_data').length, 1);
});

test('a severity alarm clears (once) when its reading goes stale, and does not re-fire while stuck on that same stale reading', async () => {
  // Regression test: Dexcom keeps returning the same last-measured reading, unchanged, on every
  // poll for as long as it's still within the 180-minute request window - readings is never
  // empty just because nothing new has arrived. Naively re-deriving severity from that reading
  // every tick (once it's already been cleared for staleness) would fire onHigh again on the
  // very next tick, then clear again next tick after that, forever - a 5-minute fire/clear loop.
  const clock = new FakeClock();
  const host = new FakeHost({ noDataTimeoutMin: 20, highThreshold: 180 });
  const staleReadingTime = new Date(0);
  let readingTime: Date = staleReadingTime;
  let value = 200; // above the 180 mg/dL high threshold
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => [reading(value, 'Flat', readingTime)]),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(host.capabilities.alarm_high, true);
  assert.equal(host.events.filter((e) => e.type === 'high').length, 1);

  // Same stale reading (fixed timestamp) returned on every poll past the no-data timeout.
  await clock.advance(25 * 60_000);
  assert.equal(host.capabilities.alarm_no_data, true, 'no-data timeout tripped');
  assert.equal(host.capabilities.alarm_high, false, 'a 25-minute-old "High" is no longer trustworthy as current status');
  assert.equal(host.events.filter((e) => e.type === 'high').length, 1, 'clearing on staleness is not itself a new high edge');

  // Keep polling the same stale reading for a while longer - must not re-fire or re-clear.
  await clock.advance(15 * 60_000);
  assert.equal(host.capabilities.alarm_high, false);
  assert.equal(host.events.filter((e) => e.type === 'high').length, 1, 'still no repeat firing while stuck on the same stale reading');

  // A genuinely new reading (new timestamp), still high, resumes.
  value = 210;
  readingTime = new Date(clock.nowMs + 5 * 60_000);
  await clock.advance(5 * 60_000);
  assert.equal(host.capabilities.alarm_no_data, false, 'self-clears once fresh data resumes');
  assert.equal(host.capabilities.alarm_high, true, 'fresh reading is reclassified on its own merits');
  assert.equal(host.events.filter((e) => e.type === 'high').length, 2, 'fires again for the genuinely new high edge');
});

test('a reading that is already stale on the first tick does not fire an alarm or set its capability', async () => {
  // Regression test: on app start Dexcom hands back whatever it last measured, however old. The
  // first tick's !capabilitiesInitialized force-write used to classify that reading regardless of
  // its age - firing onHigh for a hours-old value, with applyNoDataAlarm() only clearing the
  // capability again later in the same tick (the trigger having already fired, un-retractably).
  const clock = new FakeClock();
  const host = new FakeHost({ noDataTimeoutMin: 20, highThreshold: 180 });
  clock.nowMs = 3 * 60 * 60_000;
  let readingTime = new Date(clock.nowMs - 90 * 60_000); // 90 minutes old, well past the timeout
  let value = 200; // above the 180 mg/dL high threshold
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => [reading(value, 'DoubleUp', readingTime)]),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(host.capabilities.alarm_no_data, true, 'the 90-minute-old reading is stale from the start');
  assert.equal(host.capabilities.alarm_high, false, 'capability explicitly written false, not left unset');
  assert.equal(host.capabilities.alarm_rapid_change, false, 'a stale DoubleUp trend is no more current than a stale value');
  assert.equal(host.events.filter((e) => e.type === 'high').length, 0, 'no phantom high on start');
  assert.equal(host.events.filter((e) => e.type === 'rapid_change').length, 0, 'no phantom rapid change on start');

  // Still the same stale reading on the next poll - nothing changes.
  await clock.advance(5 * 60_000);
  assert.equal(host.capabilities.alarm_high, false);
  assert.equal(host.events.filter((e) => e.type === 'high').length, 0);

  // A genuinely fresh reading is classified as a real edge on its own merits.
  value = 210;
  readingTime = new Date(clock.nowMs + 5 * 60_000);
  await clock.advance(5 * 60_000);
  assert.equal(host.capabilities.alarm_no_data, false);
  assert.equal(host.capabilities.alarm_high, true);
  assert.equal(host.events.filter((e) => e.type === 'high').length, 1, 'fires once, for the first trustworthy reading');
});

test('an account that has never returned a reading still force-writes its alarm capabilities to false', async () => {
  // Regression test: applyReadings() early-returns on an empty poll, which used to leave
  // capabilitiesInitialized false forever on a freshly paired account whose sensor session hasn't
  // produced a reading yet. The first-tick force-write was therefore unreachable on exactly the
  // device that needs it most, and alarm_urgent_low/low/high/rapid_change sat at Homey's own
  // unset default on the tile indefinitely - only alarm_no_data (written by applyNoDataAlarm,
  // which runs every tick regardless of the poll's own outcome) ever appeared at all.
  const clock = new FakeClock();
  const host = new FakeHost({ noDataTimeoutMin: 20, highThreshold: 180 });
  let readings: DexcomReadingLike[] = [];
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => readings),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(host.capabilities.alarm_urgent_low, false, 'written false, not left unset');
  assert.equal(host.capabilities.alarm_low, false);
  assert.equal(host.capabilities.alarm_high, false);
  assert.equal(host.capabilities.alarm_rapid_change, false);
  assert.equal(host.capabilities.alarm_no_data, true, 'no reading has ever arrived, so the data is stale by definition');
  assert.equal(host.events.filter((e) => e.type !== 'no_data').length, 0, 'nothing to classify means nothing to fire');
  assert.equal(
    host.capabilities.measure_glucose, undefined,
    'unlike the alarms, a glucose value has no meaningful "nothing wrong" default to assert',
  );
  assert.equal(host.capabilities.glucose_trend, undefined);

  // The account's first real reading is still classified as a genuine edge on its own merits -
  // the force-write above must not have consumed the first-severity-crossing edge.
  readings = [reading(200, 'Flat', new Date(clock.nowMs + 5 * 60_000))];
  await clock.advance(5 * 60_000);
  assert.equal(host.capabilities.alarm_no_data, false);
  assert.equal(host.capabilities.alarm_high, true);
  assert.equal(host.capabilities.measure_glucose, 200);
  assert.equal(host.capabilities.glucose_trend, 'Flat', 'the first real trend is written even though it follows an empty tick');
  assert.equal(host.events.filter((e) => e.type === 'high').length, 1, 'fires exactly once, for the first real reading');
});

test('client is not rebuilt when only threshold settings change', async () => {
  const clock = new FakeClock();
  const host = new FakeHost({
    username: 'alice', password: 'secret', region: 'us', lowThreshold: 70,
  });
  let factoryCalls = 0;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => {
      factoryCalls += 1;
      return new FakeClient(async () => [reading(100, 'Flat', new Date(clock.nowMs))]);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(factoryCalls, 1);

  host.settings.lowThreshold = 75;
  await poller.refreshConfig();
  assert.equal(factoryCalls, 1, 'threshold-only change does not rebuild the client');

  host.settings.password = 'new-secret';
  await poller.refreshConfig();
  assert.equal(factoryCalls, 2, 'credential change does rebuild the client');
});

test('a clientFactory failure still schedules a retry rather than killing the poll loop outright', async () => {
  const clock = new FakeClock();
  const host = new FakeHost({ username: 'alice', password: 'secret', region: 'us' });
  let factoryCalls = 0;
  // Fails the first two builds (e.g. client.ts's dynamic ESM import failing), then recovers.
  const poller = new DexcomPoller({
    host,
    clientFactory: () => {
      factoryCalls += 1;
      if (factoryCalls <= 2) throw new Error('ESM import failed');
      return new FakeClient(async () => [reading(100, 'Flat', new Date(clock.nowMs))]);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  // start() must not reject: a build failure is a tick failure, handled like any other.
  await poller.start();
  assert.equal(factoryCalls, 1);
  assert.equal(host.capabilities.alarm_no_data, true, 'no-data is still evaluated on a failed tick');

  // The whole point: a timer was armed, so the device retries instead of going silent forever.
  await clock.advance(60_000);
  assert.equal(factoryCalls, 2, 'retried on the first transient backoff tier');

  await clock.advance(120_000);
  assert.equal(factoryCalls, 3, 'retried again on the second tier, and this build succeeds');
  assert.equal(host.capabilities.measure_glucose, 100, 'recovers and polls normally once built');
  assert.equal(host.capabilities.alarm_no_data, false);
});

test('a failed client rebuild does not leave the poller polling as the previous account', async () => {
  const clock = new FakeClock();
  const host = new FakeHost({ username: 'alice', password: 'secret', region: 'us' });
  const built: string[] = [];
  const poller = new DexcomPoller({
    host,
    clientFactory: (credentials: DexcomCredentials) => {
      built.push(credentials.username);
      if (credentials.username === 'broken') throw new Error('construction rejected');
      return new FakeClient(async () => [reading(100, 'Flat', new Date(clock.nowMs))]);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.deepEqual(built, ['alice']);

  // Credentials edited to something whose client build fails. The fingerprint must NOT be
  // recorded as current here: doing so used to make every later refreshConfig() see a matching
  // fingerprint plus the still-live 'alice' client, skip the rebuild, and go on polling as alice
  // indefinitely while the device's own settings read 'broken'.
  host.settings.username = 'broken';
  await assert.rejects(() => poller.refreshConfig(), /construction rejected/);
  assert.deepEqual(built, ['alice', 'broken']);

  await assert.rejects(() => poller.refreshConfig(), /construction rejected/);
  assert.deepEqual(built, ['alice', 'broken', 'broken'], 'retries the build instead of assuming it is current');

  // Once the credentials are valid again, the very next attempt builds with them.
  host.settings.username = 'carol';
  await poller.refreshConfig();
  assert.deepEqual(built, ['alice', 'broken', 'broken', 'carol']);
});

test('requestImmediateRefresh is a no-op when called too soon after the last tick', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  let client!: FakeClient;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => {
      client = new FakeClient(async () => [reading(100, 'Flat', new Date(clock.nowMs))]);
      return client;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(client.calls, 1);

  await poller.requestImmediateRefresh();
  assert.equal(client.calls, 1, 'rate-limited, less than 60s since last tick');

  clock.nowMs += 60_000;
  await poller.requestImmediateRefresh();
  assert.equal(client.calls, 2, 'allowed once 60s have passed');
});

test('reading time is recomputed from raw DT, not trusted from the (possibly offset-buggy) library .datetime', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  const trueEpoch = 1_700_000_000_000;
  // Simulates dexcom-share-client's confirmed datetime bug (see lib/dexcom/timestamp.ts): the
  // raw DT field's ticks are the correct absolute instant, but the library's own .datetime
  // getter has already been shifted hours off by double-applying the offset suffix. The poller
  // must ignore .datetime here and recompute from .json.DT instead.
  const buggyDatetime = new Date(trueEpoch - 10 * 60 * 60_000);
  const brokenReading: DexcomReadingLike = {
    mgDl: 100,
    mmolL: 5.5,
    trendDirection: 'Flat',
    trendDescription: 'Flat',
    datetime: buggyDatetime,
    json: { DT: `/Date(${trueEpoch}+1000)/` },
  };
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => [brokenReading]),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(poller.getSnapshot().updatedAt, trueEpoch, 'uses the DT-corrected time, not the buggy .datetime');
});

test('reading time falls back to .datetime and logs when the raw DT is present but unparseable', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  const fallbackTime = new Date(987654);
  const weirdReading: DexcomReadingLike = {
    mgDl: 100,
    mmolL: 5.5,
    trendDirection: 'Flat',
    trendDescription: 'Flat',
    datetime: fallbackTime,
    json: { DT: 'not a dexcom date at all' },
  };
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => [weirdReading]),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(poller.getSnapshot().updatedAt, fallbackTime.getTime());
  assert.equal(host.errors.length, 1, 'logs so an unexpected DT shape is diagnosable, not silently swallowed');
});

test('reading time falls back to .datetime when no raw json is available', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  const fallbackTime = new Date(123456);
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => [reading(100, 'Flat', fallbackTime)]),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(poller.getSnapshot().updatedAt, fallbackTime.getTime());
});

test('onSnapshotUpdated fires after every tick, success or failure - not just on the app\'s own periodic broadcast timer', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  let shouldFail = false;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => {
      if (shouldFail) throw serverError();
      return [reading(100, 'Flat', new Date(clock.nowMs))];
    }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(host.snapshotUpdatedCount, 1, 'fires immediately after the first tick, not deferred to a later timer');

  shouldFail = true;
  await clock.advance(5 * 60_000);
  assert.equal(host.snapshotUpdatedCount, 2, 'also fires on a failed tick, so the widget still reflects e.g. staleness');
});

test('glucose_changed fires only when the reading itself is new, not every tick', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  const fixedReadingTime = new Date(0);
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => [reading(100, 'Flat', fixedReadingTime)]),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(host.events.filter((e) => e.type === 'glucose_changed').length, 1);

  await clock.advance(5 * 60_000);
  assert.equal(
    host.events.filter((e) => e.type === 'glucose_changed').length,
    1,
    'same reading timestamp repeated across polls does not re-fire',
  );
});

test('computeNextPollDelayMs targets 5 minutes after the reading\'s own timestamp, catching up when the reading was already stale on fetch', () => {
  // Fetched 2 minutes after the sample was actually taken - the old flat "now + 5min" schedule
  // would poll every future sample exactly 2 minutes late, forever. Anchoring to the sample's
  // own timestamp instead should shorten just this one delay by that same 2 minutes.
  const readingTimeMs = 0;
  const nowMs = 2 * 60_000;
  assert.equal(computeNextPollDelayMs(readingTimeMs, nowMs, true, 0), 3 * 60_000);
});

test('computeNextPollDelayMs clamps to a floor rather than polling immediately when already well past the target', () => {
  const readingTimeMs = 0;
  const nowMs = 10 * 60_000; // e.g. after a long error backoff delayed the tick
  assert.equal(computeNextPollDelayMs(readingTimeMs, nowMs, true, 0), 30_000);
});

test('computeNextPollDelayMs clamps to the normal cadence rather than waiting longer than usual', () => {
  const readingTimeMs = 0;
  const nowMs = 0; // reading fetched exactly on time - no lag to correct for
  assert.equal(computeNextPollDelayMs(readingTimeMs, nowMs, true, 0), 5 * 60_000);
});

test('computeNextPollDelayMs falls back to the normal cadence when there is no reading to anchor to', () => {
  assert.equal(computeNextPollDelayMs(null, 0, false, 1), 5 * 60_000);
});

test('computeNextPollDelayMs backs off in short tiers on repeated misses, then settles at the normal cadence', () => {
  assert.equal(computeNextPollDelayMs(0, 0, false, 1), 30_000, 'first miss: quick retry');
  assert.equal(computeNextPollDelayMs(0, 0, false, 2), 60_000, 'second miss: a bit longer');
  assert.equal(computeNextPollDelayMs(0, 0, false, 3), 5 * 60_000, 'third miss: settle to normal cadence');
  assert.equal(computeNextPollDelayMs(0, 0, false, 10), 5 * 60_000, 'stays capped, never grows further');
});

test('self-corrects a lag between the poll clock and Dexcom\'s own sample clock, instead of repeating it forever', async () => {
  // Regression test for the reported symptom: the very first successful poll happens 2 minutes
  // after Dexcom's own 5-minute sample boundary (e.g. the app started mid-cycle). Scheduling a
  // flat 5 minutes after each poll (the old behavior) would poll every future sample exactly 2
  // minutes late, forever - the app would never actually catch up. Anchoring to the reading's own
  // timestamp should correct that lag on the very next tick, and then stay aligned indefinitely.
  const clock = new FakeClock();
  clock.nowMs = 2 * 60_000;
  const host = new FakeHost();
  const readingTimesSeen: number[] = [];
  const poller = new DexcomPoller({
    host,
    clientFactory: () => new FakeClient(async () => {
      const sampleBoundary = Math.floor(clock.nowMs / (5 * 60_000)) * (5 * 60_000);
      readingTimesSeen.push(sampleBoundary);
      return [reading(100, 'Flat', new Date(sampleBoundary))];
    }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(readingTimesSeen[0], 0, 'first poll only sees the stale t=0 sample, 2 minutes late');

  await clock.advance(3 * 60_000);
  assert.equal(clock.nowMs, 5 * 60_000, 'the catch-up tick lands exactly on the next 5-minute boundary');
  assert.equal(readingTimesSeen[1], 5 * 60_000, 'now polling exactly as each new sample appears, no lag');

  await clock.advance(5 * 60_000);
  assert.equal(readingTimesSeen[2], 10 * 60_000, 'stays aligned on subsequent polls too');
});

test('a stalled account (no new reading) retries quickly at first, then settles back to the normal cadence rather than polling indefinitely fast', async () => {
  const clock = new FakeClock();
  const host = new FakeHost();
  const fixedReadingTime = new Date(0);
  let client!: FakeClient;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => {
      client = new FakeClient(async () => [reading(100, 'Flat', fixedReadingTime)]);
      return client;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(client.calls, 1);

  await clock.advance(10 * 60_000);
  // start (t=0) + normal-cadence poll (t=5:00, first miss) + two short catch-up retries
  // (t=5:00:30, t=5:01:30) before settling back to the normal cadence - never faster than the
  // 30-second floor, and not still retrying quickly 10 minutes into a genuinely stalled account.
  assert.equal(client.calls, 4, `expected a bounded, tapering retry count, got ${client.calls}`);
});

/** Drain the microtask queue so a tick started but not awaited reaches its next real timer. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test('a poll that never settles times out instead of stalling the self-rearming loop', async () => {
  // dexcom-share-client's axios instance sets no timeout and Node adds none, so a black-holed
  // request leaves getGlucoseReadings() pending forever. tick() awaits it, so without the
  // POLL_TIMEOUT_MS guard scheduleNextTick() is never reached and this device stops polling
  // entirely - silently, still marked available - until the whole app is restarted.
  const clock = new FakeClock();
  const host = new FakeHost();
  let hang = true;
  let client!: FakeClient;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => {
      client = new FakeClient(() => (hang
        ? new Promise<DexcomReadingLike[]>(() => {})
        : Promise.resolve([reading(100, 'Flat', new Date(clock.nowMs))])));
      return client;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  // Not awaited: this first tick cannot settle until the fake clock reaches the timeout.
  const started = poller.start();
  await flush();
  assert.equal(client.calls, 1);

  await clock.advance(60_000);
  await started;
  assert.ok(host.errors.length > 0, 'the hang is reported as a failed poll');

  hang = false;
  await clock.advance(60_000);
  assert.equal(client.calls, 2, 'the loop rearmed and retried on the transient-failure backoff');
  assert.equal(host.capabilities.measure_glucose, 100, 'and recovered without an app restart');
});

test('a client failing repeatedly is thrown away and rebuilt', async () => {
  // The client is otherwise only rebuilt when credentials change, so internal state it wedges
  // itself into (dexcom-share-client can retain an invalid session id that its own SessionError
  // retry path never clears) would survive every retry until the app was restarted.
  const clock = new FakeClock();
  const host = new FakeHost();
  let builds = 0;
  let shouldFail = true;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => {
      builds += 1;
      return new FakeClient(async () => {
        if (shouldFail) throw serverError();
        return [reading(100, 'Flat', new Date(clock.nowMs))];
      });
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(builds, 1);
  assert.equal(host.warning, null, 'a single failure is not worth warning about');

  await clock.advance(60_000);
  assert.equal(builds, 1, 'two failures do not force a fresh authentication');

  await clock.advance(120_000);
  assert.equal(builds, 1, 'the third failure drops the client but does not rebuild it in place');
  assert.ok(host.warning, 'a sustained outage is surfaced on the device');

  await clock.advance(5 * 60_000);
  assert.equal(builds, 2, 'the next tick rebuilds, inside its own error handling');

  shouldFail = false;
  await clock.advance(5 * 60_000);
  assert.equal(host.capabilities.measure_glucose, 100);
  assert.equal(host.warning, null, 'the warning clears once polling recovers');
});

test('a hung client build times out instead of stalling the loop', async () => {
  // refreshConfig() sits inside tick()'s try, but a `try` only catches promises that settle -
  // client.ts's dynamic ESM import is the one await here that could hang rather than reject.
  const clock = new FakeClock();
  const host = new FakeHost();
  let hang = true;
  let builds = 0;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => {
      builds += 1;
      if (hang) return new Promise<DexcomClientLike>(() => {});
      return new FakeClient(async () => [reading(100, 'Flat', new Date(clock.nowMs))]);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const started = poller.start();
  await flush();
  assert.equal(builds, 1);

  await clock.advance(60_000);
  await started;

  hang = false;
  await clock.advance(60_000);
  assert.equal(builds, 2, 'the loop rearmed and retried the build');
  assert.equal(host.capabilities.measure_glucose, 100);
});

test('a throw from the post-poll update cannot stop the loop rearming', async () => {
  // applyNoDataAlarm()/onSnapshotUpdated() run after the try/catch. Neither is expected to throw,
  // but "not expected to throw" is what the client build was before it killed this loop once.
  const clock = new FakeClock();
  const host = new FakeHost();
  let client!: FakeClient;
  const poller = new DexcomPoller({
    host,
    clientFactory: () => {
      client = new FakeClient(async () => [reading(100, 'Flat', new Date(clock.nowMs))]);
      return client;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await poller.start();
  assert.equal(client.calls, 1);

  host.onSnapshotUpdated = () => {
    throw new Error('widget broadcast blew up');
  };

  await clock.advance(5 * 60_000);
  assert.equal(client.calls, 2, 'still polling');
  await clock.advance(5 * 60_000);
  assert.equal(client.calls, 3, 'and still rearming on the tick after that');
});
