# Dexcom Share — Homey App

A [Homey](https://homey.app/) app that follows one or more [Dexcom Share](https://www.dexcom.com/)
CGM (continuous glucose monitor) accounts, bringing live glucose readings, trend, and alarms into
your smart home.

**Homey App Store listing:** https://homey.app/a/com.dexcom.share/

> **⚠️ Not for medical use.** This is an open-source, community-built project and is not supported
> by Dexcom or any other company. It is not officially approved or regulated for diabetes therapy
> and/or treatment in any way. Do not rely on it for medical decisions — always use your Dexcom
> receiver or official Dexcom app as your source of truth.

Living with diabetes, or caring for someone who does, means keeping a constant eye on glucose
levels. This app brings the CGM data you already rely on into Homey, so a dashboard widget keeps
the latest reading and trend in view at a glance, while Flow cards let your home react on its own
when glucose runs high, drops too low, a trend is changing rapidly, or a sensor goes quiet.

## Features

- **Unlimited followers.** Each paired device follows one Dexcom Share account — pair as many as
  you need (e.g. one per family member), with no cap.
- **Live dashboard widget.** A per-device widget shows the current reading, trend arrow, a
  severity badge, and a sparkline chart of recent history. Tap the chart to cycle between 3h, 6h,
  12h, and 24h windows.
- **Flow cards** for triggers (glucose changed, high/low/urgent-low/rapid-change detected, no data
  detected), conditions (glucose above/below a threshold, trend is a given direction), and an
  action to force an immediate refresh.
- **Per-device settings**: mg/dL or mmol/L units, configurable urgent-low/low/high thresholds, and
  a no-data timeout — each account can be tuned independently.

## Requirements

- A Homey Pro or Homey Self-Hosted Server.
- A Dexcom account with Share enabled, belonging to the person wearing the sensor (a separate
  Dexcom Follow-only login won't return data — see Pairing below).

## Architecture overview

- **`app.ts`** — thin entry point. Holds no app-level shared state; its main job is broadcasting
  every paired device's already-polled snapshot to the dashboard widget (see below).
- **`drivers/follower/`** — the `follower` driver/device pair. Each paired device owns its own
  `DexcomPoller` instance and its own unit/threshold settings; there is no shared service between
  devices.
- **`lib/dexcom/`** — the core polling and domain logic, unit-tested independently of Homey. All
  communication with Dexcom's Share API goes through the third-party
  [`dexcom-share-client`](https://npmx.dev/package/dexcom-share-client) npm package:
  - `DexcomPoller.ts` — self-rearming polling loop (~5 min cadence, with backoff on errors) that
    fetches readings and history in a single call per tick.
  - `glucoseAlarms.ts` — derives a mutually-exclusive severity band (urgent-low/low/high/normal)
    and rapid-change flag from a reading, handling staleness and edge-only capability writes.
  - `units.ts` / `thresholds.ts` — mg/dL ↔ mmol/L conversion and the settings-form logic for
    resolving threshold values when units change.
  - `timestamp.ts` — corrects a timezone bug in `dexcom-share-client`'s own date parsing.
  - `client.ts` — bridges the ESM-only `dexcom-share-client` package into this CommonJS app.
- **`widgets/glucose-dashboard/`** — the dashboard widget. Binds to one followed device via a
  custom autocomplete setting (not Homey's native device picker — see the widget's own comments
  for why), and receives live updates over a shared realtime channel plus a polling fallback.
- **`test/`** — `node:test` coverage for all the pure logic in `lib/`, plus the widget's own
  presentation logic (extracted and evaluated standalone) and a dev-only browser preview harness
  (`test/widget-preview.html`) for visually iterating on the widget without a real Homey device.

## Pairing

Pairing uses a custom login screen (not Homey's stock template) that collects a Dexcom username,
password, and region up front. **The account entered must be the sensor-wearer's own Dexcom
account** (with Share enabled in their G6/G7/ONE/ONE+ app) — a separate account only used to
*follow* someone else's data in Dexcom's own Follow app will sign in successfully but won't return
any readings, since Dexcom's Share API only serves data to the account that owns the sensor
session.

## Development

```sh
npm run build          # tsc -> .homeybuild/
npm test                # tsc && node --test .homeybuild/test/*.test.js
npm run lint             # eslint, must be 0 problems
homey app validate --level verified   # the level CI runs at
```

See [CLAUDE.md](CLAUDE.md) for a much more detailed architecture and decision log.

## License

[GPL-3.0](LICENSE)
