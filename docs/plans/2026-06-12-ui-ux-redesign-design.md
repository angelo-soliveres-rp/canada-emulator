# Canada POS Emulator — UI/UX Redesign (Design)

**Date:** 2026-06-12
**Status:** Proposed — awaiting review
**Scope:** Full presentation-layer redesign of the renderer (`src/renderer/`). The
emulator engine (`src/core/`, `electron/`, `src/preload/`, `useEmulator.ts`) is
**not touched** — no wire-format, socket, or IPC changes. Existing tests must
continue to pass unchanged.

---

## 1. Context

The emulator is a developer/QA tool: a standalone Electron + React app that drives
CK Player 2.0 by emitting the Radiant6-Canada / Bulloch wire stream. The whole UI
currently lives in one `App.tsx` (406 lines) + one hand-rolled `App.css` (155
lines), with zero UI dependencies.

The current UI works but is utilitarian: two stacked header bars, an always-on raw
GlobalInit blob, and a 3-equal-column body (`Quick Keys + Triggers` | `Transaction`
| `Wire Log`). Pain points:

- **Connection state is buried** in two 10px header dots, yet "am I connected and
  emitting?" is the tool's primary question.
- **No workflow sense** — register -> connect -> ring -> observe isn't sequenced.
- **The equal 3-way split shortchanges the hero** (the wire log) and crams Quick
  Keys + Triggers into a third.
- **Brittle layout** — the CSS is full of comments fighting flex ratios and fixed
  heights to stop content shifting (a maintainability and visual-stability smell).
- **Flat hierarchy / density** — 10–13px everywhere, ad-hoc color semantics, small
  tap targets for a tool operated quickly.

## 2. Users & primary use cases

Operators (engineers / QA) use the emulator two ways, and the design optimizes for
both via an explicit mode switch:

1. **Control / drive the shopper screen (most common).** Focus is the *buttons* —
   quick keys, triggers, basket, tender. The wire log is irrelevant noise here.
2. **Verify the wire (occasional).** Focus is the *log* — reading and confirming the
   exact stream sent on the VJ/pole channels.

A third **Split** preset serves "watch both at once."

## 3. Goals & non-goals

**Goals**
- Make connection/emission state readable at a glance.
- Make Control mode fast: big tap targets, no log noise.
- Make Verify mode pleasant: filterable, searchable, autoscrolling log.
- One-click switch between Control / Split / Logs; remembered across launches.
- Reflow gracefully down to a quarter-MacBook window (and smaller).
- Replace the brittle flex hacks with a robust, token-driven layout.
- No behavior or wire-format regressions.

**Non-goals**
- No changes to the emulator engine, wire encoders, sockets, IPC, or GlobalInit
  logic.
- No new runtime dependencies (no Tailwind, no component library).
- No new emulator features (no new tender types, register types, etc.).

## 4. Design constraints

- **Zero new dependencies.** Pure React + CSS, using Vite-native CSS Modules and a
  global token stylesheet. Appropriate for a tiny internal Electron tool; keeps the
  diff self-contained.
- **No emojis anywhere.** Professional, restrained, "Ansible-level" tone. Identity
  is a clean wordmark + a thin red accent rule (red doubles as a restrained Canadian
  nod). All icons are small hand-authored inline SVGs (`currentColor`) or text
  labels — never emoji glyphs.
- **Responsive to small windows.** Must remain usable when minimized to ~a quarter
  of a MacBook screen (target down to ~480×360 logical px).
- **Engine untouched.** `useEmulator.ts` is the engine and stays as-is; this is a
  presentation refactor. New UI state (mode, log filters) lives in small presentational
  components or thin local hooks.

## 5. Visual language

A focused **operator-console** aesthetic — dark, layered, high-contrast, one
confident accent, restrained motion.

### 5.1 Design tokens (`tokens.css`, CSS custom properties on `:root`)

- **Surfaces (dark, layered):** `--bg` (canvas, near-black cool neutral),
  `--surface`, `--surface-raised`, `--border`, `--border-strong`.
- **Text:** `--text` (primary), `--text-muted`, `--text-faint`.
- **Accent (interactive):** `--accent` (a restrained, professional red — the brand /
  Canadian nod) + `--accent-hover`, `--accent-quiet` (low-alpha fill). Used for
  primary actions and brand.
- **Semantic states:** `--ok` (connected / money / tender, green), `--warn`
  (connecting, amber), `--danger` (void / disconnect, red-orange — distinct hue from
  the brand accent to avoid confusion), `--info` (VJ channel, blue).
- **Channels:** `--ch-vj` (blue), `--ch-pole` (warm/amber), `--ch-sys` (slate).
- **Spacing scale:** `--space-1..6` = 4 / 8 / 12 / 16 / 24 / 32 px.
- **Type scale:** `--text-2xs` 10 / `--text-xs` 11 / `--text-sm` 12 / `--text-base`
  13 / `--text-md` 15 / `--text-lg` 18 / `--text-xl` 24 / `--text-2xl` 30. The
  cramped 10–13px world gains a real hierarchy; the running Total renders large with
  tabular figures for a "register" feel.
