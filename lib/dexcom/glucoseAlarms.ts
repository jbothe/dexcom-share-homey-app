'use strict';

import { AlarmThresholds, Severity } from './types';

/**
 * Derive a single severity band from a canonical mg/dL reading. Urgent-low takes
 * precedence over low, and low/high never overlap - a very-low reading sets only
 * alarm_urgent_low, never both urgent-low and low simultaneously.
 */
export function classifyGlucose(mgDl: number, thresholds: AlarmThresholds): Severity {
  if (mgDl <= thresholds.urgentLowMgDl) return 'urgent_low';
  if (mgDl <= thresholds.lowMgDl) return 'low';
  if (mgDl >= thresholds.highMgDl) return 'high';
  return 'normal';
}

export function severityToAlarms(severity: Severity): { urgentLow: boolean; low: boolean; high: boolean } {
  return {
    urgentLow: severity === 'urgent_low',
    low: severity === 'low',
    high: severity === 'high',
  };
}

/** Dexcom's own "rapid" trend tier - the two double-arrow directions. */
export function isRapidChange(trendDirection: string | null): boolean {
  return trendDirection === 'DoubleUp' || trendDirection === 'DoubleDown';
}

export function rapidChangeDirection(trendDirection: string | null): 'rising' | 'falling' | null {
  if (trendDirection === 'DoubleUp') return 'rising';
  if (trendDirection === 'DoubleDown') return 'falling';
  return null;
}

/** Whether the most recent reading is older than the configured no-data timeout. */
export function isStale(lastReadingAt: number | null, now: number, timeoutMin: number): boolean {
  if (lastReadingAt === null) return true;
  return now - lastReadingAt > timeoutMin * 60_000;
}

/**
 * Whole minutes since the last reading, for the `glucose_data_age` capability. Mirrors the
 * widget's own `fmtAgo` rounding/clamping exactly (widgets/glucose-dashboard/public/index.html)
 * so the capability value always matches what the dashboard displays, not just approximates it.
 * `null` while no reading has ever arrived (nothing to measure the age of yet).
 */
export function minutesSinceReading(lastReadingAt: number | null, now: number): number | null {
  if (lastReadingAt === null) return null;
  return Math.max(0, Math.round((now - lastReadingAt) / 60_000));
}
