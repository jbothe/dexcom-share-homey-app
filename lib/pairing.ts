'use strict';

import { Units } from './dexcom/types';
import { defaultUnitsForRegion, toDisplay } from './dexcom/units';
import { DEFAULT_THRESHOLDS_MGDL } from './dexcom/thresholds';

/**
 * This app supports unlimited devices, one per Dexcom Share account - unlike a
 * single-device-capped app, there is no shared-resource constraint here that would justify
 * refusing a second follower. The only thing pairing must reject is re-adding the exact same
 * Dexcom Share account twice.
 */
export const DUPLICATE_ACCOUNT_MESSAGE = 'This Dexcom Share account is already added as a follower.';

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
      // The Dexcom username, which is usually an email address, is deliberately the offered
      // name: it is the only thing that tells two followers apart at pair time, and this app is
      // explicitly built for multiple accounts (see this file's own header). It is a *default* -
      // the name is the user's to change on their own Homey afterward - so the alternatives
      // considered (masking it via maskUsername, or a generic driver-name default) were rejected
      // for making an unlimited-follower setup harder to read in exchange for hiding the user's
      // own address from their own dashboard. Worth revisiting only if the name turns out to
      // reach somewhere less private than the Homey it was paired on.
      name: candidate.username,
      data: { id: candidate.accountId },
      settings: {
        username: candidate.username,
        password: candidate.password,
        region: candidate.region,
        units,
        // Offered converted into this device's own inferred unit, not as the raw mg/dL numbers:
        // a device paired into mmol/L would otherwise hold mg/dL-scale numbers silently misread
        // as mmol/L everywhere they're used (alarm thresholds, the widget's shaded zones),
        // producing a wildly wrong result rather than a unit-conversion no-op.
        urgentLowThreshold: toDisplay(DEFAULT_THRESHOLDS_MGDL.urgentLowMgDl, units),
        lowThreshold: toDisplay(DEFAULT_THRESHOLDS_MGDL.lowMgDl, units),
        highThreshold: toDisplay(DEFAULT_THRESHOLDS_MGDL.highMgDl, units),
      },
    }],
  };
}
