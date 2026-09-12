'use strict';

import {
  AlarmThresholds, DexcomPollerHost, GlucoseSnapshot, GlucoseTokens, HistoryPoint, Severity,
} from './types';
import {
  classifyGlucose, isRapidChange, isStale, rapidChangeDirection, severityToAlarms,
} from './glucoseAlarms';
import { toDisplay } from './units';
import { thresholdsFromSettings } from './thresholds';
import parseCorrectedEpoch from './timestamp';

/** Minimal shape of a dexcom-share-client GlucoseReading this module actually needs. */
export interface DexcomReadingLike {
  mgDl: number;
  mmolL: number;
  trendDirection: string;
  trendDescription: string;
  datetime: Date;
  /** Raw API payload, used to work around a datetime bug in the library - see timestamp.ts. */
  json?: { DT?: string };
}

/** Minimal shape of a dexcom-share-client DexcomShare instance this module actually needs. */
export interface DexcomClientLike {
  getGlucoseReadings(minutes?: number, maxCount?: number): Promise<DexcomReadingLike[]>;
}

export interface DexcomCredentials {
  username: string;
  password: string;
  region: string;
}

export type DexcomClientFactory = (
  credentials: DexcomCredentials
) => DexcomClientLike | Promise<DexcomClientLike>;

