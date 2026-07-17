'use strict';

import { Units } from './dexcom/types';
import { defaultUnitsForRegion, toDisplay } from './dexcom/units';

/**
 * This app supports unlimited devices, one per Dexcom Share account - unlike a
 * single-device-capped app, there is no shared-resource constraint here that would justify
 * refusing a second follower. The only thing pairing must reject is re-adding the exact same
 * Dexcom Share account twice.
 */
export const DUPLICATE_ACCOUNT_MESSAGE = 'This Dexcom Share account is already added as a follower.';

/**
 * Threshold defaults, canonical mg/dL - mirrors driver.settings.compose.json's own hardcoded
 * `value` fields for urgentLowThreshold/lowThreshold/highThreshold. That schema file can only
 * ever hold one static default, expressed in mg/dL; a new device is offered these converted into
 * the unit inferred for that device's own region, rather than the raw mg/dL numbers verbatim -
 * otherwise a device paired into mmol/L would end up with mg/dL-scale numbers silently misread as
 * mmol/L everywhere they're used (alarm thresholds, the widget's sparkline domain), producing a
 * wildly wrong result rather than a unit-conversion no-op.
 */
const DEFAULT_URGENT_LOW_MGDL = 55;
const DEFAULT_LOW_MGDL = 70;
const DEFAULT_HIGH_MGDL = 180;

/**
 * Never log a raw username (and never a password at all) - only enough to tell one pairing
 * attempt apart from another in the log. Lives here rather than in driver.ts so it's reachable
 * from a unit test: driver.ts is `module.exports = class`, per the Homey template, and so can't
 * also carry a named export.
 */
export function maskUsername(username: string): string {
  if (username.length <= 2) return '*'.repeat(username.length);
  return username.slice(0, 2) + '*'.repeat(username.length - 2);
}

export interface PendingFollowerCredentials {
  username: string;
  password: string;
  region: string;
  accountId: string;
}

/** One selectable follower for Homey's list_devices pairing step. */
export interface PairDevice {
  name: string;
  data: { id: string };
  settings: {
    username: string;
    password: string;
    region: string;
    units: Units;
    urgentLowThreshold: number;
    lowThreshold: number;
    highThreshold: number;
  };
}

/**
 * Decide what the pairing `list_devices` step should return. Pure so it can be unit-tested
 * without the Homey runtime (driver.ts is a thin adapter around it).
 *
 * - If the candidate's Dexcom Share accountId is already paired, refuse: `{ error }`.
 * - Otherwise offer the one newly-authenticated account as a selectable device. Units and
 *   threshold defaults are both per-device (see CLAUDE.md's Units section) - inferred from
 *   *this* candidate's own region, the same way the Dexcom mobile app itself would display for
 *   that region, independent of any other already-paired follower's unit choice.
 */
export function resolvePairList(
  existingAccountIds: string[],
  candidate: PendingFollowerCredentials,
): { error: string } | { devices: PairDevice[] } {
  if (existingAccountIds.includes(candidate.accountId)) {
    return { error: DUPLICATE_ACCOUNT_MESSAGE };
  }
  const units = defaultUnitsForRegion(candidate.region);
  return {
    devices: [{
      name: candidate.username,
      data: { id: candidate.accountId },
      settings: {
        username: candidate.username,
        password: candidate.password,
        region: candidate.region,
        units,
        urgentLowThreshold: toDisplay(DEFAULT_URGENT_LOW_MGDL, units),
        lowThreshold: toDisplay(DEFAULT_LOW_MGDL, units),
        highThreshold: toDisplay(DEFAULT_HIGH_MGDL, units),
      },
    }],
  };
}