- **Radius:** `--radius-sm` 4 / `--radius-md` 6 / `--radius-lg` 10.
- **Shadow:** `--shadow-1` (raised), `--shadow-2` (modal/drawer).
- **Motion:** `--dur-fast` 120ms / `--dur` 180ms / easing token; all motion wrapped
  in `@media (prefers-reduced-motion: reduce)` to disable.

### 5.2 Identity & icons

- **Wordmark:** "CANADA EMULATOR" set in a tight, slightly condensed treatment with
  a thin `--accent` rule beneath the mark. Optional minimal CSS/SVG monogram (a
  rounded square reading "CA") — geometric, not pictorial. No maple-leaf glyph.
- **Icons:** a tiny in-repo set of inline SVGs (gear/settings, chevrons, pause/play,
  copy, clear) drawn at 16px with `stroke="currentColor"`. Each has an `aria-label`.

### 5.3 Motion (purposeful, subtle)

- "LIVE" status dot: soft pulsing ring when connected.
- New wire-log lines: 120ms slide/fade-in.
- New / changed basket line: brief accent highlight.
- Modal / setup drawer: fade + small scale/slide in.

## 6. Layout system

### 6.1 Mode switch (the headline feature)

A segmented control in the command bar: **Control · Split · Logs**. The app root
carries `data-mode="control|split|logs"`; a single CSS `grid-template-areas` rule per
mode rearranges the body. No JS layout math. Selected mode persists to
`localStorage`.

The body has two logical regions — **Operate** (quick keys, triggers, basket, tender)
and **Log** (wire log) — whose prominence the mode controls.

**Control** (default — buttons are the hero):
```
+--------------------------------------------------------------+
| CANADA EMULATOR   * LIVE  VJ:5438* POLE:5439*  Radiant6 CA   | Control Split Logs  EN|FR  [gear]
+------------------------------------+-------------------------+
| QUICK KEYS              < 1/3 >    | TRANSACTION #42         |
| [   ] [  AD] [   ]                 | 1 Milk     1     2.49   |
| [   ] [   ] [   ]   (large keys)   | 2 Bread    1     3.10   |
| TRIGGERS & COMPLETERS              | Subtotal          5.59  |
| * Ad name...  [Triggers][Complet.] | Tax               0.73  |
| * Ad name...  [Triggers][Complet.] | TOTAL             6.32  |
|                                    | [ Cash ][ Next $ ][+$5][Void]
+--------------------------------------------------------------+
| > VJ 1007 TENDER...   (+128 events)            slim log peek |
+--------------------------------------------------------------+
```

**Logs** (verify — log is the hero, controls shrink to a still-usable rail):
```
+--------------------------------------------------------------+
| CANADA EMULATOR   * LIVE ...                 Control Split Logs
+---------------+----------------------------------------------+
| OPERATE rail  | WIRE LOG   All VJ Pole Sys   [search]  || [] x|
| [ ][ ][ ]     | 12:01:07 VJ    1011 ITEM...                  |
| triggers >    | 12:01:07 POLE  Solde du... (fr-CA)           |
| -- basket --  | 12:01:08 VJ    1022 ARRONDIR...              |
| total   6.32  | 12:01:09 VJ    1007 TENDER...                |
| [Cash][+$5]   | big, legible, filterable, autoscroll         |
+---------------+----------------------------------------------+
```

**Split** = balanced Operate (left) / Log (right) — the improved version of today.

### 6.2 Responsive breakpoints

Driven by `@media` on the Electron window (the window *is* the viewport), with
`@container` queries on panels where a panel needs to react independently.

- **Wide** (>= ~960px): full per-mode layouts as above.
- **Medium** (~640–960px): fewer columns; quick-key grid and rows shrink; command
  bar condenses (channel chips collapse into the LIVE pill's tooltip; register-type
  becomes a short chip).
- **Compact** (< ~640px wide **or** < ~520px tall — i.e. quarter-screen and below):
  the mode switch becomes the space strategy — each mode shows **one** region
  filling the window:
  - **Control:** Operate fills; the log-peek strip hides behind a single tappable
    "log" affordance.
  - **Logs:** Log fills; the Operate rail collapses to a slide-in panel toggled from
    the command bar.
  - **Split** in compact stacks the two regions vertically (Operate top, Log bottom)
    with each independently scrollable.
  - Command bar collapses to: status dot + mode switch + a "more" (overflow) menu
    holding locale, register type, and Setup.
  - Quick keys keep a minimum tap-target size; the grid reduces columns (3 -> 2)
    rather than shrinking keys below usability.

## 7. Component specification

All components live under `src/renderer/src/components/`, each with a co-located
`*.module.css`. Props are typed; `useEmulator` is consumed via a single `e` object
prop (as today) or via context — see §8.

- **CommandBar** — brand wordmark, `StatusCluster`, `ModeToggle`, locale toggle,
  Setup trigger, and (compact) overflow menu. Replaces both current header bars.