export interface DexcomPollerOptions {
  host: DexcomPollerHost;
  clientFactory: DexcomClientFactory;
  now?: () => number;
  setTimer?: (fn: () => void | Promise<void>, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const NORMAL_INTERVAL_MS = 5 * 60_000;
/** Transient-failure backoff: short, then longer, then settle at the normal cadence. */
const TRANSIENT_BACKOFF_MS = [60_000, 120_000, NORMAL_INTERVAL_MS];
/** Bad credentials / account lockout: long backoff, deliberately not retried quickly. */
const ACCOUNT_ERROR_BACKOFF_MS = 15 * 60_000;
/** requestImmediateRefresh() no-ops if the last tick was more recent than this. */
const MIN_REFRESH_GAP_MS = 60_000;
/**
 * A poll that hasn't settled within this long is abandoned and treated as a transient failure.
 *
 * dexcom-share-client builds its axios instance with `axios.create({ headers })` and no `timeout`
 * (confirmed by reading the shipped source), and Node sets no default request timeout of its own,
 * so a request that black-holes - a NAT/connection-tracking entry dropped after a network blip is
 * the usual cause on a home LAN - leaves `getGlucoseReadings()` pending *forever*. Since tick()
 * awaits it, that also means scheduleNextTick() at the bottom of tick() is never reached: the
 * self-rearming loop stops dead with no timer left to recover it, no error logged, and the device
 * still marked available - exactly the "everything went stale until I restarted the app" failure
 * this constant exists to prevent. 60s is comfortably above a healthy round trip (auth + readings)
 * while still well inside the normal 5-minute cadence.
 */
const POLL_TIMEOUT_MS = 60_000;
/**
 * Consecutive transient failures after which the Dexcom client is thrown away and rebuilt, rather
 * than retried forever as-is.
 *
 * The client is otherwise long-lived and only rebuilt when credentials change (refreshConfig), so
 * any *internal* state it wedges itself into survives every retry and is only cleared by an app
 * restart. dexcom-share-client has at least one such state: `_getSession()` assigns the session id
 * it got back *before* validating it, and if Dexcom returns the all-zero DEFAULT_UUID (its documented
 * answer in some account states) the validation throws an ArgumentError - leaving `_sessionId` set
 * to that invalid value. Every later getGlucoseReadings() then skips session creation (the id is
 * non-null), fails the same validation, and rethrows: its own catch only re-authenticates on
 * `SessionError`, and an ArgumentError isn't one. Dropping the client after a few failures turns
 * that from permanent into a few minutes of downtime. Not done on the first failure: rebuilding
 * forces a fresh authentication, and Dexcom rate-limits those ("Maximum authentication attempts
 * exceeded"), so an ordinary one-off network blip should not trigger one.
 */
const REBUILD_CLIENT_AFTER_FAILURES = 3;
/** Consecutive transient failures after which the device shows a "can't reach Dexcom" warning. */
const WARN_AFTER_FAILURES = 3;
/** Floor for the reading-anchored delay below - never poll more often than this. */
const MIN_POLL_DELAY_MS = 30_000;
/**
 * Backoff tiers for a poll that *succeeds* but doesn't yield a genuinely new reading (either
 * Dexcom's next sample hasn't landed in its own pipeline yet - worth a quick retry - or the
 * account has simply stopped producing data, in which case retrying every 30s forever would just
 * hammer the API for nothing). Index by (consecutive-miss count - 1), capped at the last tier.
 */
const MISSED_READING_BACKOFF_MS = [MIN_POLL_DELAY_MS, 60_000, NORMAL_INTERVAL_MS];
// Dexcom Share's own ceiling (dexcom-share-client's MAX_MINUTES/MAX_MAX_COUNT) - pulling the full
// 24h is what lets the widget's own tap-to-cycle display window zoom out to 6h/12h/24h purely
// client-side (see its WINDOW_OPTIONS_MS), with no poller or payload change per window.
const HISTORY_MINUTES = 1440;
const HISTORY_MAX_COUNT = 288;

/**
 * Delay before the next poll, anchored to the *sample's own* timestamp rather than to when we
 * happened to poll last - see the "polling cadence" note in CLAUDE.md. Scheduling a flat
 * `NORMAL_INTERVAL_MS` after every poll compounds any lag between Dexcom's own sample clock and
 * ours: if the first reading we ever see is already a couple minutes stale, every future poll
 * lands that same couple minutes late forever. Targeting `lastKnownReadingTimeMs + 5min` instead
 * re-aligns to Dexcom's clock on every tick, so a stale first fetch is corrected in one step.
 *
 * `readingAdvanced` is whether *this* tick's poll produced a genuinely new reading (vs. an empty
 * poll or the same last-known reading repeated). When it didn't, there's no fresh timestamp to
 * anchor to, so `missedReadingStreak` (consecutive misses, including this one) picks a short
 * catch-up retry via `MISSED_READING_BACKOFF_MS`, settling back to the normal cadence rather than
 * polling indefinitely fast. Exported for direct unit testing.
 */
export function computeNextPollDelayMs(
  lastKnownReadingTimeMs: number | null,
  nowMs: number,
  readingAdvanced: boolean,
  missedReadingStreak: number,
): number {
  if (!readingAdvanced) {
    if (lastKnownReadingTimeMs === null) return NORMAL_INTERVAL_MS;
    const tierIndex = Math.min(missedReadingStreak - 1, MISSED_READING_BACKOFF_MS.length - 1);
    return MISSED_READING_BACKOFF_MS[Math.max(tierIndex, 0)];
  }
  const target = lastKnownReadingTimeMs! + NORMAL_INTERVAL_MS;
  const delay = target - nowMs;
  return Math.min(Math.max(delay, MIN_POLL_DELAY_MS), NORMAL_INTERVAL_MS);
}

function emptySnapshot(): GlucoseSnapshot {
  return {
    mgDl: null,
    mmolL: null,
    trendDirection: null,
    trendDescription: null,
    updatedAt: null,
    history: [],
    alarms: {
      urgentLow: false, low: false, high: false, rapidChange: false, noData: false,
    },
  };
}

/**
 * Self-rearming per-device poller. Homey-independent (driven purely through DexcomPollerHost),
 * so it can be unit-tested with a fake client/clock instead of a real network round trip. One
 * instance per paired follower device; owns and reuses a single long-lived client so credentials
 * aren't re-authenticated every tick.
 */
export class DexcomPoller {
  private readonly host: DexcomPollerHost;

  private readonly clientFactory: DexcomClientFactory;

  private readonly now: () => number;

  private readonly setTimer: (fn: () => void | Promise<void>, ms: number) => unknown;

  private readonly clearTimer: (handle: unknown) => void;

  private client: DexcomClientLike | null = null;

  private credentialsFingerprint: string | null = null;

  private timerHandle: unknown = null;

  private stopped = true;

  private transientFailureCount = 0;

  private lastTickAt: number | null = null;

  private lastReadingDatetime: number | null = null;

  private lastTrendDirection: string | null = null;

  private lastSeverity: Severity = 'normal';

  private lastRapidChange = false;

  private lastNoData = false;

  /** Forces every capability to be explicitly written at least once on first successful tick. */
  private capabilitiesInitialized = false;

  private noDataInitialized = false;

  /** Consecutive successful polls in a row that did not yield a genuinely new reading - see
   *  computeNextPollDelayMs. Reset to 0 whenever a poll does produce a new reading. */
  private missedReadingStreak = 0;

  private snapshot: GlucoseSnapshot = emptySnapshot();

  constructor(options: DexcomPollerOptions) {
    this.host = options.host;
    this.clientFactory = options.clientFactory;
    this.now = options.now ?? (() => Date.now());
    // eslint-disable-next-line homey-app/global-timers -- cleared via stop()/clearTimer, driven by device.onDeleted()
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(() => {
      // tick() (fn's real body) already catches its own errors internally; this is a defensive
      // backstop so an unexpected synchronous-logic throw can't become an unhandled rejection.
      Promise.resolve(fn()).catch(() => {});
    }, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Deliberately does NOT call refreshConfig() itself: tick() already builds the client when it
   * doesn't have one, and does it inside its own error handling. Calling it here as well would
   * put the very first client build outside any catch, so a clientFactory failure (e.g. the
   * ESM dynamic import in client.ts failing on a real Homey) would reject start() before it ever
   * reached scheduleNextTick() - leaving the device with no timer at all and so no retry, ever.
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this.tick('start');
  }

  stop(): void {
    this.stopped = true;
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
  }

  getSnapshot(): GlucoseSnapshot {
    return this.snapshot;
  }

  /**
   * Rebuild the client only if username/password/region actually changed.
   *
   * The fingerprint is committed only *after* the build resolves, and any client built from the
   * now-superseded credentials is dropped before the attempt. Recording the fingerprint up front
   * instead meant a failed build left the poller claiming to be current while still holding the
   * previous account's client - so every later refreshConfig() saw a matching fingerprint plus a
   * live client, skipped the rebuild, and went on polling the old account indefinitely while the
   * device's own settings showed the new one. Leaving `client` null on failure is what lets
   * tick() retry the build on its next run instead.
   */
  async refreshConfig(): Promise<void> {
    const username = this.host.getSetting<string>('username') ?? '';
    const password = this.host.getSetting<string>('password') ?? '';
    const region = this.host.getSetting<string>('region') ?? 'us';
    const fingerprint = `${username} ${password} ${region}`;
    if (fingerprint === this.credentialsFingerprint && this.client) return;
    this.client = null;
    const client = await this.clientFactory({ username, password, region });
    this.client = client;
    this.credentialsFingerprint = fingerprint;
    this.transientFailureCount = 0;
  }

  /** Rate-limited manual refresh entry point for the "Refresh glucose now" flow action. */
  async requestImmediateRefresh(): Promise<void> {
    const nowMs = this.now();
    if (this.lastTickAt !== null && nowMs - this.lastTickAt < MIN_REFRESH_GAP_MS) {
      // Deliberately resolves rather than throwing: the "Refresh glucose now" Flow action would
      // otherwise mark the whole Flow as failed over a benign rate limit. Logged so that a user
      // wondering why their manual refresh appeared to do nothing can see that it was skipped,
      // and why - without it this is entirely silent from both the Flow and the log.
      const agoSec = Math.round((nowMs - this.lastTickAt) / 1000);
      this.host.log(`[manual] refresh skipped, last poll was ${agoSec}s ago (min gap ${MIN_REFRESH_GAP_MS / 1000}s)`);
      return;
    }
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
    await this.tick('manual');
  }

  /** See thresholdsFromSettings for why the stored numbers can't be compared raw. */
  private thresholds(): AlarmThresholds {
    return thresholdsFromSettings(
      (key) => this.host.getSetting<number>(key),
      this.host.getUnits(),
    );
  }

  private noDataTimeoutMin(): number {
    return this.host.getSetting<number>('noDataTimeoutMin') ?? 20;
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
    }
    this.timerHandle = this.setTimer(() => this.tick('timer'), delayMs);
  }

  /**
   * Reject if `promise` hasn't settled within POLL_TIMEOUT_MS - see that constant for why the
   * underlying request can otherwise hang forever, and why a hang is the one failure mode that
   * kills the self-rearming loop outright rather than backing off. Applied to every await inside
   * tick(), not just the network call: a `try` only catches promises that actually settle.
   *
   * The abandoned promise is deliberately left running (there's nothing to cancel: the library
   * exposes no abort signal), with a rejection handler attached so a late failure can't surface
   * as an unhandled rejection. A late *success* is simply discarded - by then this tick has
   * already scheduled the next one, which will fetch the same data again.
   */
  private withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutHandle = this.setTimer(() => {
        reject(new Error(`Dexcom ${label} timed out after ${POLL_TIMEOUT_MS / 1000}s`));
      }, POLL_TIMEOUT_MS);
      promise.then(
        (value) => {
          this.clearTimer(timeoutHandle);
          resolve(value);
        },
        (error) => {
          this.clearTimer(timeoutHandle);
          reject(error);
        },
      );
    });
  }

  private async tick(trigger: string): Promise<void> {
    this.lastTickAt = this.now();
    let nextDelay = NORMAL_INTERVAL_MS;
    try {
      // Inside the try, not ahead of it: building the client can fail on its own (client.ts's
      // dynamic ESM import, or the constructor rejecting its arguments), and an uncaught failure
      // here would skip applyNoDataAlarm() and - critically - scheduleNextTick() below, killing
      // this device's self-rearming loop outright with no timer left to recover it. Treated as
      // just another tick failure instead, so it backs off and retries like any other.
      if (!this.client) {
        // Timed out for the same reason the poll below is: being inside the try only helps if the
        // promise actually settles. client.ts's dynamic ESM import is the one await here that
        // could in principle hang rather than reject, and a hang never reaches the catch.
        await this.withTimeout(this.refreshConfig(), 'client build');
      }
      const readings = await this.withTimeout(
        this.client!.getGlucoseReadings(HISTORY_MINUTES, HISTORY_MAX_COUNT), 'poll',
      );
      this.host.log(`[${trigger}] Dexcom poll succeeded, ${readings.length} reading(s)`);
      this.transientFailureCount = 0;
      this.host.setAvailable();
      this.host.setWarning(null);
      const readingAdvanced = this.applyReadings(readings);
      this.missedReadingStreak = readingAdvanced ? 0 : this.missedReadingStreak + 1;
      nextDelay = computeNextPollDelayMs(
        this.lastReadingDatetime, this.now(), readingAdvanced, this.missedReadingStreak,
      );
    } catch (error) {
      nextDelay = this.handleError(error, trigger);
    } finally {
      // The whole point of this loop is that it rearms, so rearming is the one thing that must not
      // depend on anything above it succeeding. applyNoDataAlarm() and onSnapshotUpdated() are
      // both thin adapters over Homey (capability writes, Flow triggers, the widget broadcast) and
      // neither is expected to throw - but "not expected to throw" is exactly what the client
      // build was before it killed this loop once already, so the guarantee is made structural
      // here rather than inferred from what the callees currently happen to do.
      try {
        this.applyNoDataAlarm();
        this.host.onSnapshotUpdated?.();
      } catch (error) {
        this.host.error(`[${trigger}] post-poll update failed`, error);
      }
      this.scheduleNextTick(nextDelay);
    }
  }

  private handleError(error: unknown, trigger: string): number {
    const errorType = (error as { errorType?: string } | null)?.errorType;
    if (errorType === 'AccountError') {
      this.host.error(`[${trigger}] Dexcom account error`, error);
      const message = 'Check Dexcom Share credentials in device settings';
      this.host.setUnavailable(message);
      this.host.setWarning(message);
      // Ends the consecutive-transient-failure streak: the tiers below mean "how many transient
      // failures in a row", and an account error is a different failure class handled by its own
      // much longer backoff. Left un-reset, an account error in the middle of a transient streak
      // preserved the tier count across it, so the next transient failure resumed at 300s rather
      // than starting over at 60s.
      this.transientFailureCount = 0;
      return ACCOUNT_ERROR_BACKOFF_MS;
    }
    this.host.error(`[${trigger}] Dexcom poll failed`, error);
    const delay = TRANSIENT_BACKOFF_MS[Math.min(this.transientFailureCount, TRANSIENT_BACKOFF_MS.length - 1)];
    this.transientFailureCount += 1;
    if (this.transientFailureCount >= REBUILD_CLIENT_AFTER_FAILURES) {
      // Dropped, not rebuilt here: tick() rebuilds inside its own try/catch on the next run, so a
      // failing clientFactory stays just another tick failure. See REBUILD_CLIENT_AFTER_FAILURES.
      this.host.log(`[${trigger}] ${this.transientFailureCount} consecutive failures, rebuilding Dexcom client`);
      this.client = null;
    }
    if (this.transientFailureCount >= WARN_AFTER_FAILURES) {
      // Until this, a device that simply can't reach Dexcom looked identical to a healthy one for
      // the whole noDataTimeoutMin window (20 min by default) - the tile kept showing its last
      // reading with no indication anything was wrong. Cleared by the next successful tick's own
      // setWarning(null).
      this.host.setWarning('Cannot reach Dexcom Share right now - retrying');
    }
    return delay;
  }

  /**
   * Corrected reading time - see timestamp.ts for why `.datetime` itself can't be trusted.
   * Falls back to the (possibly wrong) library value only if the raw DT field isn't available
   * (e.g. a test double that doesn't bother providing one).
   */
  private readingTimeMs(reading: DexcomReadingLike): number {
    const raw = reading.json?.DT;
    const corrected = raw ? parseCorrectedEpoch(raw) : null;
    if (raw && corrected === null) {
      // Only reachable if a future dexcom-share-client release changes the raw DT shape -
      // worth a log line since it means readingTimeMs is silently back on the library's own
      // (confirmed-buggy for offset-bearing DT values) .datetime, see timestamp.ts.
      this.host.error('[dexcom] unrecognized DT format, falling back to library .datetime', raw);
    }
    return corrected ?? reading.datetime.getTime();
  }

  private buildTokens(mgDl: number, mmolL: number, trendDescription: string): GlucoseTokens {
    return {
      glucose: toDisplay(mgDl, this.host.getUnits()),
      mmol: mmolL,
      trend: trendDescription,
    };
  }

  /**
   * Force the derived alarm capabilities to their "nothing wrong" state, exactly once, without
   * firing anything. Shared by the two paths that reach the first successful tick with nothing
   * classifiable: no readings at all (below), and a reading that's already stale the first time
   * this app sees it (applyReadings). Deliberately leaves lastSeverity/lastRapidChange at their
   * initial values, so the first genuinely fresh reading is still classified as a real edge.
   */
  private initializeAlarmCapabilities(): void {
    if (this.capabilitiesInitialized) return;
    const alarms = severityToAlarms('normal');
    this.host.setCapability('alarm_urgent_low', alarms.urgentLow);
    this.host.setCapability('alarm_low', alarms.low);
    this.host.setCapability('alarm_high', alarms.high);
    this.host.setCapability('alarm_rapid_change', false);
    this.snapshot.alarms = { ...this.snapshot.alarms, ...alarms, rapidChange: false };
    this.capabilitiesInitialized = true;
  }

  /** Returns whether this poll produced a genuinely new reading - see computeNextPollDelayMs. */
  private applyReadings(readings: DexcomReadingLike[]): boolean {
    if (readings.length === 0) {
      // A successful poll can legitimately return nothing - most often a freshly paired account
      // whose sensor session hasn't produced a reading yet (driver.ts's own pairing check treats
      // exactly this as a valid login), or one whose last reading has aged out of the 24-hour
      // request window entirely. There's nothing to classify, but the alarm capabilities must
      // still be written once so Homey's own defaults don't linger unset on the device tile -
      // the same reason the !capabilitiesInitialized force-write below exists. Without this, that
      // force-write is unreachable on a device that has never returned a reading, and only
      // alarm_no_data (set by applyNoDataAlarm, which runs every tick regardless) would ever be
      // written at all. measure_glucose/glucose_trend are deliberately left alone: unlike the
      // alarms, they have no meaningful "nothing wrong" value to assert without a reading.
      this.initializeAlarmCapabilities();
      return false;
    }
    const latest = readings[0];
    // readings is newest-first; reversed puts latest last, so its corrected time is computed
    // exactly once here (each readingTimeMs() call can log a diagnostic on a parse miss -
    // computing it separately for `latest` again below would double up that log needlessly).
    const history: HistoryPoint[] = readings
      .slice()
      .reverse()
      .map((r) => ({ t: this.readingTimeMs(r), v: r.mgDl }));
    const latestTimeMs = history[history.length - 1].t;

    this.snapshot = {
      ...this.snapshot,
      mgDl: latest.mgDl,
      mmolL: latest.mmolL,
      trendDirection: latest.trendDirection,
      trendDescription: latest.trendDescription,
      updatedAt: latestTimeMs,
      history,
    };

    const units = this.host.getUnits();
    this.host.setCapability('measure_glucose', toDisplay(latest.mgDl, units));

    if (!this.capabilitiesInitialized || latest.trendDirection !== this.lastTrendDirection) {
      this.host.setCapability('glucose_trend', latest.trendDirection);
      this.lastTrendDirection = latest.trendDirection;
    }

    // Dexcom keeps returning the same last-measured reading (same latestTimeMs) on every poll
    // for as long as it's still within the requested 24-hour window, even once it's stale
    // enough to trip alarm_no_data - readings is never empty just because nothing new arrived.
    // isNewReading gates severity/rapid-change re-evaluation below on that, not just
    // onGlucoseChanged: without it, a reading that applyNoDataAlarm() has already cleared back
    // to normal (see below) would get immediately reclassified right back to its old severity
    // on the very next tick, since classifyGlucose() only looks at the value, not its age -
    // an infinite fire/clear loop of e.g. onHigh every 5 minutes for as long as the device
    // stays stale and connected. (Deliberately not applied to measure_glucose/glucose_trend
    // above - those two just mirror the latest known reading verbatim, same as this app's own
    // stale-value display convention elsewhere - see CLAUDE.md's Architecture and Widget
    // sections.)
    const isNewReading = latestTimeMs !== this.lastReadingDatetime;
    if (isNewReading) {
      this.lastReadingDatetime = latestTimeMs;
      this.host.onGlucoseChanged?.(this.buildTokens(latest.mgDl, latest.mmolL, latest.trendDescription));
    }

    // A reading that is already past the no-data timeout the first time this app sees it - the
    // usual case being the very first tick after an app restart, where Dexcom hands back whatever
    // it last measured however long ago - is no more trustworthy as *current* status than one that
    // goes stale later, which applyNoDataAlarm() below already clears. Without this, the
    // !capabilitiesInitialized branch classifies it anyway: alarm_high goes true and onHigh fires,
    // then applyNoDataAlarm() clears the capability again microseconds later in the same tick. The
    // blip is momentary but the Flow trigger has already fired, for a reading that may be hours
    // old. Treating a stale reading as 'normal' still force-writes every alarm capability to false
    // on that first tick (so Homey's own defaults never linger unset) while firing nothing, and
    // leaves lastSeverity/lastRapidChange at their initial values, so the first genuinely fresh
    // reading is still classified as a real edge on its own merits.
    const stale = isStale(latestTimeMs, this.now(), this.noDataTimeoutMin());
    const severity = stale ? 'normal' : classifyGlucose(latest.mgDl, this.thresholds());
    if (!this.capabilitiesInitialized || (isNewReading && severity !== this.lastSeverity)) {
      const alarms = severityToAlarms(severity);
      this.host.setCapability('alarm_urgent_low', alarms.urgentLow);
      this.host.setCapability('alarm_low', alarms.low);
      this.host.setCapability('alarm_high', alarms.high);
      this.snapshot.alarms = { ...this.snapshot.alarms, ...alarms };
      if (severity !== this.lastSeverity) {
        const tokens = this.buildTokens(latest.mgDl, latest.mmolL, latest.trendDescription);
        if (severity === 'urgent_low') this.host.onUrgentLow?.(tokens);
        if (severity === 'low') this.host.onLow?.(tokens);
        if (severity === 'high') this.host.onHigh?.(tokens);
      }
      this.lastSeverity = severity;
    }

    const rapid = stale ? false : isRapidChange(latest.trendDirection);
    if (!this.capabilitiesInitialized || (isNewReading && rapid !== this.lastRapidChange)) {
      this.host.setCapability('alarm_rapid_change', rapid);
      this.snapshot.alarms = { ...this.snapshot.alarms, rapidChange: rapid };
      if (rapid && rapid !== this.lastRapidChange) {
        const direction = rapidChangeDirection(latest.trendDirection);
        if (direction) this.host.onRapidChange?.({ direction });
      }
      this.lastRapidChange = rapid;
    }

    this.capabilitiesInitialized = true;
    return isNewReading;
  }

  private applyNoDataAlarm(): void {
    const stale = isStale(this.snapshot.updatedAt, this.now(), this.noDataTimeoutMin());
    if (!this.noDataInitialized || stale !== this.lastNoData) {
      this.host.setCapability('alarm_no_data', stale);
      this.snapshot.alarms = { ...this.snapshot.alarms, noData: stale };
      if (stale && stale !== this.lastNoData) {
        const minutes = this.snapshot.updatedAt === null
          ? this.noDataTimeoutMin()
          : Math.round((this.now() - this.snapshot.updatedAt) / 60_000);
        this.host.onNoData?.({ minutes });
      }
      this.lastNoData = stale;
      this.noDataInitialized = true;
    }
    // A severity/rapid-change band derived from a reading that's now stale enough to trip
    // alarm_no_data is no longer trustworthy as *current* status - same principle as the
    // widget's own noData-wins-over-severity badge (see CLAUDE.md's Widget section). Cleared
    // once, on the edge into staleness, not every tick while stale - isNewReading above already
    // stops applyReadings() from reclassifying the same stale reading back on top of this.
    // Deliberately no onXxx trigger call here: there's no "cleared"/"returned to normal" Flow
    // trigger card for any of these, and going stale isn't the same event as glucose actually
    // returning to range.
    if (stale && (this.lastSeverity !== 'normal' || this.lastRapidChange)) {
      this.host.setCapability('alarm_urgent_low', false);
      this.host.setCapability('alarm_low', false);
      this.host.setCapability('alarm_high', false);
      this.host.setCapability('alarm_rapid_change', false);
      this.snapshot.alarms = {
        ...this.snapshot.alarms, urgentLow: false, low: false, high: false, rapidChange: false,
      };
      this.lastSeverity = 'normal';
      this.lastRapidChange = false;
    }
  }
}
