'use strict';

import Homey from 'homey';
import { Units, WidgetSnapshot } from './lib/dexcom/types';
import { minutesSinceReading } from './lib/dexcom/glucoseAlarms';

const WIDGET_BROADCAST_MS = 60_000;
const WIDGET_ID = 'glucose-dashboard';

/** Minimal surface this file needs from a paired follower device. */
interface FollowerDeviceLike {
  getData(): { id: string };
  getName(): string;
  getUnits(): Units;
  getWidgetSnapshot(): WidgetSnapshot | null;
  setDataAgeMinutes(minutes: number | null): void;
}

/** Flat single-device shape both the realtime push and the widget's pull fallback send. */
type WidgetPayload = WidgetSnapshot & {
  units: Units;
  id: string;
  name: string;
};

/**
 * Each paired follower device owns its own DexcomPoller and its own unit preference (a device
 * setting, see CLAUDE.md's Units section) - the app itself holds no
 * shared Dexcom service and no shared settings, only the widget broadcast, which pushes every
 * device's own already-polled state onto one shared realtime channel (see broadcastDeviceState).
 */
module.exports = class DexcomFollowApp extends Homey.App {

  private widgetBroadcast?: ReturnType<typeof setInterval>;

  async onInit() {
    this.registerWidgetDevicePicker();
    this.startWidgetBroadcast();
    this.log('DexcomFollowApp initialised');
  }

  async onUninit() {
    if (this.widgetBroadcast) clearInterval(this.widgetBroadcast);
  }

  /**
   * The widget identifies its bound follower via its own "device" autocomplete setting
   * (widget.compose.json), not Homey's native `"devices"` widget setting - that native picker
   * turned out to hand the widget Homey's own top-level device id, which this app has no
   * documented way to translate back into one of its own Device instances (confirmed on a real
   * device: the id-matching lookup that used to live here always came back `undefined`/no
   * match - see CLAUDE.md's Widget section for the full story). This autocomplete list is
   * populated with this app's own `data.id` (the Dexcom accountId, already the identifier
   * `getWidgetStateForDeviceId` and every other per-device lookup in this app use), an id space
   * this app fully owns end-to-end - modeled directly on a published, working app that solves
   * the exact same problem the same way (RonnyWinkler/homey.tesla's car_main widget).
   */
  private registerWidgetDevicePicker(): void {
    this.homey.dashboards.getWidget(WIDGET_ID).registerSettingAutocompleteListener(
      'device',
      async (query: string) => this.getFollowerDevices()
        .map((device) => ({ name: device.getName(), id: device.getData().id }))
        .filter((item) => item.name.toLowerCase().includes(query.toLowerCase())),
    );
  }

  private startWidgetBroadcast(): void {
    this.broadcastAllDeviceStates();
    // eslint-disable-next-line homey-app/global-timers -- cleared in onUninit()
    this.widgetBroadcast = setInterval(() => this.broadcastAllDeviceStates(), WIDGET_BROADCAST_MS);
  }

  /**
   * Backstop for the periodic interval - the common case, a single device's own poll tick
   * settling (or its own unit preference changing), goes through broadcastDeviceState directly
   * instead (see DexcomPollerHost.onSnapshotUpdated and device.ts's onSettings), so it doesn't
   * wait on every other device's own state.
   */
  private broadcastAllDeviceStates(): void {
    this.getFollowerDevices().forEach((device) => this.broadcastDeviceState(device));
  }

  /**
   * One shared realtime channel for every follower, not a per-device one - a per-device
   * *dynamic* channel name is exactly what broke on a real device (see
   * registerWidgetDevicePicker's comment): the widget had no reliable id to name-match it with.
   * Each push carries its own `id` (this app's own `data.id`); the widget filters client-side
   * against its bound device's own id (`Homey.getSettings().device.id`), same pattern
   * RonnyWinkler/homey.tesla's widget uses for its own `car_data_changed` event. Public so
   * device.ts's poller host can push one the moment its own tick settles (see
   * DexcomPollerHost.onSnapshotUpdated), not just on this app's own periodic interval.
   */
  broadcastDeviceState(device: FollowerDeviceLike): void {
    try {
      const payload = this.buildWidgetPayload(device);
      if (!payload) return;
      device.setDataAgeMinutes(minutesSinceReading(payload.updatedAt, Date.now()));
      this.homey.api.realtime('glucose', payload);
    } catch (err) {
      this.error('[widget] realtime broadcast failed:', err);
    }
  }

  /**
   * Pull-based fallback for the widget (widgets/glucose-dashboard/api.js's `getState`
   * endpoint) - the widget calls this once on load and on its own periodic poll, independent of
   * whether any realtime push ever arrives. Looked up by this app's own `data.id`, the same id
   * space the widget's autocomplete setting is populated from (registerWidgetDevicePicker).
   */
  getWidgetStateForDeviceId(deviceId: string): WidgetPayload | null {
    const devices = this.getFollowerDevices();
    const match = devices.find((d) => d.getData().id === deviceId);
    if (!match) {
      // Only the no-match case is worth a log line on an ongoing (~every 30s) poll - e.g. the
      // widget's bound follower was since removed. A successful match every 30s forever would
      // just be noise once device-binding itself is no longer in question.
      this.log('[widget-api] getState: no device found for', deviceId);
    }
    return match ? this.buildWidgetPayload(match) : null;
  }

  private buildWidgetPayload(device: FollowerDeviceLike): WidgetPayload | null {
    const snapshot = device.getWidgetSnapshot();
    if (!snapshot) return null;
    const { id } = device.getData();
    return {
      units: device.getUnits(), id, name: device.getName(), ...snapshot,
    };
  }

  private getFollowerDevices(): FollowerDeviceLike[] {
    try {
      return this.homey.drivers.getDriver('follower').getDevices() as unknown as FollowerDeviceLike[];
    } catch {
      return [];
    }
  }

};
