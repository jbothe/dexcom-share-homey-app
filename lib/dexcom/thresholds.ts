'use strict';

import { AlarmThresholds, Units } from './types';
import { toDisplay, toMgdl } from './units';

export const THRESHOLD_KEYS = ['urgentLowThreshold', 'lowThreshold', 'highThreshold'] as const;

export type ThresholdKey = typeof THRESHOLD_KEYS[number];

export type ThresholdValues = Record<ThresholdKey, number>;

/**
 * Canonical mg/dL fallbacks, mirroring driver.settings.compose.json's own hardcoded `value`
 * fields. The single source for all three consumers - DexcomPoller's severity classification,
 * device.ts's widget snapshot, and pairing.ts's initial per-device settings - which each carried
 * their own copy of these numbers before, one of them (the widget snapshot) by simply having no
 * fallback at all. That schema file can only hold one static default, expressed in mg/dL;
 * pairing.ts converts these into the unit inferred for the new device's own region.
 */
export const DEFAULT_THRESHOLDS_MGDL: AlarmThresholds = {
  urgentLowMgDl: 55,
  lowMgDl: 70,
  highMgDl: 180,
};

/**
 * Read the three threshold settings and convert them into canonical mg/dL for comparison against
 * a reading. Thresholds are stored in whatever unit is currently active (see CLAUDE.md's Units
 * section), never canonical mg/dL by themselves, so skipping the conversion silently
 * misclassifies severity whenever mmol/L is the active unit (a stored "3.9" read as if it meant
 * 3.9 mg/dL rather than the ~70 mg/dL it represents) - a bug that has shipped here once already.
 *
 * A setting that is absent or not a finite number falls back to DEFAULT_THRESHOLDS_MGDL rather
 * than being converted: `toMgdl(undefined)` yields NaN, which propagates silently (a NaN bound
 * classifies every reading as normal, and reaches the widget as a NaN-geometry zone rect that
 * simply fails to draw) instead of failing loudly anywhere.
 */
export function thresholdsFromSettings(
  read: (key: ThresholdKey) => unknown,
  units: Units,
): AlarmThresholds {
  const mgDl = (key: ThresholdKey, fallbackMgDl: number): number => {
    const raw = read(key);
    return typeof raw === 'number' && Number.isFinite(raw) ? toMgdl(raw, units) : fallbackMgDl;
  };
  return {
    urgentLowMgDl: mgDl('urgentLowThreshold', DEFAULT_THRESHOLDS_MGDL.urgentLowMgDl),
    lowMgDl: mgDl('lowThreshold', DEFAULT_THRESHOLDS_MGDL.lowMgDl),
    highMgDl: mgDl('highThreshold', DEFAULT_THRESHOLDS_MGDL.highMgDl),
  };
}

/**
 * Thrown straight to Homey's device-settings UI by device.ts. A plain English string rather than
 * a translation key, matching lib/pairing.ts's own DUPLICATE_ACCOUNT_MESSAGE - see CLAUDE.md's
 * Localization section on the two mechanisms this app uses, neither of which covers a string
 * thrown from a settings handler.
 */
export const THRESHOLD_ORDER_MESSAGE = 'Thresholds must be in order: Urgent Low < Low < High.';

export interface ThresholdSaveInput {
  oldSettings: Record<string, unknown>;
  newSettings: Record<string, unknown>;
  changedKeys: string[];
}

export interface ResolvedThresholds {
  thresholds: ThresholdValues;
  units: Units;
  unitsChanged: boolean;
}

/**
 * Decide what the three threshold settings should hold after a settings save, given that units
 * and thresholds live on the same form and so can both change in a single save. Pure so it can
 * be unit-tested without the Homey runtime (device.ts's onSettings is a thin adapter around it),
 * mirroring lib/pairing.ts's own resolvePairList and its `{ error } | { ... }` result shape.
 *
 * A threshold the user did NOT touch in a save that also changed units is still expressed in the
 * old unit's numbers (an untouched "70" meant 70 mg/dL), so it's converted into the new unit. One
 * the user DID edit in that same save is trusted as already being in the unit they just picked,
 * since that's the unit selected on the very form they submitted.
 *
 * Ordering is validated in canonical mg/dL, never in the display unit - the stored numbers alone
 * are meaningless without knowing which unit they're in (see CLAUDE.md's Units section).
 */
export function resolveThresholdsOnSave(
  { oldSettings, newSettings, changedKeys }: ThresholdSaveInput,
): { error: string } | ResolvedThresholds {
  const oldUnits = (oldSettings.units as Units | undefined) ?? 'mgdl';
  const newUnits = (newSettings.units as Units | undefined) ?? oldUnits;
  const unitsChanged = newUnits !== oldUnits;

  const thresholds = Object.fromEntries(THRESHOLD_KEYS.map((key) => [
    key,
    unitsChanged && !changedKeys.includes(key)
      ? toDisplay(toMgdl(oldSettings[key] as number, oldUnits), newUnits)
      : newSettings[key] as number,
  ])) as ThresholdValues;

  const urgentLowMgDl = toMgdl(thresholds.urgentLowThreshold, newUnits);
  const lowMgDl = toMgdl(thresholds.lowThreshold, newUnits);
  const highMgDl = toMgdl(thresholds.highThreshold, newUnits);
  if (!(urgentLowMgDl < lowMgDl && lowMgDl < highMgDl)) {
    return { error: THRESHOLD_ORDER_MESSAGE };
  }

  return { thresholds, units: newUnits, unitsChanged };
}
