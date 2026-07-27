# Homey widget Style Library (dev-only, committed, never shipped)

A **separate** asset tree from `../css`/`../font`/`../icons`/`../img` (the pair Style Library) -
Homey ships a distinct set of CSS for widgets, documented at
https://apps.developer.homey.app/the-basics/widgets/styling, with its own manifest
(`homey.widgets.css`, not `homey.css`), its own variable-naming scheme, and its own font folder
layout. `test/widget-preview.html` links this tree to render
`widgets/glucose-dashboard/public/index.html` against real injected styling. Nothing in
`app.json`/`widget.compose.json` references `test/`, so none of this is packaged with the app.

Copied verbatim from the sibling `family.bothe.chargeiq` app's own equivalent tree (its
`test/widget-preview.html` pioneered this same real-CSS approach - see that app's own
`test/homey-css/widgets/README.md`), then re-verified byte-identical against this app's own
already-fetched pair/settings copy where the two trees overlap (the three Roboto weights - see
Fonts below). These are Homey firmware assets, not anything app-specific, so a copy from another
app's fetch is exactly as authoritative as running `fetch.sh` again here.

Stored verbatim (original filenames, original relative layout) so `homey.widgets.css`'s own
`@import url(./...)` chain and `_homey-fonts.css`'s `url(../fonts/...)` resolve unchanged.

## Refreshing

Widget assets live under a `/widgets` suffix on the same base as `../fetch.sh` (the pair
assets):

```bash
HOMEY_ASSETS_BASE='https://<your-homey-id>.connect.athom.com/manager/webserver/assets' \
  ./test/homey-css/widgets/fetch.sh && git diff --stat test/homey-css/widgets
```

i.e. `https://<your-homey-id>.connect.athom.com/manager/webserver/assets/widgets/css/homey.widgets.css`
and siblings. Same `HOMEY_ASSETS_BASE` value as `../fetch.sh` - this script appends `/widgets`
itself.

## Layout

```
css/
  homey.widgets.css      <- manifest: @imports the seven files below, no rules of its own
  _homey-fonts.css       <- @font-face declarations, url(../fonts/...) - see Fonts below
  _normalize.css         <- modern-normalize v3.0.0 (third-party reset, MIT licensed)
  _homey-variables.css   <- --homey-* custom properties + the .homey-dark-mode override block
                             - see Dark mode below
  _homey-base.css        <- html/body base, .homey-widget/-small/-full padding
  _homey-text.css        <- .homey-text-bold/-medium/-regular/-small/-small-light/-align-*
  _homey-icons.css       <- [class^='homey-custom-icon-'] sizing - unused by this widget (its
                             trend arrows/question/dash glyphs are inline <svg>, not this class)
  _homey-borders.css     <- .homey-border/-top/-right/-bottom/-left/-start/-end
  _homey-tables.css      <- .homey-table / .homey-table-striped
fonts/
  Roboto-Regular.ttf         <- byte-identical to ../font/roboto/Roboto-Regular.ttf
  Roboto-Medium.ttf          <- byte-identical to ../font/roboto/Roboto-Medium.ttf
  Roboto-Bold.ttf            <- byte-identical to ../font/roboto/Roboto-Bold.ttf
  Roboto-RegularItalic.ttf
  NotoSansArabic-Regular.ttf
  NotoSansArabic-Bold.ttf
  NotoSansArabic-Medium.ttf
  NotoSansArabic-Black.ttf
```

The three Roboto weights are byte-for-byte identical to `../font/roboto/`'s copies (confirmed via
`diff` against this app's own already-fetched pair-view tree) - Homey serves the same font binary
from both asset trees, just at different paths (`fonts/Roboto-Regular.ttf` here vs
`font/roboto/Roboto-Regular.ttf` there).

`css/_homey-variables.css` is a different file from `../css/_homey-variables.css` (the pair-view
copy), not the same file at two paths: different variable-naming scheme
(`--homey-color-mono-010` here vs `--homey-color-mono-0`/`-01`/... there), a **different real
`--homey-su` value** (this copy: `4px`; the pair-view copy: `8px` - see CLAUDE.md's Pairing
section for why that distinction matters over there), and this copy alone defines
`--homey-table-head-color`, `--homey-line-light`, and `--homey-icon-size-medium`, none of which
exist in the pair-view copy.

## Fonts

