'use strict';

module.exports = {

  /**
   * Pull-based fallback for the widget's realtime subscription (both are used - see
   * CLAUDE.md's Widget section). `id` is this app's own `data.id` (the Dexcom accountId),
   * exactly what the widget's "device" autocomplete setting is populated with
   * (DexcomFollowApp.registerWidgetDevicePicker) - not a Homey-assigned id needing any
   * separate translation step.
   */
  async getState({ homey, query }) {
    const id = query && query.id;
    if (!id) return null;
    return homey.app.getWidgetStateForDeviceId(id);
  },

};
