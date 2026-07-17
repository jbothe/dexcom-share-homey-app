'use strict';

import { Units } from './types';

/**
 * Mirrors dexcom-share-client's own MMOL_L_CONVERSION_FACTOR constant. Not imported directly:
 * dexcom-share-client is ESM-only and this module must stay a plain synchronous, dependency-free
 * helper (used by device.ts, app.ts, and the widget's extracted logic block alike).
 */
const MMOL_L_CONVERSION_FACTOR = 0.0555;

/** Same rounding convention dexcom-share-client's own GlucoseReading.mmolL uses. */
export function mgdlToMmol(mgdl: number): number {
  return Math.round(mgdl * MMOL_L_CONVERSION_FACTOR * 10) / 10;
}

export function mmolToMgdl(mmol: number): number {
  return Math.round(mmol / MMOL_L_CONVERSION_FACTOR);
}

/** Convert a canonical mg/dL value into the given display unit, rounded for display. */
export function toDisplay(mgdl: number, unit: Units): number {
  return unit === 'mmol' ? mgdlToMmol(mgdl) : Math.round(mgdl);
}

/** Convert a value entered/emitted in the given display unit back to canonical mg/dL. */
export function toMgdl(value: number, unit: Units): number {
  return unit === 'mmol' ? mmolToMgdl(value) : Math.round(value);
}

export function unitLabel(unit: Units): string {
  return unit === 'mmol' ? 'mmol/L' : 'mg/dL';
}

export function unitDecimals(unit: Units): number {
  return unit === 'mmol' ? 1 : 0;
}

/**
 * Sensible initial unit for one device, inferred from its own Dexcom Share account's region at
 * pairing time - mirrors what the Dexcom mobile app itself displays for that region (US/Japan
 * show mg/dL, everywhere else shows mmol/L). Units are per-device (see CLAUDE.md's Units
 * section), so every device gets this inference at pair time, from its own region; it is only
 * ever an initial default, and never revisits a preference the user has since set on the device
 * settings form. Applied by lib/pairing.ts's resolvePairList.
 */
export function defaultUnitsForRegion(region: string): Units {
  return region === 'ous' ? 'mmol' : 'mgdl';
}
