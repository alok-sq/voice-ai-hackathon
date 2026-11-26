# Dark mode for the voice agent console: "Night sky"

Date: 2026-11-26 · Scope: `web/` only · Size: small change

## Intent

The console gets a dark theme that continues the "Sunrise" look into night. The page becomes a deep navy sky, the cards are slightly lighter navy, the text is warm off-white, and Pari's sun orb reads as the sun before dawn. The brand blue and sun yellow keep their hues.

## Goals

- A dark theme across every screen: call view, history, session replay, intro dialog, sidebar.
- It follows the laptop's light/dark setting by default. A top-bar button overrides that, and the choice is remembered.
- No white flash on load in dark mode.
- Native controls (select menus, scrollbars, inputs) turn dark too.

## Non-goals

- Renaming colour roles into semantic tokens (option B), as noted under Approaches.
- A three-way "system / light / dark" picker. The button switches between light and dark only; with no saved choice, the console follows the system setting.
- Adding dark mode to the SolarSquare design system itself.

## Anti-goals

- **The light theme must not change at all.** It is the one being demoed on 27 Nov. Every light value stays exactly as it is.
- Any text that fails contrast in dark: body text at least 4.5:1, hints and captions at least 3:1.

## Approaches

- **A. Flip the colour scales in dark mode (chosen).** Each scale step keeps its role (`-50`/`-100` = faint tint behind something; `-600`/`-700` = strong text on that tint), and only the values change under `:root[data-theme="dark"]`. Radix Colors works the same way. It needs one dark-mode CSS block and leaves light mode untouched. The cost is that a few places use a raw step for its literal colour, so they are checked by hand (listed below).
- **B. Give every role its own semantic token.** About 110 raw uses in `app.css` and the rooftop SVG would become role-named tokens such as `--good-tint-bg`. It is cleaner, but it rewrites most of the stylesheet the night before the demo and risks the light theme. Deferred until after the hackathon.
- A separate dark stylesheet was dropped because it duplicates every rule.

## Design

### How the theme is chosen

- `<html data-theme="light|dark">` is the single switch for all styles. JavaScript resolves the theme, so the CSS has no `prefers-color-scheme` media query to keep in sync.
- The saved choice lives in `localStorage["console.theme"]` as `"light"` or `"dark"`. When nothing is saved, the console follows `matchMedia("(prefers-color-scheme: dark)")` and updates live if the OS setting changes.
- A small inline script in `index.html` sets `data-theme` before first paint, so there is no flash. Storage access is wrapped in try/catch; if storage is unavailable, the console falls back to the system setting.
- A pure `resolveTheme(saved, systemPrefersDark)` function in `state/theme.ts` is unit-tested. A `useTheme()` hook applies the theme, listens for OS changes and saves the user's choice, mirroring `useSoundPreference`.
- `:root { color-scheme: light }` and `[data-theme="dark"] { color-scheme: dark }` turn native controls dark.

### Top-bar button

- An icon button in the `.tools` group next to the sound toggle. It shows a moon in light mode and a sun in dark mode.
- It has `aria-label="Dark mode"` and `aria-pressed` set to whether dark is on, with a title of "Dark mode on/off".
- Switching has no animated transition, to avoid every element animating its colour at once.

### Night-sky palette (starting values; the builder tunes them against the contrast targets)

**Neutrals (`--ink-*`) become navy neutrals.** The semantic tokens (`--bg-page: var(--ink-25)` and the rest) then follow automatically.

| step | light (unchanged) | dark |
|---|---|---|
| `--ink-0` (surface) | #FFFFFF | #0D1836 |
| `--ink-25` (page) | #FBFAF7 | #060F2A |
| `--ink-50` (sunken) | #F5F4EF | #091230 |
| `--ink-100` | #ECEAE2 | #16224A |
| `--ink-200` (border-1) | #DCD9CE | #22305A |
| `--ink-300` (border-strong) | #BDB9AB | #33436E |
| `--ink-400` (fg-4) | #8E8B7E | #77808F |
| `--ink-500` (fg-3) | #5F5D54 | #9EA3AE |
| `--ink-600` (fg-2) | #3F3E37 | #C9C8C0 |
| `--ink-700` / `--ink-800` | … | #DEDCD4 / #ECEAE3 |
| `--ink-900` (fg-1) | #0E0D0B | #F4F2EB |

**Hue tints (`-50`, `-100`, `-200`) for blue, sun, leaf and rust** become low-opacity versions of the hue on navy. For example, `--sun-50` becomes `rgba(255,193,31,.12)` and `--leaf-50` becomes `rgba(43,168,74,.16)`; `-100` uses about .22 and `-200` about .32.

**Text steps (`-600`, `-700`)** become light versions of the hue. For example, `--blue-700` becomes about #9DBBFF, `--sun-700` about #FFD24A, `--leaf-600` about #5CCB78 and `--rust-600` about #F08A68.

**Brand mid-steps (`-300`–`-500`) and deep steps (`-800`–`-950`) do not change.** That keeps the brand blue, the sun orb and the solar panel's navy cells exactly as they are.

**Semantic exceptions:**
- `--fg-on-accent` is pinned to #0E0D0B, because text on yellow must stay dark.
- `--fg-link` uses blue-300.
- `--border-brand` uses blue-400.
- Shadows use black at higher opacity, so cards stand out by being lighter than the page and by their 1px border more than by their shadow.

### Checked by hand (places that use a literal colour)

- Sun orb glow and rays: keep the yellow, and possibly strengthen the glow on navy.
- Solar panel cells (`--blue-950` / `--blue-500`) and the sparkle `#FFFFFF`: unchanged.
- Intro dialog: the sunrise wash and the `::backdrop` scrim, which needs to be darker on navy.
- Sidebar note gradient: a dimmer dark version.
- `RooftopIllustration.tsx`: uses `blue-100`–`300`, `sun-200`/`300` and `ink-100`. Check that the flipped tints still read as a rooftop at dawn.
- Status chips, the "expected outcome" chip, outcome badges and the summary card: tint background plus strong text on navy.
- Mask gradients (`#000`) are masks, not colours, so they are ignored.

## Verification

- Unit tests for `resolveTheme` cover: saved choice beats system, no saved choice follows system, and a bad stored value is ignored.
- Type check, all tests and the build pass.
- Screenshots of both themes on the call view (idle and mid-call), history, a session and the intro dialog. The light-theme screenshots must match the current build.
- Contrast spot-checks on fg-2, fg-3 and fg-4 and on the chip text in dark.

## Left to the builder

The exact hex/alpha values within the targets above, the glow strength on the orb, and the dark versions of the two sunrise gradients.
