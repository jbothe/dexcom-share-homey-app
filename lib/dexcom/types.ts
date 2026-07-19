'use strict';

/** Display unit preference, a per-device setting (see CLAUDE.md's Units section). */
export type Units = 'mgdl' | 'mmol';

/** Derived severity band for a single glucose reading, mg/dL-based. */
export type Severity = 'urgent_low' | 'low' | 'high' | 'normal';

/** Per-device alarm thresholds, always stored/compared in mg/dL. */
export interface AlarmThresholds {
  urgentLowMgDl: number;
  lowMgDl: number;
  highMgDl: number;
}

/** Boolean alarm capability values for one device at one point in time. */
export interface AlarmState {
  urgentLow: boolean;
  low: boolean;
  high: boolean;
  rapidChange: boolean;
  noData: boolean;
}

/** One point of the widget's 3h history, oldest-to-newest, mg/dL. */
export interface HistoryPoint {
  t: number;
  v: number;
}

/** Flow trigger tokens for glucose-value triggers, value in the current display unit. */
export interface GlucoseTokens {
  glucose: number;
  mmol: number;
  trend: string;
}

/** Poller's read model of a device's current state, unit-agnostic (both mg/dL and mmol/L included). */
export interface GlucoseSnapshot {
  mgDl: number | null;
  mmolL: number | null;
  /** Raw DEXCOM_TREND_DIRECTIONS key (e.g. "Flat", "DoubleUp"); consumers derive arrow/label locally. */
  trendDirection: string | null;
  trendDescription: string | null;
  updatedAt: number | null;
  history: HistoryPoint[];
  alarms: AlarmState;
}

/**
 * Read model for app.ts's widget broadcast: a snapshot plus this device's own thresholds
 * (canonical mg/dL, same as the rest of the snapshot) so the widget can shade its chart's
 * severity zones without a separate settings lookup.
 */
export type WidgetSnapshot = GlucoseSnapshot & AlarmThresholds;

/** Host interface DexcomPoller is driven through, so it stays Homey-independent. */
export interface DexcomPollerHost {
  setCapability(capabilityId: string, value: unknown): void;
  getSetting<T>(key: string): T | undefined;
  /** This device's own display unit preference (device.ts reads this off its own settings). */
  getUnits(): Units;
  setAvailable(): void;
  setUnavailable(message: string): void;
  setWarning(message: string | null): void;
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  onGlucoseChanged?(tokens: GlucoseTokens): void;
  onUrgentLow?(tokens: GlucoseTokens): void;
  onLow?(tokens: GlucoseTokens): void;
  onHigh?(tokens: GlucoseTokens): void;
  onRapidChange?(tokens: { direction: 'rising' | 'falling' }): void;
  onNoData?(tokens: { minutes: number }): void;
  /**
   * Called at the end of every tick (success or failure), after the snapshot/capabilities for
   * that tick are fully settled - lets the app push a widget broadcast immediately rather than
   * only on its own fixed periodic interval, which otherwise leaves the widget showing an
   * empty/stale snapshot for however long is left until that timer's next firing, even though
   * this device's own poll may have already completed. See app.ts's broadcastDeviceState().
   */
  onSnapshotUpdated?(): void;
}
