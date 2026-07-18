# Dexcom Share — Homey CGM follower app

Homey app (SDK v3, TypeScript, CommonJS output) that follows one or more Dexcom Share CGM
accounts via the [`dexcom-share-client`](https://npmx.dev/package/dexcom-share-client) npm package,
exposing glucose data through Flow cards and a live dashboard widget. **Targets both Homey Pro and
Homey Cloud** — `platforms: ["local", "cloud"]` in `.homeycompose/app.json` and
`driver.compose.json` alike, with `connectivity: ["cloud"]` (there is no local Dexcom endpoint;
every reading comes over the internet). That dual target is deliberate, not a leftover skeleton
default. Note the dashboard widget itself needs Homey Pro ≥12.4.0 (hence `compatibility`), so on
Homey Cloud the app is Flow-cards-and-capabilities only — the widget simply doesn't appear.
Development and all real-device verification so far has been against Homey Pro; the Cloud target
is **unverified on real hardware** (see "Not yet verified"). App id
`family.bothe.dexcom`, name "Dexcom Share" (paired device/driver display name "Dexcom User" — see
Localization below; internal code identifiers like the `DexcomFollowApp` class and the `follower`
driver id/folder were deliberately left as-is, since renaming those is a much larger, purely
internal refactor the display-name change didn't require). Modeled on the sibling app
`family.bothe.chargeiq`'s architecture and widget pattern — this file follows the same shape as
that app's own `CLAUDE.md`.

**Unlimited followers by design.** Unlike chargeiq's single-device cap, one Homey device = one
Dexcom Share account, with no cap (`lib/pairing.ts` → `resolvePairList` only refuses re-pairing the
*same* account twice). There is no shared-resource constraint here to justify capping it.

## Commands
- `npm run build` — `tsc` → `.homeybuild/`.
- `npm test` — `tsc && node --test .homeybuild/test/*.test.js`.
- `npm run lint` — `eslint --ext .js,.ts .`; must be 0 problems.
- `homey app validate --level publish` — must pass.
- `homey app validate --level verified` — must pass; **this is the level CI runs** (see CI below),
  so it, not `publish`, is the real gate. It checks strictly more than `publish` does — it is what
  caught both the missing `support`/`source` keys and a missing `title` on `trend_is`'s `direction`
  arg (`publish` is happy without either). It reports **one error per run**, so expect to re-run it
  several times after touching manifests rather than getting a full list up front.
- `homey app run` — run on a real Homey (LAN). **Not exercised during this app's initial build** —
  no Homey Pro was reachable in that environment. Pairing, capability display, Flow-card firing, and
  widget rendering are only verified via unit tests + the dev-only browser preview harness (see
  Widget section) — real on-device verification is still outstanding before publishing.
- Do **not** hand-edit `app.json` — generated from `.homeycompose/`.
- The skeleton this app started from pinned `typescript@^7.0.2`, which is incompatible with
  `eslint-config-athom`'s bundled `@typescript-eslint` (crashes on load — `ts-api-utils` expects an
  older TS internal API shape). Pinned to `^6.0.3` instead, matching chargeiq's own working version.
  `.eslintrc.json` also needed chargeiq's `import/resolver`, `import/extensions`,
  `node/no-missing-import` (allow `homey`), `engines.node` (package.json), and the
  `test/**/*.ts` rule overrides (`no-floating-promises`, `global-timers`, `max-classes-per-file`)
  copied over — none of that ships in a bare `homey app create` skeleton.

## CI (`.github/workflows/`)
Three Athom workflows from the `homey app create` skeleton (chargeiq has none, so there was no
sibling precedent to copy). Repo: `github.com/jbothe/dexcom-share-homey-app`.

**Every `athombv/*` step that compiles the app needs an explicit `actions/setup-node` + `npm ci`
before it, which the stock skeleton does not include.** Those actions run `npx tsc --showConfig`,
and `tsconfig.json` extends `@tsconfig/node16/tsconfig.json` — which lives in `node_modules`. With
no install step the `extends` can't resolve (`TS6053`) and the action reports it as the much less
obvious `Tsconfig validation failed: unable to read configuration from 'npx tsc --showConfig'`.
This bit on the very first push (green locally, red in CI, purely because a local `node_modules`
was masking it). It affects any TypeScript Homey app whose tsconfig extends a package, so don't
"simplify" those install steps back out of `homey-app-validate.yml` / `homey-app-publish.yml`.
- `homey-app-validate.yml` — every `push`/`pull_request`, at **`level: verified`** (see Commands:
  stricter than `publish`, and the real gate). Deliberately not downgraded to `publish` to make it
  pass — `verified` is what the App Store requires anyway, so it is the honest gate. After `npm ci`
  it also runs **`npm run lint` then `npm test`** (the 76 unit tests), ahead of the validate action,
  so a lib/ logic or style regression is enforced in CI and surfaces before a manifest one — the
  manifest validation alone would not have caught either.
- `homey-app-version.yml` — manual dispatch; bumps the version, commits, tags, cuts a GitHub
  release. It writes `.homeychangelog.json`, so the changelog is maintained *through this workflow*,
  not by hand. Has no compile step of its own, so it needs no install step.
- `homey-app-publish.yml` — manual dispatch; needs a `HOMEY_PAT` repo secret that **does not exist
  yet**, so publishing is not actually wired up.

## Architecture
Each paired device (`drivers/follower/`) owns its own `lib/dexcom/DexcomPoller.ts` instance and its
own unit preference (see Units below) — there is no app-level shared service (unlike chargeiq's
`CentralSystem`/`SolarFeed`) and no app-level settings at all; `app.ts` only holds a widget-broadcast
loop that aggregates every device's already-polled state.

- **`lib/dexcom/DexcomPoller.ts`** — self-rearming tick (`scheduleNextTick()`, same backstop pattern
  as chargeiq's `ChargeController.tick()`): normal cadence 5 min (matches the ~5 min source refresh);
  transient failures (`SessionError` past its own internal retry, `ServerError`, network) back off
  60s → 120s → settle at 300s; `AccountError` (bad password / lockout) backs off 15 min and marks the
  device unavailable — deliberately *not* retried quickly, to avoid compounding a real Dexcom account
  lockout. One persistent client is reused across polls, rebuilt only when username/password/region
  actually change (a fingerprint check), not on unrelated threshold-only settings saves.
- Each successful tick makes **one** `getGlucoseReadings(180, 36)` call, serving both the latest-value
  capabilities and the widget's 3h history — no separate rolling buffer.
- **`glucose_data_age`** (minutes since the last reading) is deliberately *not* written from
  `DexcomPoller` alongside the other capabilities. A tick-only update would only refresh every 5
  minutes and drift stale in between (unlike the widget's own "Xm ago" text, which re-renders from
  wall-clock time every 5s — see the Widget section's `applyStale`). Instead `app.ts`'s
  `broadcastDeviceState` — already called both immediately after every tick
  (`onSnapshotUpdated`) and on its own 60s interval — computes it via
  `glucoseAlarms.ts`'s `minutesSinceReading(updatedAt, Date.now())`, the same rounding/clamping
  formula as the widget's `fmtAgo`, and pushes it through `device.ts`'s `setDataAgeMinutes()`. So
  the capability updates on the same cadence as the dashboard and always agrees with what it shows,
  without teaching the poller itself about wall-clock-driven (as opposed to tick-driven) capability
  writes.
- **Severity is a derived band** (`lib/dexcom/glucoseAlarms.ts`'s `classifyGlucose`), not three
  independent threshold checks: `alarm_urgent_low`/`alarm_low`/`alarm_high` are mutually exclusive.
  `alarm_rapid_change` is independent (true on `DoubleUp`/`DoubleDown` trend). Capability writes and
  Flow-trigger firing only happen on the actual edge, not every tick — except the very first
  successful tick after (re)start, which force-writes every capability once so Homey's own default
  values never linger unset (`capabilitiesInitialized`/`noDataInitialized` flags in the poller).
- **`applyReadings()` classifies severity/rapid-change only from a reading that isn't *already*
  stale** (`isStale(latestTimeMs, now, noDataTimeoutMin)` — the same test `applyNoDataAlarm()`
  uses); a stale one is treated as `normal`/not-rapid. This is the entry-side counterpart to the
  stale-clearing below, and it exists because the two run in the same tick, in that order: on app
  start Dexcom hands back whatever it last measured however long ago, and the
  `!capabilitiesInitialized` force-write would classify that reading regardless of age — setting
  `alarm_high` and **firing `onHigh`** — only for `applyNoDataAlarm()` to clear the capability again
  microseconds later in that same tick. The capability blip was momentary; the Flow trigger was not
  (a real "glucose is high" notification for an hours-old reading, un-retractable once fired).
  Treating a stale reading as `normal` still force-writes every alarm capability to `false` on that
  first tick (Homey's defaults don't linger) while firing nothing, and leaves
  `lastSeverity`/`lastRapidChange` at their initial values so the first genuinely fresh reading is
  still a real edge. Regression-tested in `test/dexcom-poller.test.ts` (stale-on-first-tick
  scenario, asserting no firing on start and exactly one `onHigh` once fresh data arrives).
- **An empty poll (`readings.length === 0`) still force-writes the alarm capabilities once.**
  `applyReadings()` early-returns when Dexcom returns nothing — most often a freshly paired account
  whose sensor session hasn't produced a reading yet (`driver.ts`'s pairing check treats exactly
  that as a *valid* login, so it is a reachable steady state, not a transient), or one whose last
  reading has aged out of the 180-minute window entirely. That early return used to leave
  `capabilitiesInitialized` false **forever** on such a device, which made the
  `!capabilitiesInitialized` force-write below unreachable on precisely the device that needs it
  most: `alarm_urgent_low`/`alarm_low`/`alarm_high`/`alarm_rapid_change` sat at Homey's own unset
  default on the tile indefinitely, and only `alarm_no_data` (written by `applyNoDataAlarm()`,
  which runs every tick regardless) ever showed up at all. The empty branch now calls
  `initializeAlarmCapabilities()` — shared with the stale-first-reading path below — which writes
  all four to `false` exactly once, fires nothing, and leaves `lastSeverity`/`lastRapidChange`
  untouched so the account's first real reading is still a genuine edge. `measure_glucose`/
  `glucose_trend` are deliberately *not* written here: unlike the alarms, they have no meaningful
  "nothing wrong" value to assert without a reading. Regression-tested in
  `test/dexcom-poller.test.ts` (empty-account scenario, asserting the capabilities are written
  false, nothing fires, and a later first reading still fires `onHigh` exactly once).
- **`alarm_no_data` is recomputed every tick regardless of that tick's own success/failure** — a
  failed poll doesn't necessarily mean stale data (the last known reading might still be fresh), and a
  successful poll with no new reading yet doesn't mean the poll failed.
- **Going stale never clears `mgDl`/`trendDirection`/`updatedAt`, but it does clear the severity/
  rapid-change *alarms* derived from them** — `applyNoDataAlarm()` leaves the raw reading fields on
  the snapshot alone (the widget still wants the last-known value/trend for context — see its own
  `render()` and the Widget section below), but once `noData` trips, `alarm_urgent_low`/`alarm_low`/
  `alarm_high`/`alarm_rapid_change` are force-cleared to `false` and `lastSeverity`/`lastRapidChange`
  reset — a stale reading's old alarm state isn't trustworthy as *current* status, matching Dexcom's
  own official app (which shows plain "No Data" rather than continuing to assert e.g. "High"). Two
  real bugs shipped here once, now both fixed: the widget kept showing a 30+-minute-old value/trend/
  severity badge as if live (see the Widget section's own note on `render()`'s noData handling), and
  the *capability* itself (`alarm_high` etc., and its Flow trigger) stayed stuck true indefinitely —
  a Homey device tile or automation reading that capability had no way to know the reading behind it
  was stale. **Clearing this required also gating `applyReadings()`'s severity/rapid-change
  re-evaluation on `isNewReading`** (`latestTimeMs !== lastReadingDatetime`, the same check already
  used for `onGlucoseChanged` dedup) — Dexcom keeps returning the *same* last-measured reading,
  unchanged, on every poll for as long as it's still within the 180-minute request window (`readings`
  is never empty just because nothing new arrived). Without that gate, the tick right after a
  stale-clear would immediately reclassify that same old reading right back to its old severity
  (`classifyGlucose` only looks at the value, not its age) — an infinite 5-minute fire/clear loop of
  e.g. `onHigh`. Regression-tested in `test/dexcom-poller.test.ts` (stuck-stale-reading scenario,
  asserting exactly one `onHigh` firing through a clear-then-stay-clear-then-genuinely-new-data
  cycle) — this loop risk is exactly why that test exists, not just the clearing behavior alone.
- **In-memory-only edge state**: `lastSeverity`/`lastRapidChange`/`lastNoData`/etc. reset on every app
  restart (nothing is persisted to device store). A device that's already in an alarm state when the
  app restarts will re-fire that alarm's trigger on the next tick (a `normal → low` edge gets detected
  again even though it wasn't a *new* event) — a known, accepted limitation given how infrequently the
  app restarts; not worth the added complexity of persisting decision state for this.
- **`lib/dexcom/timestamp.ts` works around a confirmed timezone bug in `dexcom-share-client@1.0.2`
  itself.** Dexcom's raw `DT` field uses the standard Microsoft/.NET `/Date(ticks+HHMM)/` JSON date
  convention, where `ticks` is *already* the correct absolute UTC instant and the trailing offset is
  purely informational (metadata about what offset was in effect when serialized), not a delta to
  apply. The library's own `parseDexcomDate()` (`node_modules/dexcom-share-client/dist/utils.js`)
  applies it as a delta anyway (`date.setMinutes(date.getMinutes() - offsetMinutes)`), shifting every
  reading's `.datetime` by the account's own UTC offset — confirmed by reading the shipped source
  directly. A follower at UTC+10 sees every reading's `.datetime` reported as ~10 hours further in
  the past than it actually is (matches a real report: "last data says over 10 hours ago but it
  should be the latest"). Not patchable inside `node_modules` (wiped on reinstall), so
  `DexcomPoller.readingTimeMs()` recomputes the correct instant from each reading's own raw
  `.json.DT` string via `timestamp.ts`'s `parseCorrectedEpoch()` (parses only the numeric ticks,
  discards the offset suffix — the same approach every other known-working Dexcom Share client
  uses), falling back to the library's own `.datetime` only if `.json` isn't available (e.g. a test
  double). `updatedAt`, the widget history points, and the `glucose_changed` dedupe key all go
  through this corrected path — nothing in this app trusts `.datetime` directly. If a future
  `dexcom-share-client` release fixes the upstream bug, this workaround will start silently
  double-*not*-applying anything (it never touched `.datetime` in the first place, it always
  recomputed from raw `DT` independently) — safe either way, but worth re-checking against the
  installed version if `dexcom-share-client` is ever upgraded.
- **`lib/dexcom/client.ts`** bridges `dexcom-share-client`, which is **ESM-only**
  (`"type": "module"`, no `require` export condition) into this CommonJS app via a real dynamic
  `import()` (Node's native ESM/CJS interop — a static `import` fails to compile under
  `module: node16` from a CJS file). The `Region` enum and `DexcomShare` class are only ever obtained
  through that dynamic import, never statically. `eslint-plugin-node@11` predates dynamic-import
  awareness in its feature table, hence the targeted disable comment there.

## Units (per-device mg/dL ↔ mmol/L)
**A per-device setting, not app-wide** — there is no app settings page at all (no
`settings/index.html`; removed once units moved here, since it was the only app-wide setting).
Each follower is its own Dexcom Share account, potentially followed by/for a different person, so
a unit choice per device fits the rest of the model (thresholds, no-data timeout, credentials are
already all per-device) better than one household-wide toggle — and it removes the awkward
"only the first-ever paired device gets to infer the default, and only if nobody already set one"
special case the old app-wide version needed. `device.ts`'s `getUnits()` reads `this.getSetting('units')`
(defaulting to `mgdl`); `lib/pairing.ts`'s `resolvePairList` sets each new device's initial `units`
via `defaultUnitsForRegion(candidate.region)` — every device gets this inference at pair-time, not
just the first one, and later followers no longer affect earlier ones' units at all.

Threshold settings fields (`urgentLowThreshold`/`lowThreshold`/`highThreshold`) use a **fixed,
unit-spanning shape** (`decimals: 1`, `step: 0.1`, `min: 0`, `max: 400`) since Homey's declarative
settings schema can't change a field's decimals/range at runtime based on another (sibling) setting
— the same field holds `180.0` (mg/dL) or `10.0` (mmol/L) depending on which unit was active when it
was last saved. `glucoseAlarms.ts` itself only ever sees canonical mg/dL — conversion happens at the
`DexcomPoller.ts`/`device.ts` boundary via `lib/dexcom/units.ts`. (`DexcomPoller.thresholds()` used to
skip this conversion and compare the raw stored number directly against a canonical-mg/dL reading —
a real bug, silently misclassifying severity whenever mmol/L was the active unit; fixed alongside
this move, regression-tested in `test/dexcom-poller.test.ts`.)

Units and thresholds now live on the *same* device settings form, so a single save can change both
at once. That resolution is **`lib/dexcom/thresholds.ts`'s `resolveThresholdsOnSave()`**, a pure
function returning `{ error } | { thresholds, units, unitsChanged }` — the same result shape (and
for the same reason) as `lib/pairing.ts`'s own `resolvePairList`. It was deliberately lifted *out*
of `device.ts`'s `onSettings`: the rest of that file is a genuinely thin Homey adapter and is
low-coverage by design (see Testing), but this particular logic is neither thin nor safe to leave
untested — a real unit-conversion bug already shipped in this exact area once (see the
`DexcomPoller.thresholds()` note above), and the same class of mistake here is silent rather than
loud. `onSettings` is now just the adapter around it, and the rules live in one testable place: for
each threshold field the user did **not** touch in a save that also changed `units`, the stored
(old-unit) number is converted into the new unit; a threshold the user *did* edit in the same save
is trusted as already being expressed in the unit they just picked. Ordering (`urgent low < low <
high`) is validated in **canonical mg/dL, never the display unit** — the stored numbers alone are
meaningless without knowing which unit they're in. Its rejection message, like `pairing.ts`'s own
`DUPLICATE_ACCOUNT_MESSAGE`, is a plain English constant thrown straight to Homey's settings UI:
**neither of this app's two i18n mechanisms (see Localization) covers a string thrown from a
settings handler**, so both are untranslated — a known, accepted gap, not an oversight.
The corrected threshold values are written back via a second `setSettings()`
call, deliberately deferred with `setTimeout(0)` rather than called synchronously inside `onSettings`
— Homey persists `newSettings` verbatim immediately after `onSettings` resolves, so a synchronous
correction would race that persist and could get clobbered by it. This ordering assumption is
unconfirmed on a real Homey (see "Not yet verified").

## Pairing
Custom pair view (`drivers/follower/pair/login.html`), not Homey's stock `login_credentials`
template — that template has no region field, and username+password+region all need to be collected
up front. `driver.ts`'s `login` handler validates credentials via `getLatestGlucoseReading()` (a
`null` result is a *valid* login with no recent sensor data, not a failure) and reads the account's
stable `accountId` off the client afterward — that ID becomes `data.id` (decoupled from the editable
username), while username/password/region live in device *settings*, editable later without
repairing.

**The credentials that must be entered are the sensor-wearer's own Dexcom account, not a separate
"follower" login** — confirmed against a real account: authenticating as the diabetic's own Dexcom
account (Share turned on in their G6/G7 app) returns data, while authenticating as a distinct
account only ever used in the Dexcom Follow app to *view* that data signs in successfully (a valid
login, so `driver.ts`'s `getLatestGlucoseReading() === null` check can't distinguish it from "no
recent sensor data yet") but returns no readings — Dexcom's Share API only serves data to the
account that owns the sensor session. `login.html`'s copy calls this out explicitly for exactly this
reason.

**The `login` pair step deliberately declares no `"navigation"` in `driver.compose.json`.**
Declaring `navigation.next` on a pair step is what makes Homey render its own default chrome
"Next" button (confirmed via Homey's own docs: "The `navigation` option determines which of the
steps the pairing will go to when the user presses the 'Next' button") — for a custom view that
already has its own form submit button, that produces two buttons on screen, and tapping Homey's
own one skips the `login` handler entirely (advances straight to `list_devices` with no cached
credentials, surfacing as "Please sign in first."). Fixed by removing `navigation` from that step
and having `login.html` call `Homey.showView('list_devices')` explicitly after a successful
`Homey.emit('login', ...)`, rather than relying on the (now-absent) declared navigation or
`Homey.nextView()`, which depends on it. Considered switching to rely solely on Homey's own native
button instead, but there is no documented way to gate it on an async check (no intercept hook in
the client `Homey` object) — the only alternative would move login validation into the
`list_devices` handler, surfacing a bad-password error only after the user has already clicked past
the login screen. Decided against that UX regression; kept the single custom button. Both
`login.html` (client-side `console.log`) and `driver.ts` (`this.log`/`this.error`, username masked,
password never logged) log every step of the pairing handshake for troubleshooting.

**`login.html`'s styling uses Homey's own design tokens** (`var(--homey-color-blue-500, …)` etc.,
same values as `test/homey-mock.css`), not hardcoded colors, so the screen matches Homey's real
brand palette and the user's actual in-app theme. Unlike the widget, it is **not confirmed that
Homey injects these variables into pair views** the same way it does for widgets/settings (see "Not
yet verified") — every `var()` call carries an explicit static light-mode fallback, so the screen
still looks Homey-authentic even if nothing is actually injected. Deliberately no
`prefers-color-scheme` override of those variable names: if Homey *does* inject a real (possibly
dark) value, a same-specificity local override keyed off the OS theme could clobber it, exactly the
risk the widget's own styling comment already flags for the same variable set. The Continue button
sits in a `.footer` pinned to the bottom via `margin-top: auto` inside a flex column, echoing the
placement (though not the actual chrome) of Homey's own default pairing "Next" button.

## Widget (`widgets/glucose-dashboard/`)
**One widget instance = one follower device, picked via the widget's own `"device"` autocomplete
setting — NOT Homey's native `"devices"` widget setting.** An earlier revision used
`"devices": { "type": "app", "singular": true }`, which makes Homey show its own device-picker UI
at add-time and exposes the pick to the widget via `Homey.getDeviceIds()`. **That id turned out to
be Homey's own top-level device id, not this app's `data.id`** (the Dexcom accountId assigned
during pairing) — confirmed two ways on a real device: the two ids are visibly different UUIDs
(Homey's own `[Device:<id>]` log-tag vs. the accountId `device.ts`'s `onInit` logs on the same
line), and a lookup keyed off the top-level id came back `undefined`/no-match every time, because
**the public `Device`/`Driver` API has no documented way to translate Homey's own top-level device
id back into one of this app's own Device instances** (`getData()` only ever returns this app's
own pairing data; `Driver.getDevice(data)` matches against that same pairing data, not against
Homey's id). The only documented bridge is `HomeyAPI.createAppAPI()`, which requires declaring the
broad `homey:manager:api` permission ("control all of Homey, even devices/flows not part of this
app") just to resolve one of this app's own devices — disproportionate for what this needs.

Fixed by dropping the native picker entirely and adding a **custom `"device"` autocomplete widget
setting** instead (`widget.compose.json`), populated by `app.ts`'s
`registerWidgetDevicePicker()` (`this.homey.dashboards.getWidget(...).registerSettingAutocompleteListener('device', ...)`)
with `{ name: device.getName(), id: device.getData().id }` for every paired follower — an id space
this app already fully owns end-to-end, no translation needed. The widget reads the pick via
`Homey.getSettings().device.id` in `onHomeyReady`, not `Homey.getDeviceIds()`. This is not a novel
pattern invented here - it's modeled directly on a published, working app that solves the exact
same problem the same way:
[RonnyWinkler/homey.tesla](https://github.com/RonnyWinkler/homey.tesla)'s `car_main` widget
(`app.js`'s `_initWidgets()`/`registerSettingAutocompleteListener('device', ...)`, matching
`e.getData().id == id` throughout its own widget API handlers). One practical consequence: adding
the widget to a dashboard no longer shows a device-picker step at add-time — the user picks their
follower afterward, in the widget's own settings (its edit/gear icon on the dashboard).

Otherwise follows chargeiq's `power-flow` widget pattern: self-contained `public/index.html`
(inline CSS+JS, no imports), styled purely via Homey's injected `--homey-*` vars/`.homey-text-*`
classes (no local color fallback, no manual dark-mode detection), and a staleness watchdog (`.stale`
dim/grayscale after ~3 missed broadcasts, ~180s).

**One shared realtime channel for every follower (`'glucose'`), not a per-device dynamic one.** A
per-device dynamic channel name is exactly what the original id-mismatch bug broke (the widget had
no reliable id to name a matching subscription with). `app.ts`'s `broadcastDeviceState(device)`
calls `homey.api.realtime('glucose', payload)` with the device's own `data.id` embedded in the
payload as `id`; the widget subscribes once with `Homey.on('glucose', onData)` and filters
client-side (`result.id !== boundDeviceId` → ignore) — same pattern
`RonnyWinkler/homey.tesla`'s widget uses for its own `car_data_changed` event.
`broadcastDeviceState` is public specifically so `DexcomPoller`'s `onSnapshotUpdated` host callback
(wired in `device.ts`'s `buildHost()`, called with `this`) can push immediately at the end of
*every* tick (success or failure) — `broadcastAllDeviceStates()` (looping `broadcastDeviceState`
over every paired device) backs the 60s `setInterval` in `startWidgetBroadcast()`; a single
device's own units change instead pushes directly via the same `broadcastDeviceState(this)` call
from `device.ts`'s `onSettings` (see Units above), without waiting on every other device's own
state. This matters because the interval's own *first* firing happens immediately at app boot,
before any device's poller has completed its first network round trip — that first broadcast is
necessarily empty, and without the event-driven push a widget would be stuck showing that empty
snapshot for however long remains until the timer's *next* firing (up to a full 60s), even though
its device's poller may have already finished seconds later.

**Pull-based fallback (`widgets/glucose-dashboard/api.js`'s `getState` endpoint), kept alongside
the realtime push as extra insurance, not removed once the id-mismatch bug was actually fixed.**
The widget does three things on load: subscribe to the realtime channel (above), immediately call
`Homey.api('GET', '/state?id=' + boundDeviceId, {})` once, and re-call it on its own 30s
`pollTimer` regardless of whether any realtime push ever arrives. Handled by
`DexcomFollowApp.getWidgetStateForDeviceId()`, keyed by the same `data.id` the autocomplete setting
uses — no separate id-translation step to go wrong here. **Confirmed working on a real device**
(`[widget-api] getState lookup` matched, widget rendering live data). That lookup only logs on a
*miss* (`[widget-api] getState: no device found for <id>` - e.g. the widget's bound follower was
since removed) rather than on every call, since a successful match on a ~30s poll forever would
just be noise once device-binding itself is no longer in question. The widget's own console still
logs `Homey.getSettings().device`'s raw value, every realtime push received, and every poll
result/failure (`[dexcom-widget] ...`, same `diag()` pattern as `pair/login.html`) - kept
permanently, matching that file's own established troubleshooting-logging convention, not
temporary debug output to strip out later.

Presentation logic lives between `GLUCOSE-LOGIC-START`/`END` markers (mirrors power-flow's
`POWERFLOW-LOGIC-START`/`END`) — `test/glucose-widget.test.ts` extracts and evaluates that exact
block, so it must stay dependency-free. Two independent staleness signals are deliberately kept
separate: the card-level watchdog (channel/app health) vs. `alarms.noData` from the payload itself
(sensor/Dexcom-side gap) — a healthy channel can still show "No Data" for a real reason.

**`alarms.noData` unconditionally wins over everything else in the header, both text and color.**
`badgeText()` checks `noData` *before* any severity band (a real bug fixed here: it used to check
severity first, so `{ high: true, noData: true }` produced badge text "High" - while `render()`'s
*separate* class-selection check looked at `noData` first, styling that same "High" text with the
grey no-data color instead of orange - text and color disagreeing on the same pill). `BADGE_CLASS`
(one object, keyed by `badgeText()`'s own return values) is now the *only* place badge color is
decided, so the two can't diverge again. `render()` also blanks `value`/`trend` back to the same
"–"/empty state as the no-payload-yet placeholder whenever `noData` is set, rather than continuing
to display the last-known reading/trend arrow as if current — the poller never clears those fields
on its own (see the Architecture section's own note on this), so without this check the widget kept
showing an increasingly-stale value baked with a trend arrow and a since-untrustworthy severity
badge, unlike Dexcom's own official app (which just shows "No Data"). The `ago` text and the
sparkline's history are deliberately left alone in this state — knowing *how* stale, and what the
last several readings looked like before the gap, is still useful context.

For visual iteration without a real Homey device: `test/widget-preview.html` + `test/homey-mock.css`
(dev-only, not part of `npm test`, never shipped — nothing in `widget.compose.json`/`app.json`
references `test/`), copied/adapted from chargeiq's own equivalent tooling. Loads the real,
unmodified widget file in an iframe and injects the mock stylesheet after load — it calls the
widget's `render()` directly (bypassing `onHomeyReady`/the device-binding setting entirely, so it
can't exercise that step, only the presentation logic). **Must be served over http(s)** (e.g.
`python3 -m http.server` from the repo root), not opened via `file://` — same-origin iframe access
is required. Has Light/Dark/Auto theme buttons and preset shortcut buttons (normal, urgent-low,
low, high, no-data, mmol/L, rapid-falling, before-first-broadcast) that fill a JSON textarea — the
flat single-device payload shape `broadcastDeviceState` sends — for "Apply state" rather than
rendering immediately. Verified via this harness: value/unit/trend rendering, severity badge +
sparkline coloring (urgent-low=red, low/high=orange), the four shaded severity zones (see below),
the empty (no-broadcast-yet) placeholder, mmol/L conversion, and the staleness dim — in both light
and dark.
`homey-mock.css`'s values are reasonable approximations (Homey docs don't publish exact
border-radius px), not authoritative — real on-device verification (exact fonts, real color/radius
values, and the actual autocomplete-setting device-picker plumbing) still needs `homey app run`.

**`widget.compose.json`'s `"height": 180` is calculated, not guessed.** The card's content height
is fully static — the sparkline's y-domain is now the fixed Dexcom sensor range (see `GD.sparkline`
above) rather than data-driven, and the header never wraps to a second line at the widget's actual
on-dashboard width — so every possible payload state renders to one of exactly two heights, measured
by injecting `homey-mock.css` into the real `public/index.html` (not the iframe harness, which
already imposes its own fixed `380x240` box) and calling `render()` directly at a 380px viewport
width: 174px with no alarm badge, ~176px with one (the badge's own box + vertical padding nudges the
name row a couple px taller than the badge-less 174px case). `180` is that 176px max plus a small
buffer, not the true minimum — `homey-mock.css`'s font metrics are its own approximations (see
above), so a real-device font could plausibly render a few px taller than this mock. Re-measure the
same way (`render()` at 380px width, badge and no-badge states, `mgdl` and `mmol`) if the
header/badge/chart CSS changes again, rather than hand-adjusting this number. The badge's
`text-box` trim (see below) is the one input here that is deliberately *font-dependent*: the pill's
height is now cap-height-driven, so it varies by a fraction of a px per font (30.32px against the
mock's own font, vs. the 30px its old line-height-driven box came to) — immaterial against the
buffer, but it means the badge case will never re-measure to a perfectly round number again.

**Sparkline x-axis is a fixed `WINDOW_MS` (3h, matching `DexcomPoller`'s own `getGlucoseReadings(180,
36)` call) window anchored to `opts.nowMs` (defaults to `Date.now()`), not to the actual first/last
sample timestamps.** An earlier revision scaled x from `history[0].t` to `history[last].t` — if the
most recent reading was stale (e.g. no data for the last 20 minutes), the existing samples still got
stretched edge-to-edge, silently erasing the fact that recent data was missing. Samples are also no
longer joined into one continuous polyline: `GD.sparkline()` returns `segments` (one points-string
per run of consecutive samples no more than `GAP_THRESHOLD_MS` — 8 min, a bit under 2x the ~5 min
poll cadence — apart) and `dots` (every in-window sample's `{x,y}`, regardless of segment). A real
gap (sensor/connectivity dropout, not just poll jitter) now draws as a visible break instead of a
straight line bridging it, and a sample stranded between two gaps still shows up as a lone dot even
though it's not part of any 2-point segment. `render()` builds one `<polyline>` per segment plus one
`<circle>` per dot from these, in that order (dots paint on top). The domain's two edges carry a
value label but **no gridline of their own** — the shaded zones (below) already tile the whole plot
area, so their outer edges mark the same two boundaries the old dashed rules did.

**The alarm pill centers its text with `text-box: trim-both cap alphabetic`, not with padding
alone.** Its padding wraps a *line box*, which always reserves descender room, but the pill's text
is always uppercase (`text-transform`) and so never has descenders — that empty strip under the
baseline read as visibly extra padding beneath the text on a real Homey. The gap's size is purely a
function of the font's own metrics (descent vs. ascent-minus-cap-height), which is exactly why it
was **not** reproducible in `test/widget-preview.html`: measured there by scanning rendered pixels
it came to ~0.5px, invisible, because the harness's font stack only approximates Homey's real one.
That ruled out tuning a px nudge here — any value would have been calibrated against the wrong font
and made the harness worse. `text-box` trims the line box to exactly cap-height..baseline instead,
so symmetric padding centers the real glyphs on *any* font with no per-font tuning, and padding
(rather than line-height) then sets the pill's height. Clients predating `text-box` (Chrome <133 /
Safari <18.2) fall through the `@supports` gate to the old, uncorrected rendering — so if the pill
ever looks bottom-heavy again, check the client's version before touching the CSS.

**The chart's y-axis is shaded as four severity zones, not one target-range band.** `GD.sparkline()`
returns `zones` (`{ cls, y, height }` each) — the three thresholds cut the fixed sensor-range domain
into urgent-low (red) / low (orange) / normal (green) / high (yellow), tiling the whole plot area,
and `render()` draws one `<rect class="zone …">` per entry beneath the grid/lines/dots. This
replaced a single green `bandY1`/`bandY2` rect spanning low→high. Three things worth knowing:
- **It needed `urgentLowMgDl` plumbed into the widget payload** — it previously carried only
  `lowMgDl`/`highMgDl`, since the old band only had two edges. `device.ts`'s `getWidgetSnapshot()`
  now converts all three thresholds; `types.ts`'s `WidgetSnapshot` (`GlucoseSnapshot &
  AlarmThresholds`) is the shared shape `app.ts` and `device.ts` both name instead of repeating the
  inline intersection type they each used to spell out.
- **Zone alphas bump *less* for dark mode than the band they replaced did, not more** — see the
  `--spark-zone-*` comment in `public/index.html` for why (cumulative weight: four tiled zones vs.
  one lone band). `--spark-line-normal` no longer varies by theme at all (blue-600 in both), so it
  sits in `:root` only.
- **A dark-mode value must be edited in *two* places: the `@media (prefers-color-scheme: dark)`
  block and the `:root[data-theme='dark']` one.** Homey's real dashboard only ever takes the
  `@media` path; `[data-theme]` is set solely by the preview harness's own Light/Dark buttons. This
  bit once, exactly the way it's designed to: the zone alphas were tuned down in the `[data-theme]`
  block but not the `@media` one (their indentation differs, so a replace-all silently missed it),
  which looked correct in the harness — whose Dark button reads `[data-theme]` — while the real
  device kept the rejected too-heavy values. Verify dark-mode changes through the `@media` path
  (set the OS/browser to dark and leave the harness on "Auto (OS)"), not just the Dark button.
- **The fixed 40–400 mg/dL domain makes the zones wildly unequal**, and this is inherent to the
  domain rather than to the shading: high (180–400) takes ~61% of the chart height and normal
  (70–180) ~30%, while urgent-low (40–55) and low (55–70) are ~4% each — two slivers that read as
  roughly one thin band at the widget's real on-dashboard size. Verified in the preview harness.
  Narrowing the domain would fix that but would break the "always in bounds without per-render
  padding" property the fixed domain exists for; not attempted.

## Localization
`en`/`de`/`nl` throughout, Homey's standard i18n object convention — a missing locale on any given
key just falls back to `en`, so partial coverage is never a build error, only a display fallback.
Two distinct mechanisms, matching where Homey actually looks each one up:

- **Compose-level strings** (capability/flow-card/settings-form `title`/`desc`/`label`/`hint`/
  `name`, including `glucose_trend`'s enum values) are `{ "en": ..., "de": ..., "nl": ... }` objects
  directly inside the relevant `.homeycompose/**/*.json`, `driver.compose.json`,
  `driver.settings.compose.json`, and `widget.compose.json` files — Homey resolves these itself,
  no app code involved.
- **Free-form UI text inside `pair/login.html` and the widget's `public/index.html`** isn't part of
  that compose system at all, so it goes through Homey's other standard mechanism instead: a
  single app-level `/locales/{en,de,nl}.json` (flat-ish nested dictionary), looked up at runtime via
  the `Homey.__('dotted.key.path', tags)` function Homey injects into both pair views and widgets.
  `login.html` calls it directly (pair views get a synchronous global `Homey`, same as this file's
  pre-existing direct `Homey.emit()`/`Homey.showView()` calls) and assigns the results to the
  form's labels/button/error text once at load. The instructions paragraph's translated string
  carries a literal `<strong>` tag around "person wearing the sensor" and is assigned via
  `innerHTML` (safe: static translator-authored markup, not user input) — translators must keep
  that tag if they ever edit the copy.

  The widget can't call `Homey.__()` from inside its `GLUCOSE-LOGIC` block: that block must stay
  dependency-free (see Widget section — `test/glucose-widget.test.ts` evaluates it standalone via
  `new Function`, outside any Homey/browser context) and the block used to return literal English
  display text directly. `badgeText()`/`fmtAgo()` now return a translation *key* (`'urgentLow'`,
  `'noData'`, ...) or, for `fmtAgo()`, a `{ key, hours?, minutes? }` descriptor for the two-variable
  "Xh Ym ago" case — the actual `Homey.__('widget.glucoseDashboard.' + key)` lookup happens in
  `badgeLabel()`/`agoLabel()`, just outside the marked block, using the `HomeyRef` captured in
  `onHomeyReady`. `test/widget-preview.html` calls `render()` directly and never runs
  `onHomeyReady` (see Widget section), so `HomeyRef` stays `null` there — `t()` falls back to a
  small hardcoded English `WIDGET_STRING_FALLBACK` dict in that case, purely so the dev harness
  still renders readable text; real Homey always has `HomeyRef` set before any of these are called.
  **`t()` never passes `tags` through to `Homey.__()` itself** — confirmed on a real device that the
  widget-side `Homey.__(key, tags)` silently ignores its `tags` argument (the raw
  `"{{minutes}}m ago"` template came back unsubstituted, visible in the widget). `t()` fetches the
  bare template string from whichever source applies (`Homey.__(key)` with no second argument, or
  the local fallback dict) and always does the `{{tag}}` replacement itself in plain JS, so
  interpolation no longer depends on Homey's own (apparently pair-view-only) tag support.

**App/driver display-name rename:** the app's own display name changed from "Dexcom Follow" to
"Dexcom Share", and the paired-device/driver display name from "Dexcom Follower" to "Dexcom User"
(`.homeycompose/app.json` / `drivers/follower/driver.compose.json` `name`, plus the widget's
device-picker setting label and the pair screen's own copy, which now reads "Connect a Dexcom
User"). Note "Dexcom Share" is also literally the name of Dexcom's own upstream sharing feature/API
that this app polls (see the Pairing and Units sections above, both of which use "Dexcom Share" to
mean *that* upstream service, not this app) — so the app is now name-identical to the very Dexcom
service it's a third-party client for. **This is deliberate and guideline-compliant, not a concern:**
Homey's own [App Store guidelines](https://apps.developer.homey.app/app-store/guidelines.md) direct
third-party brand-app developers to *"use the brand name for your app"* (and forbid using a *company*
name instead), so naming a Dexcom Share client "Dexcom Share" is exactly what Homey asks for — there
is no official-vs-unofficial distinction or verification step in those guidelines. Dexcom's own
official companion app for viewing someone else's data is separately called "Dexcom Follow", and
`pair/login.html`'s copy still correctly refers to *that* real Dexcom product by that name, unrelated
to whatever this app calls itself. Renamed only
the two display-name strings and copy that directly echoes them — did **not** rename the `follower`
driver id/folder, the `DexcomFollowApp` class, `driver_id=follower` flow-card filters, or the
"Dexcom Share account"/"Glucose unit" *upstream-service* terminology used correctly elsewhere in
settings labels — those are internal identifiers or genuinely-accurate upstream-service references,
not the app's own product name, and renaming them wasn't part of this ask.

## Not yet verified
**The Homey Cloud target is unverified.** Both manifests declare `platforms: ["local", "cloud"]`
intentionally (see the header), but every real-device session so far has been Homey Pro. Nothing
about Cloud has been exercised — including whether the polling cadence and long-lived client hold
up under its runtime.

No real Homey Pro was reachable while building this app; real-device testing started later and is
ongoing. **Confirmed working:** pairing (`pair/login.html`, a real Dexcom Share account),
immediate first-tick data on pairing, multi-reading polls (`getGlucoseReadings` returning 35+
readings), and the widget's device-binding + live data (both the realtime push and the
`Homey.api()` pull fallback) via the custom autocomplete setting described in the Widget section.
That widget fix took three attempts to get right - the first two both tried to keep Homey's native
`"devices"` picker and bridge *its* id back to this app's own devices (first assuming it matched
`data.id`, then assuming an undocumented `Device.id` property), and both failed on-device before
the autocomplete-setting rewrite (modeled on a real published app, `RonnyWinkler/homey.tesla`)
actually worked - worth remembering if a *future* SDK/Homey firmware change makes this area act up
again: re-verify from real device logs before assuming either of those two earlier approaches
would now work. **The badge's `text-box` centering fix is on-device-reported but not yet
on-device-confirmed**: the bottom-heavy pill was only ever observed on a real Homey (never
reproducible in the harness, see the Widget section), so whether the fix actually lands there — and
whether that client is even new enough to support `text-box` at all — still needs a look at the real
dashboard. Still otherwise unconfirmed on-device: does Homey actually inject its
`var(--homey-*)` design tokens into a pair view the way it documents for widgets (see the
Pairing section's styling bullet), Flow-card firing against a live paired device, and the
`dexcom-share-client` library's real-world behavior against the live Dexcom Share API (error shapes,
actual session-expiry timing) — the timestamp workaround (see the poller bullet above) was cross-
checked against `pydexcom`'s reference parsing rather than a live account, since none was available
here; the event-driven widget broadcast (`onSnapshotUpdated`/`broadcastDeviceState`, see Widget
section) is unit-tested via the fake-clock/fake-client harness but its actual effect on
time-to-first-paint after a real app restart is likewise unconfirmed on-device. Also unconfirmed:
the exact ordering of `onSettings`'s resolution vs. Homey's own persistence of `newSettings`, which
`device.ts`'s deferred (`setTimeout(0)`) threshold-correction-on-units-change relies on (see Units
above) — untested by design, same as the rest of the thin Homey adapters (see Testing).

## Art
**The app icon (`assets/icon.svg`) is Dexcom's own wordmark** — the supplied `dexcom.svg` brand
logo, recoloured black and placed on the 960x960 canvas Homey requires, with ~10% (96px) breathing
room on the left/right and centred vertically. The original 372x55 wordmark paths are kept verbatim;
a nested `<g transform>` lifts them out of their exported `translate(-289,-417.03)` offset, scales
them to 768px wide (`768/372`), and centres the result — the two magic numbers in that transform
(`translate(96, 423.226)`) are the L/R margin and the vertical-centring gap `(960 - 55*scale)/2`, so
re-derive them the same way if the canvas or margin ever changes rather than hand-nudging. Verified
by rendering the file in a square browser viewport (symmetric margins, vertically centred).
`brandColor` (`#56B146`) is that same wordmark SVG's own `fill` green, moved into the manifest so
Homey can tint the black icon with it — replacing the earlier `#00B000` (see the dot-mark note
below). Homey's guidelines tell a brand app to ship the brand's own icon (see the compliance note
further down), so using the Dexcom wordmark here is deliberate.

**The driver icon (`drivers/follower/assets/icon.svg`) is Dexcom's *dot* mark** — a distinct glyph
from the app icon (Homey's guidelines say a driver icon should not reuse the app icon, so the
wordmark-vs-dots split is a feature, not an oversight). Traced from a supplied 480x480 PNG rather
than drawn freehand: six circles, mirror-symmetric about the vertical axis — four large (r=34.5 in
source px) on a rhombus, two small (r=23.0, *exactly* 2/3 the large radius) flanking the bottom,
measured by connected-component analysis (centroid + area-derived radius) then regularised to
enforce the symmetry the original intends, so it's reproducible — re-derive the same way if
re-traced, don't hand-tweak. Both icons are `fill="#000000"` on transparent, per the same Homey
convention every `assets/capabilities/*.svg` follows (Homey tints the icon, so the green lives only
in `brandColor`). The driver icon is picked up by **filesystem convention**
(`drivers/<id>/assets/icon.svg`); there is no `icon` key in `driver.compose.json` and `app.json`'s
`drivers[].icon` stays `null` — that's correct and matches chargeiq exactly, so don't "fix" that null.

The raster images are generated (Pillow, 4x supersampled + LANCZOS — the note about no SVG tooling
being available still holds, so they are drawn from the same measured *dot-mark* geometry rather than
rasterized from any SVG): `assets/images/*.png` are the dots green-on-white, `drivers/follower/assets/
images/*.png` white-on-`#00B000` (a solid tile). That `#00B000` is the *dot logo's* own green (sampled
as the modal core-green pixel — 95.9% exactly `#00B000`), and it **no longer matches the app's
`brandColor` (`#56B146`, from the wordmark)** — a mismatch that only matters if these rasters are kept.
They aren't: both sets fail the App Store *content* rules regardless (see the image-guideline gaps
below) and are placeholders to redo, so the `#00B000`/`#56B146` split isn't worth reconciling until
they are.

**Using Dexcom's own logo is deliberate and guideline-compliant, not a trademark liability.** Homey's
[App Store guidelines](https://apps.developer.homey.app/app-store/guidelines.md) tell third-party
brand-app developers *"If your app supports a specific brand, use the company's brand icon"* — so
shipping Dexcom's own wordmark as the app icon (and its dot mark as the driver icon) is exactly what
Homey asks a Dexcom client to ship, the same way the name "Dexcom Share" is (see the Localization
section's rename note). No distinct/original mark is needed or wanted here.

**App Store image-guideline gaps (audited against the guidelines above — dimensions all pass, content
does not):**
- **`assets/images/*.png` (app images, green-on-white) will be rejected as-is.** The guidelines
  prohibit app images that are *"logos only"* or *"single flat shapes on monochrome/transparent
  backgrounds"* — the current green-mark-on-white is exactly that. App images are meant to be a
  *"visually appealing image that represents the purpose of your app"* (a glucose dashboard scene,
  say), not the mark again. The brand *icon* rule above is about `icon.svg`, not these.
- **`drivers/follower/assets/images/*.png` (device tile, white-on-`#00B000`) will be rejected as-is.**
  Driver images must have *"a white background and a recognizable picture of the device"*, and may
  **not** reuse the app icon/image — the current brand tile is neither white-background nor a device
  picture. Complicated here by this being a *virtual* device (a Dexcom Share account, no hardware),
  so "the device" has to be represented by something evocative (a CGM sensor/receiver, or a
  glucose-tile illustration) on white. **NB the chargeiq split this was modeled on is not a
  precedent to trust for App Store readiness** — mirroring its light-image/brand-tile approach is
  what produced both rejections.
- **`widgets/glucose-dashboard/preview-{light,dark}.png` are still the skeleton `homey app create`
  rocket** (and the "dark" one isn't even dark). They must be real renders of the glucose widget in
  each theme, transparent background, no text/screenshot chrome — produce them from the
  `test/widget-preview.html` harness (see the Widget section). This is the one image item unblocked
  regardless of any branding decision, since the widget renders identically whatever the app is named.

## Testing
Pure logic in `lib/` gets `node:test` coverage (mirrors chargeiq's philosophy — thin Homey adapters
`app.ts`/`drivers/follower/{driver,device}.ts` stay low-coverage by design). The corollary is that
**"it lives in an adapter" is a reason to move logic, not a reason to leave it untested** — when
real decision-making shows up in one of those files, lift it into `lib/` and test it there, the way
`thresholds.ts` (from `device.ts`'s `onSettings`, see Units) and `pairing.ts`'s `maskUsername` (from
`driver.ts`, which is `module.exports = class` per the Homey template and so can't also carry a
named export) both were.
- `glucoseAlarms.ts` / `units.ts` / `pairing.ts` / `thresholds.ts` — plain function tests.
- `client.ts` — only `describeDexcomError` (its one pure function). Importing the module from a
  test is safe despite `dexcom-share-client` being ESM-only: the dynamic `import()` only ever runs
  *inside* `createDexcomClient`/`verifyDexcomLogin`, so nothing loads at module scope.
- `DexcomPoller.ts` — constructor-injected fake client + a manually-advanced `FakeClock` (no real
  timers/network); covers cadence recovery, backoff tiers, edge-only capability writes, and
  `requestImmediateRefresh()`'s rate limit.
- Widget logic block — extracted and evaluated exactly like chargeiq's `powerflow.test.ts`.

## Conventions
Matches chargeiq: `'use strict'` + `import` + `module.exports = class …` for App/Driver/Device (Homey
template); plain `export`/classes in `lib/`.
