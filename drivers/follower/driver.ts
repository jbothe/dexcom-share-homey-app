'use strict';

import Homey from 'homey';
import { resolvePairList, maskUsername, PendingFollowerCredentials } from '../../lib/pairing';
import { verifyDexcomLogin, describeDexcomError, isRecognizedDexcomError } from '../../lib/dexcom/client';

/** Minimal surface this file needs from the device a flow card runs against. */
interface FlowDevice {
  flowGlucoseAbove(value: number): boolean;
  flowGlucoseBelow(value: number): boolean;
  flowTrendIs(direction: string): boolean;
  flowRefreshNow(): Promise<void>;
}

module.exports = class FollowerDriver extends Homey.Driver {

  async onInit() {
    const { flow } = this.homey;

    flow.getConditionCard('glucose_above')
      .registerRunListener((args: { device: FlowDevice; value: number }) => args.device.flowGlucoseAbove(args.value));
    flow.getConditionCard('glucose_below')
      .registerRunListener((args: { device: FlowDevice; value: number }) => args.device.flowGlucoseBelow(args.value));
    flow.getConditionCard('trend_is')
      .registerRunListener((args: { device: FlowDevice; direction: string }) => args.device.flowTrendIs(args.direction));

    flow.getActionCard('refresh_now')
      .registerRunListener((args: { device: FlowDevice }) => args.device.flowRefreshNow());

    this.log('FollowerDriver initialised');
  }

  async onPair(session: Homey.Driver.PairSession) {
    let pendingCredentials: PendingFollowerCredentials | null = null;

    this.log('[pair] onPair started');

    session.setHandler('login', async (data: { username: string; password: string; region: string }) => {
      this.log('[pair] login handler invoked', { username: maskUsername(data.username), region: data.region });
      try {
        const { accountId } = await verifyDexcomLogin(data);
        pendingCredentials = { ...data, accountId };
        this.log('[pair] login succeeded, credentials cached for list_devices', {
          username: maskUsername(data.username), accountId,
        });
        return true;
      } catch (err) {
        if (isRecognizedDexcomError(err)) {
          const { errorType, errorEnum } = err as { errorType?: string; errorEnum?: string };
          this.error('[pair] Dexcom login failed', { errorType, errorEnum });
        } else {
          // Unrecognised failure shape - the stack trace is the only clue to what broke.
          this.error('[pair] Dexcom login failed', err);
        }
        throw new Error(describeDexcomError(err));
      }
    });

    session.setHandler('list_devices', async () => {
      this.log('[pair] list_devices handler invoked', {
        hasPendingCredentials: pendingCredentials !== null,
      });
      if (!pendingCredentials) {
        // Reaching here without pendingCredentials means this session's login handler
        // above was never called (or hasn't resolved yet) before advancing - e.g. a stray
        // "next" navigation button skipping the login step. See driver.compose.json's
        // "login" pair entry and pair/login.html's own comment for the specific bug this
        // guards against (Homey rendering its own default Continue button alongside the
        // form's, which could be tapped instead and bypass the login handler entirely).
        this.error('[pair] list_devices called with no cached login - login step was likely skipped');
        throw new Error('Please sign in first.');
      }
      const existingAccountIds = this.getDevices().map((d) => d.getData().id as string);

      this.log('[pair] resolving pair list', {
        existingFollowerCount: existingAccountIds.length,
        accountId: pendingCredentials.accountId,
        region: pendingCredentials.region,
      });
      const result = resolvePairList(existingAccountIds, pendingCredentials);
      if ('error' in result) {
        this.log('[pair] resolvePairList rejected', result.error);
        throw new Error(result.error);
      }
      this.log('[pair] list_devices returning', { deviceCount: result.devices.length });
      return result.devices;
    });
  }

};