- **StatusCluster** — prominent connection state: a `LIVE / Connecting / Offline`
  pill with the pulsing dot, plus per-channel chips (`VJ :5438`, `POLE :5439`) each
  with their own dot, plus a register-type chip. This is the promoted status.
- **SetupDrawer** — slide-in panel holding the rarely-touched controls: host input,
  `player.key` input, Register / Connect / Disconnect buttons, and the GlobalInit
  result rendered as a tidy card (`player.code`, `tenant`, `datacenter`) with the raw
  payload behind a collapsible "raw" disclosure — replacing the always-on `<pre>`.
- **ModeToggle** — the Control / Split / Logs segmented control; persists to
  `localStorage`.
- **QuickKeys** — 3×3 paginated grid (preserves `QK_PER_PAGE` and the `.qk` /
  pagination logic). Bigger keys; ad-trigger keys carry a small "AD" corner tag +
  subtle accent ring (replacing the bare green fill, which stays as a secondary
  signal); cleaner pager; multi-file tabs become a small segmented control. A legend
  explains the AD marker.
- **TriggersCompleters** — same data flow and **auto-close-on-inject/tx behavior
  preserved** (`tx`, `injectSeq` effect). Refined rows with clearer interactive and
  has-completers badges + a legend. The modal becomes a clean sheet with an Esc-to-
  close handler and focus management; item cards keep code + description.
- **Basket** — table with right-aligned tabular numbers, clearer voided (strike +
  muted) state, line actions (`+1`, `-10¢`, `void`) as tidy buttons, a friendlier
  empty state, and a brief highlight when a line is added/changed.
- **Totals + Tender** — muted Subtotal/Tax, **large bold Total**; large color-coded
  tender buttons (`--ok` green for Cash exact / Next $ / +$5), Void Ticket clearly
  separated (`--danger`). Disabled-when-empty behavior preserved (`hasItems`).
- **WireLog** — the verify-mode upgrade. Toolbar: **channel filter chips
  (All / VJ / Pole / Sys, with live counts)**, **search** (substring filter over line
  text), **autoscroll toggle** (auto-on; pauses when the user scrolls up, resumes at
  bottom), **copy-all**, **clear**. Lines: relative/clock timestamp, color-coded
  channel pill, monospace payload; new lines slide in. Filtering/search is
  view-only and never mutates `e.log`.

## 8. File structure

```
src/renderer/src/
  App.tsx                 # shell: layout grid + data-mode, wires components, owns mode state
  tokens.css              # global :root design tokens (imported once)
  App.module.css          # app shell / grid-areas / responsive breakpoints
  hooks/
    useUiMode.ts          # mode state + localStorage persistence
    useLogView.ts         # channel filter + search + autoscroll (view-only over e.log)
  icons/
    index.tsx             # tiny inline-SVG icon set (currentColor, aria-labelled)
  components/
    CommandBar.tsx (+ .module.css)
    StatusCluster.tsx (+ .module.css)
    SetupDrawer.tsx (+ .module.css)
    ModeToggle.tsx (+ .module.css)
    QuickKeys.tsx (+ .module.css)
    TriggersCompleters.tsx (+ .module.css)
    Basket.tsx (+ .module.css)
    Tender.tsx (+ .module.css)
    WireLog.tsx (+ .module.css)
  useEmulator.ts          # UNCHANGED engine
```

`e = useEmulator()` is created once in `App` and passed down. Given the depth is
shallow (App -> component), prop-passing is fine; a small React context for `e` is an
acceptable alternative if prop drilling gets noisy. The old `App.css` is removed once
its rules are migrated into tokens + module styles.

## 9. Accessibility

- `:focus-visible` rings on all interactive elements.
- `aria-label` on every icon-only button; `aria-pressed` on toggles; the mode switch
  is a labelled radiogroup.
- Color is never the only signal (status pill carries text; AD keys carry a tag).
- `prefers-reduced-motion: reduce` disables all non-essential motion.
- Modal/drawer: focus trap, Esc to close, restore focus on close.
- Contrast targets WCAG AA for text on surfaces.

## 10. Success criteria / acceptance

- Connection state (overall + per channel) is legible at a glance in every mode and
  breakpoint.
- Control mode: quick keys/tender are large and the log does not compete for space.
- Logs mode: the log is the dominant, filterable, searchable, autoscrolling surface
  while basic ringing-up remains possible from the rail.
- Mode switch is one click and persists across launches.
- The app remains usable and uncluttered at ~480×360.
- No emoji anywhere in the rendered UI.
- `npm test` passes unchanged; `npm run typecheck` is clean; the emitted wire stream
  is byte-identical to before (engine untouched).

## 11. Open questions

1. **Brand accent = red?** Proposed: a restrained professional red as the interactive
   accent (brand + Canadian nod), with `--danger` a distinct red-orange for void.
   Acceptable, or prefer a neutral/blue interactive accent and keep red only for
   destructive actions?
2. **Keyboard quick-fire** (number keys 1–9 fire the visible quick keys) — nice for
   fast shopper-screen driving. Include now or defer?
3. **Mode set** — keep all three (Control / Split / Logs), or drop **Split** as
   redundant?
```
