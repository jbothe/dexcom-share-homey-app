# Homey Style Library (dev-only, committed, never shipped)

Athom's own CSS, fonts and icons, exactly as a Homey serves them to a pairing wizard, so
`test/pair-login-preview.html` can render `drivers/follower/pair/login.html` against the real
injected styling. Nothing in `app.json` or `driver.compose.json` references `test/`, so none of
this is packaged with the app.

Stored **verbatim** — original filenames and folder layout, no combining or renaming — so the
relative `@import` and `url()` paths inside the files resolve unchanged, and the committed copies
stay byte-comparable against a live Homey.

## Refreshing

```bash
HOMEY_ASSETS_BASE='https://<your-homey-id>.connect.athom.com/manager/webserver/assets' \
  ./test/homey-css/fetch.sh && git diff --stat test/homey-css
```

`fetch.sh` re-downloads all 25 files in place; `git diff` then shows whether a firmware update
changed the pair screen. It rejects any response that is an HTML error page rather than writing
it over a good file, and leaves existing copies untouched if anything fails. Find
`<your-homey-id>` in the URL bar with the Homey web app open. No authentication is needed.

**`icons/` and `img/` are siblings of `css/`, not children.** The sheets reach them as
`../icons/` and `../img/`. A `css/`-relative URL returns a 404 whose body is an HTML error page,
which then saves under the right filename and passes any does-the-file-exist check:

```
assets/icons/chevron-down-regular.svg      not  assets/css/icons/…
assets/img/spinner.svg                     not  assets/css/img/…
```

**`homey.css` vs `homey.drivers.css`** — similar names, unrelated files. The first is the Style
Library manifest (all `@import`s, no rules of its own); the second is the pairing wizard chrome.
There is no `homey-drivers.css` or `homey-app.css` on the server.

## Layout

```
test/homey-css/
  css/
    homey.css                <- Style Library manifest: @imports only, no rules
    homey.drivers.css        <- pairing wizard chrome (#hy-wrap / #hy-views / .hy-view)
    _homey-variables.css     <- --homey-* custom properties (colors, --homey-su-* spacing)
    _base.css                <- reset / base element styles
    _homey-typography.css    <- .homey-title / .homey-subtitle / .homey-text-align-*
    _homey-button.css        <- .homey-button-* (incl. .homey-button-primary-full)
    _homey-form.css          <- .homey-form / -group / -label / -input / -select
    _homey-icon.css          <- .homey-icon-arrow-{left,right}
  font/
    roboto/roboto.css        <- + its .ttf files (see Fonts)
    notosansarabic/notosansarabic.css
    fontawesome/fontawesome.css
  icons/
    chevron-down-regular.svg <- Region <select> dropdown chevron            [pair view]
    checkmark.svg
    checkmark-square-empty.svg
    checkmark-square-fill.svg
    arrow-left.svg           <- RTL swaps the pair
    arrow-right.svg
  img/
    spinner.svg              <- Continue button's .is-loading state         [pair view]
    throbber-black.svg       <- .hy-throbber-black, #hy-overlay-loading
    throbber-white.svg
    search.png               <- 32x32
    search-clear.png         <- 32x32
```

That is every `url()` referenced by the six partials and `homey.drivers.css`. Only the two marked
`[pair view]` are reachable from the login screen; the rest cover checkboxes, radios, wizard nav,
the loading overlay and search fields, and are kept so other views don't need another download.

Without the six `_*.css` partials the pair screen renders essentially unstyled — `homey.css`
alone carries no rules.

## Fonts

`font/*/*.css` declares `@font-face` rules pointing at **`.ttf`** files beside them. Without the
binaries the browser falls back to a system font, and font metrics are what this harness exists
to get right.

`roboto.css` declares eight faces, but only three weights are reachable from the pair screen:

| Weight | File | Used by |
|---|---|---|
| 700 | `Roboto-Bold.ttf` | `.homey-title` |
| 500 | `Roboto-Medium.ttf` | `[class*='homey-button']`, incl. `.homey-button-primary-full` |
| 400 | `Roboto-Regular.ttf` | `.homey-subtitle`, form labels, inputs, `<select>` |

A missing weight is synthesised from Regular, with the wrong metrics. Noto Sans Arabic and Font
Awesome matter only for RTL locales and Homey's icon glyphs; the harness names whichever files
are absent.

## Dark mode

Homey **inverts** a pair view rather than re-theming it, and the harness does the same:

```css
html { filter: invert(1) hue-rotate(180deg); }
```

That is the `--theme-filter-dark-mode` Homey's own web app defines
(`:root, .lightTheme { none }` / `.darkTheme { invert(1) hue-rotate(180deg) }`). `invert(1)` flips
lightness; the `hue-rotate(180deg)` restores hues, so blues stay blue. Filtering the root inverts
its own background too, so `_base.css`'s `--homey-color-white` renders `#000`.

The Style Library has **no dark values at all** — no `prefers-color-scheme` query, no
`[data-theme]` selector, no `@media` block in any partial. On a real Homey in dark mode, inside
the wizard's frame, `--homey-color-white` still computes to `#fff` while the screen renders dark.
Nothing here changes between light and dark, which is why switching theme downloads nothing.

Inversion is also the only mechanism available: the wizard is served from
`<id>.connect.athom.com` and the shell from `my.homey.app`, so the shell cannot reach into the
wizard's DOM to re-theme it. A filter on the frame needs no DOM access. (`my.homey.app`'s own
bundle does theme itself, via a `--theme-*` namespace and a `.darkTheme` class, but contains zero
`--homey-*` tokens and never touches a pair view.)

### Consequences for `pair/login.html`

- Everything inverts wholesale and **no `--homey-*` token can opt out**. An image added to this
  screen renders negated in dark mode. There are none today.
- A hardcoded colour is not the light-only bug it would be under a themed system — it inverts
  along with everything else. Style Library tokens still matter for light-mode fidelity.
- White text becomes black; the Continue button's label does this on-device too.

## Not covered

`Homey.alert()`'s modal is in none of these stylesheets (`homey.drivers.css` covers only
`#hy-overlay-loading`), so the harness shows a clearly-labelled approximation of it.