`_homey-fonts.css` declares Roboto at four weights/styles and NotoSansArabic at four weights, all
via `url(../fonts/<name>.ttf)` - a flat `fonts/` folder, not the pair-view tree's per-family
`font/<family>/` subfolders. Only Regular/Medium are reachable from
`widgets/glucose-dashboard/public/index.html` today - it uses `.homey-text-bold`/`.homey-text-small`/
`.homey-text-small-light`/`.homey-text-regular` (mapping to bold/regular/small weights, see
`_homey-text.css`), plus one `div.window-pill` override to `--homey-font-weight-medium` (see that
file's own comment on why the override is written that way) - never italic or Arabic.

## Icons

`_homey-icons.css` only sizes/colors a `homey-custom-icon-*`-prefixed class via
`-webkit-mask-size`/`background-color` - it does not bundle any icon SVGs of its own the way the
pair wizard's `_homey-icon.css` bundles `arrow-left.svg`/`arrow-right.svg`. This widget's trend
arrows and the question/dash glyphs for the two non-directional trends are inline `<svg>` markup
(`TREND_ICON_INNER`/`trendIconSvg` in `public/index.html`), styled via plain CSS
(`stroke`/`fill`/`width`/`height`), not this class - nothing to fetch here either way.

## Dark mode

`css/_homey-variables.css` carries a `.homey-dark-mode { ... }` block redeclaring every
mono/background/text-color-light/line/icon token the rest of this tree uses, scoped to that
class. There is no separate dark stylesheet on the server
(`_homey-variables-dark.css` does not exist); one file carries both light and dark.
`test/widget-preview.html`'s Light/Dark buttons toggle `.homey-dark-mode` on the iframe's
`<html>` once the base sheet (which defines that block) is loaded - the same mechanism
`family.bothe.chargeiq`'s own harness uses.

This CSS file's own mechanism is **class-based, not media-query-based** - there is no `@media`
block anywhere in it, only `:root` and `.homey-dark-mode`. That's confirmed directly from the
file. What's *not* confirmed is the upstream trigger: Homey's own app has a Light/Dark/**System**
choice (Settings > Appearance), and it's unverified whether picking System ever surfaces to this
webview as a live `prefers-color-scheme` signal, or only ever as an already-resolved
`.homey-dark-mode` toggle indistinguishable from an explicit Light/Dark pick. Don't read
"class-based mechanism" as "Homey's theme is OS-independent, full stop" - that's a stronger claim
than this file actually supports.

This matters here specifically because `widgets/glucose-dashboard/public/index.html` *also* has
its own `@media (prefers-color-scheme: dark)` block, for the four `--spark-zone-*` tokens the
sparkline shades its severity bands with (see that file's own top-of-file comment). Those four
tokens have no Homey-provided equivalent (Homey's palette has no notion of "shaded glucose zone"),
so they can only ever pick up a dark value through that media query - the same documented "one
bespoke fallback token" pattern `family.bothe.chargeiq`'s own power-flow widget uses for its
`--icon-blue`, whose own top-of-file comment asserts (not independently confirmed on a device in
*this* repo) that a real device's webview reflects the raw OS state here even when Homey's own
resolved theme differs. If that's accurate, then whenever Homey's theme and the OS genuinely
disagree, these four tokens follow the OS while every other Homey-provided token on the card
follows Homey's own theme - a real on-device mismatch, not just a testing artifact. The widget
file's own `[data-theme='dark']`/`[data-theme='light']` blocks for these same four tokens exist
purely so this harness's Light/Dark buttons can force them independently of the real OS setting -
see that file's own comment - and are not something a real Homey ever sets.

**Net effect for the three preview buttons:**

- **Light** / **Dark** - forces both mechanisms together (`.homey-dark-mode` class for every real
  Homey-provided token, `[data-theme]` attribute for the four bespoke `--spark-zone-*` tokens) so
  the whole card previews consistently as one theme or the other. This is the normal way to eyeball
  the widget in either theme.
- **OS only** - not a third Homey theme (there is no "OS (Auto)" concept in the widget's own real
  CSS - see above). It clears both mechanisms: `.homey-dark-mode` comes off, so the real
  Homey-provided tokens sit at their light default regardless of the browser's own OS setting;
  the four bespoke tokens instead follow whatever `prefers-color-scheme` the browser/OS actually
  reports, via the widget's own `@media` block. This simulates the divergence case above (Homey's
  resolved theme is Light while the OS is Dark, or vice versa) - it's the one harness setting that
  actually exercises the `@media` block against a real OS/browser signal, which is why CLAUDE.md's
  Widget section calls out testing dark-mode edits with the OS/browser set to dark and the harness
  left on "OS only", not just clicking Dark - the Dark button alone only ever proves the
  `[data-theme='dark']` block, and a firmware/CSS change can edit one without the other by mistake
  (a real bug this exact drift caused once, see CLAUDE.md).

## Not covered

- This widget doesn't use `.homey-table*` or `.homey-border-*` at all (no tabular data, no drawn
  borders - `.card`'s edge is Homey's own dashboard tile chrome, not this widget's CSS).
- `_homey-fonts.css`'s italic and Arabic weights are unused, same as `family.bothe.chargeiq`'s own
  widget.
