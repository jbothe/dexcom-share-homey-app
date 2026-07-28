'use strict';

import Homey from 'homey';
import { DexcomPoller } from '../../lib/dexcom/DexcomPoller';
import { DexcomPollerHost, Units, WidgetSnapshot } from '../../lib/dexcom/types';
import {
  toDisplay, toMgdl, unitDecimals, unitLabel,
} from '../../lib/dexcom/units';
import { resolveThresholdsOnSave, thresholdsFromSettings } from '../../lib/dexcom/thresholds';
import { createDexcomClient } from '../../lib/dexcom/client';

interface DexcomFollowApp extends Homey.App {
  broadcastDeviceState(device: {
    getData(): { id: string };
    getName(): string;
    getUnits(): Units;
    getWidgetSnapshot(): WidgetSnapshot | null;
  }): void;
}

const CAPABILITIES = [
  'measure_glucose', 'glucose_trend', 'glucose_data_age', 'alarm_urgent_low', 'alarm_low',
  'alarm_high', 'alarm_rapid_change', 'alarm_no_data',
];

type SettingValue = boolean | string | number | undefined | null;

module.exports = class FollowerDevice extends Homey.Device {

  private poller!: DexcomPoller;

  private glucoseChangedTrigger!: Homey.FlowCardTriggerDevice;

  private urgentLowTrigger!: Homey.FlowCardTriggerDevice;

  private lowTrigger!: Homey.FlowCardTriggerDevice;

  private highTrigger!: Homey.FlowCardTriggerDevice;

  private rapidChangeTrigger!: Homey.FlowCardTriggerDevice;

  private noDataTrigger!: Homey.FlowCardTriggerDevice;

  /**
   * Homey's onSettings fires before the new values are persisted - this.getSetting()
   * during that call still returns the OLD settings. newSettings is cached here for the
   * duration of the poller.refreshConfig() call it triggers, mirroring chargeiq's device.ts.
   */
  private pendingSettings: Record<string, SettingValue> | null = null;

  async onInit() {
    await this.ensureCapabilities();

    this.glucoseChangedTrigger = this.homey.flow.getDeviceTriggerCard('glucose_changed');
    this.urgentLowTrigger = this.homey.flow.getDeviceTriggerCard('urgent_low_detected');
    this.lowTrigger = this.homey.flow.getDeviceTriggerCard('low_detected');
    this.highTrigger = this.homey.flow.getDeviceTriggerCard('high_detected');
    this.rapidChangeTrigger = this.homey.flow.getDeviceTriggerCard('rapid_change_detected');
    this.noDataTrigger = this.homey.flow.getDeviceTriggerCard('no_data_detected');

    this.poller = new DexcomPoller({
      host: this.buildHost(),
      clientFactory: createDexcomClient,
    });
    await this.refreshCapabilityOptions();
    this.poller.start().catch((err) => this.error('Initial Dexcom poll failed', err));

    this.log(`FollowerDevice ${this.getData().id} initialised`);
  }

  /** This device's own display unit preference (a device setting, not app-wide - see CLAUDE.md). */
  getUnits(): Units {
    return (this.getSetting('units') as Units | undefined) ?? 'mgdl';
  }

  async onSettings({ oldSettings, newSettings, changedKeys }: {
    oldSettings: Record<string, SettingValue>;
    newSettings: Record<string, SettingValue>;
    changedKeys: string[];
  }) {
    // Units and thresholds share one settings form, so a single save can change both - see
    // lib/dexcom/thresholds.ts for how an untouched threshold is carried across a unit change.
    const resolved = resolveThresholdsOnSave({ oldSettings, newSettings, changedKeys });
    if ('error' in resolved) throw new Error(resolved.error);
    const { thresholds, unitsChanged } = resolved;

    this.pendingSettings = { ...newSettings, ...thresholds };
    try {
      await this.poller?.refreshConfig();
    } finally {
      this.pendingSettings = null;
    }

    if (unitsChanged) {
      // Deferred to the next tick: Homey persists `newSettings` verbatim (this save's raw,
      // unconverted numbers for any threshold left untouched) immediately after this handler
      // resolves. Calling setSettings() again synchronously from inside onSettings itself would
      // race that persist and just get overwritten by it, rather than the other way around -
      // unconfirmed on a real Homey (see CLAUDE.md's "Not yet verified"), but a one-shot
      // setTimeout(0) reliably lands after Homey's own synchronous commit either way.
      // eslint-disable-next-line homey-app/global-timers -- one-shot, nothing to clear
      setTimeout(() => {
        this.setSettings(thresholds)
          .then(() => this.refreshCapabilityOptions())
          .then(() => (this.homey.app as DexcomFollowApp).broadcastDeviceState(this))
          .catch(this.error);
      }, 0);
    }
  }

  async onDeleted() {
    this.poller?.stop();
  }

  /**
   * Stop polling when this device is torn down but not deleted - an app update/restart or the
   * device being disabled. Mostly belt-and-braces, since the app process usually dies with it,
   * but onDeleted alone leaves the self-rearming timer running in every path that isn't an
   * outright removal.
   */
  async onUninit() {
    this.poller?.stop();
  }

  /**
   * Read model for app.ts's widget broadcast - both units included, unit-agnostic, plus all
   * three thresholds (converted to canonical mg/dL, same as the rest of the snapshot) so the
   * widget can shade its chart's severity zones without a separate settings lookup.
   */
  getWidgetSnapshot(): WidgetSnapshot | null {
    const snapshot = this.poller?.getSnapshot();
    if (!snapshot) return null;
    return {
      ...snapshot,
      // Same shared resolver the poller's own severity classification uses, so the widget's
      // shaded zones can't drift from the alarm bands they're meant to depict - and so a missing
      // setting falls back to the documented default instead of converting undefined into a NaN
      // bound, which reaches the widget as a zone rect with NaN geometry and silently fails to
      // draw rather than erroring anywhere.
      ...thresholdsFromSettings((key) => this.getSetting(key), this.getUnits()),
    };
  }

  /**
   * `glucose_data_age` is set from here rather than from the poller itself: app.ts calls this
   * every time it computes a widget broadcast (both the immediate post-tick push and the 60s
   * periodic one, see broadcastDeviceState) so the capability's value always matches what the
   * dashboard shows at that same moment, not just at the (much less frequent) 5-minute poll
   * cadence - a tick-only update would drift stale between polls exactly like measure_glucose
   * would if it only updated once every 5 minutes.
   *
   * A null `minutes` (minutesSinceReading's answer while no reading has ever arrived) is
   * deliberately left unwritten rather than coerced to a number. Homey's own unset value for a
   * numeric capability is already null, which the tile renders as unknown - the honest display
   * for "there is no reading to measure the age of". Do NOT be tempted to write 0 here to make
   * the capability always-present, the way initializeAlarmCapabilities() force-writes the alarms
   * (see DexcomPoller): 0 reads as "the data is 0 minutes old", i.e. perfectly fresh, which is
   * the exact opposite of the truth on a device that has never reported. The alarms differ
   * because false genuinely is their "nothing wrong" value; this capability has no such value,
   * which is the same reason measure_glucose/glucose_trend are left unwritten on an empty poll.
   * `updatedAt` never returns to null once set, so this only ever applies before the first
   * reading - never as a regression from a device that was previously reporting.
   */
  setDataAgeMinutes(minutes: number | null): void {
    if (minutes !== null && this.hasCapability('glucose_data_age')) {
      this.setCapabilityValue('glucose_data_age', minutes).catch(this.error);
    }
  }

  private async refreshCapabilityOptions(): Promise<void> {
    const units = this.getUnits();
    await this.setCapabilityOptions('measure_glucose', {
      units: { en: unitLabel(units) },
      decimals: unitDecimals(units),
    }).catch(this.error);
    const snapshot = this.poller?.getSnapshot();
    if (snapshot?.mgDl !== null && snapshot?.mgDl !== undefined) {
      await this.setCapabilityValue('measure_glucose', toDisplay(snapshot.mgDl, units)).catch(this.error);
    }
  }

  // --- Flow card entry points -------------------------------------------------

  flowGlucoseAbove(value: number): boolean {
    const mgDl = this.poller?.getSnapshot().mgDl;
    if (mgDl === null || mgDl === undefined) return false;
    return mgDl > toMgdl(value, this.getUnits());
  }

  flowGlucoseBelow(value: number): boolean {
    const mgDl = this.poller?.getSnapshot().mgDl;
    if (mgDl === null || mgDl === undefined) return false;
    return mgDl < toMgdl(value, this.getUnits());
  }

  flowTrendIs(direction: string): boolean {
    return this.poller?.getSnapshot().trendDirection === direction;
  }

  flowRefreshNow(): Promise<void> {
    return this.poller.requestImmediateRefresh();
  }

  private async ensureCapabilities() {
    for (const cap of CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
  }

  /** Adapter implementing the poller's minimal host surface. */
  private buildHost(): DexcomPollerHost {
    return {
      setCapability: (cap, value) => {
        if (this.hasCapability(cap)) this.setCapabilityValue(cap, value as string | number | boolean).catch(this.error);
      },
      getSetting: <T>(key: string) => (
        this.pendingSettings && key in this.pendingSettings ? this.pendingSettings[key] : this.getSetting(key)
      ) as T,
      getUnits: () => this.getUnits(),
      setAvailable: () => {
        this.setAvailable().catch(this.error);
      },
      setUnavailable: (msg) => {
        this.setUnavailable(msg).catch(this.error);
      },
      setWarning: (msg) => {
        (msg ? this.setWarning(msg) : this.unsetWarning()).catch(this.error);
      },
      log: (...args) => this.homey.app.log(...args),
      error: (...args) => this.homey.app.error(...args),
      onGlucoseChanged: (tokens) => {
        this.glucoseChangedTrigger.trigger(this, tokens, {}).catch(this.error);
      },
      onUrgentLow: (tokens) => {
        this.urgentLowTrigger.trigger(this, { glucose: tokens.glucose, mmol: tokens.mmol }, {}).catch(this.error);
      },
      onLow: (tokens) => {
        this.lowTrigger.trigger(this, { glucose: tokens.glucose, mmol: tokens.mmol }, {}).catch(this.error);
      },
      onHigh: (tokens) => {
        this.highTrigger.trigger(this, { glucose: tokens.glucose, mmol: tokens.mmol }, {}).catch(this.error);
      },
      onRapidChange: (tokens) => {
        this.rapidChangeTrigger.trigger(this, tokens, {}).catch(this.error);
      },
      onNoData: (tokens) => {
        this.noDataTrigger.trigger(this, tokens, {}).catch(this.error);
      },
      onSnapshotUpdated: () => {
        (this.homey.app as DexcomFollowApp).broadcastDeviceState(this);
      },
    };
  }

};
