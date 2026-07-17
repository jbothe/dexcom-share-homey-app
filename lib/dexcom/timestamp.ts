'use strict';

/**
 * dexcom-share-client@1.0.2's own GlucoseReading.datetime getter has a confirmed bug: Dexcom's
 * raw DT field uses the standard Microsoft/.NET "/Date(ticks+HHMM)/" JSON date convention, where
 * `ticks` (epoch ms) is already the correct absolute UTC instant and the trailing +/-HHMM is only
 * informational metadata (the offset in effect when Dexcom's backend serialized it) - it is not
 * meant to be applied as an additional delta. The library's parseDexcomDate() (dist/utils.js)
 * applies it as a delta anyway (`date.setMinutes(date.getMinutes() - offsetMinutes)`), which
 * shifts every reading's timestamp by the account's own UTC offset - e.g. a follower at UTC+10
 * sees every reading reported as ~10 hours further in the past than it actually is (confirmed by
 * reading the shipped dist/utils.js source directly). Not something we can patch inside
 * node_modules and have it survive a reinstall, so DexcomPoller recomputes the correct instant
 * straight from the reading's own raw JSON (the same DT field the library already parsed from,
 * just without the erroneous extra shift) via this function, instead of trusting `.datetime`.
 */
export default function parseCorrectedEpoch(rawDT: string): number | null {
  const match = rawDT.match(/Date\((\d+)/);
  if (!match) return null;
  return parseInt(match[1], 10);
}
