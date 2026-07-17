'use strict';

import {
  AlarmThresholds, DexcomPollerHost, GlucoseSnapshot, GlucoseTokens, HistoryPoint, Severity,
} from './types';
import {
  classifyGlucose, isRapidChange, isStale, rapidChangeDirection, severityToAlarms,
} from './glucoseAlarms';
import { toDisplay, toMgdl } from './units';
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
const HISTORY_MINUTES = 180;
const HISTORY_MAX_COUNT = 36;

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

  async start(): Promise<void> {
    this.stopped = false;
    await this.refreshConfig();
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

  /** Rebuild the client only if username/password/region actually changed. */
  async refreshConfig(): Promise<void> {
    const username = this.host.getSetting<string>('username') ?? '';
    const password = this.host.getSetting<string>('password') ?? '';
    const region = this.host.getSetting<string>('region') ?? 'us';
    const fingerprint = `${username} ${password} ${region}`;
    if (fingerprint !== this.credentialsFingerprint || !this.client) {
      this.credentialsFingerprint = fingerprint;
      this.client = await this.clientFactory({ username, password, region });
      this.transientFailureCount = 0;
    }
  }

  /** Rate-limited manual refresh entry point for the "Refresh glucose now" flow action. */
  async requestImmediateRefresh(): Promise<void> {
    const nowMs = this.now();
    if (this.lastTickAt !== null && nowMs - this.lastTickAt < MIN_REFRESH_GAP_MS) {
      return;
    }
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
    await this.tick('manual');
  }

  /**
   * Threshold settings are stored in whatever unit is currently active (mg/dL or mmol/L - see
   * CLAUDE.md's Units section), never canonical mg/dL by themselves. Each must be converted via
   * the device's own current unit before comparison against a reading's canonical mg/dL value -
   * skipping this silently misclassifies severity whenever mmol/L is the active unit (e.g. a
   * stored "3.9" read as if it meant 3.9 mg/dL instead of the ~70 mg/dL it actually represents).
   */
  private thresholds(): AlarmThresholds {
    const units = this.host.getUnits();
    const mgDl = (key: string, fallbackMgDl: number): number => {
      const value = this.host.getSetting<number>(key);
      return value === undefined ? fallbackMgDl : toMgdl(value, units);
    };
    return {
      urgentLowMgDl: mgDl('urgentLowThreshold', 55),
      lowMgDl: mgDl('lowThreshold', 70),
      highMgDl: mgDl('highThreshold', 180),
    };
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

  private async tick(trigger: string): Promise<void> {
    this.lastTickAt = this.now();
    if (!this.client) {
      await this.refreshConfig();
    }
    let nextDelay = NORMAL_INTERVAL_MS;
    try {
      const readings = await this.client!.getGlucoseReadings(HISTORY_MINUTES, HISTORY_MAX_COUNT);
      this.host.log(`[${trigger}] Dexcom poll succeeded, ${readings.length} reading(s)`);
      this.transientFailureCount = 0;
      this.host.setAvailable();
      this.host.setWarning(null);
      this.applyReadings(readings);
    } catch (error) {
      nextDelay = this.handleError(error, trigger);
    }
    this.applyNoDataAlarm();
    this.host.onSnapshotUpdated?.();
    this.scheduleNextTick(nextDelay);
  }

  private handleError(error: unknown, trigger: string): number {
    const errorType = (error as { errorType?: string } | null)?.errorType;
    if (errorType === 'AccountError') {
      this.host.error(`[${trigger}] Dexcom account error`, error);
      const message = 'Check Dexcom Share credentials in device settings';
      this.host.setUnavailable(message);
      this.host.setWarning(message);
      return ACCOUNT_ERROR_BACKOFF_MS;
    }
    this.host.error(`[${trigger}] Dexcom poll failed`, error);
    const delay = TRANSIENT_BACKOFF_MS[Math.min(this.transientFailureCount, TRANSIENT_BACKOFF_MS.length - 1)];
    this.transientFailureCount += 1;
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

  private applyReadings(readings: DexcomReadingLike[]): void {
    if (readings.length === 0) {
      // A successful poll can legitimately return nothing - most often a freshly paired account
      // whose sensor session hasn't produced a reading yet (driver.ts's own pairing check treats
      // exactly this as a valid login), or one whose last reading has aged out of the 180-minute
      // request window entirely. There's nothing to classify, but the alarm capabilities must
      // still be written once so Homey's own defaults don't linger unset on the device tile -
      // the same reason the !capabilitiesInitialized force-write below exists. Without this, that
      // force-write is unreachable on a device that has never returned a reading, and only
      // alarm_no_data (set by applyNoDataAlarm, which runs every tick regardless) would ever be
      // written at all. measure_glucose/glucose_trend are deliberately left alone: unlike the
      // alarms, they have no meaningful "nothing wrong" value to assert without a reading.
      this.initializeAlarmCapabilities();
      return;
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
    // for as long as it's still within the requested 180-minute window, even once it's stale
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
