# Quick Keys from `.qk` files — design

**Date:** 2026-06-04
**Status:** approved (brainstorming) → implementing

## Problem

Quick keys are hardcoded (`PRICEBOOK` constant, 6 CAD items) in a fixed 2-wide
grid. We want them driven by the legacy `usualsuspects.qk` format, shown 3×3 with
pagination, and colored green when the item has an ad — matching the legacy
emulator (`EmulatorUI.java:508–549`, `PaginatedQuickKeyPanel`).

## `.qk` format (legacy parity)

```
#upc|sendScan|description|quantity|price|iodevice1|iodelay1|iodata1|...
028200009654|true|Marlboro 72 GLD BX KG|1|5.99
```

Parsed **positionally and leniently** (exactly like legacy `split("|")`): comment
(`#`) and blank lines skipped; `upc` required; later fields optional. Malformed
rows are skipped, not fatal. We do not "fix" swapped/short rows — positional parity
with legacy avoids guessing.

## Coloring (legacy parity, minus age)

- **grey** — UPC not in the loaded pricebook (`lookupItem == null`)
- **green** — UPC ∈ `adCodes` (UPCs referenced by item-based ad triggers)
- age-restriction orange: **deferred** (OCT2000 pricebook carries no `minAge`)

## Architecture

- `src/core/quickkeys.ts` (pure, TDD): `parseQuickKeys(text) → QuickKeyEntry[]`,
  `paginate(items, perPage)`.
- Main: `quickkeys:load` IPC reads `*.qk` from a folder → `{ file, entries }[]`.
  Phase B: `ads:triggerCodes` fetches the ads manifest → `adCodes: string[]`.
- Renderer: replace the `PRICEBOOK` grid with tabs (one per `.qk`, `usualsuspects`
  first) → 3×3 paginated grid; green if `adCodes.has(upc)`, grey if not in
  `pricebookIndex`. Tap fires the existing add path. (`sendScan` is parsed for
  format parity but is intentionally a no-op: legacy forces `sendScan=false`
  on Canadian registers — `Radiant6RegisterEmulator.java:82`, "no scanner" —
  and the flag never gated whether the item is added.)

## Sequencing

- **Phase A** (this repo, fully testable): parser + pagination + folder load + tabs
  + 3×3 grid + grey + tap-to-fire.
- **Phase B** (needs live backend): manifest fetch → `adCodes` extraction → green.

## Defaults

- `.qk` folder defaults to
  `…/liftck_player/module-app-liftck-emulator/files/quickkey` (mirrors the existing
  `DEFAULT_PRICEBOOK_DIR` pattern).
