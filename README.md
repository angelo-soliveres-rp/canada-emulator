# Canada POS Emulator

A standalone **Electron + React + TypeScript** desktop app that simulates a
Canadian register and emits the exact wire stream **CK Player 2.0**'s Canada
plugins consume. Use it to drive and test the player without physical POS
hardware.

Supports two register types:

- **Radiant6 Canada** — Virtual Journal (`EventId=…`) **+** Pole Display.
- **Bulloch** — **pole-display only** (`[C000]/[C110]/[C120]/[C121]/[C200]`); no
  virtual journal, mirroring the real Bulloch lane.

It replaces the empty `Radiant6CanadaRegisterEmulator` / `BullochRegisterEmulator`
stubs in the legacy `liftck_player` emulator module.

## What it emits

**Radiant6 Canada** (`radiant6-canada` register type)
- **Virtual Journal** (TCP, default `127.0.0.1:5438`): 1001 register open,
  1009 basket start, 1011 item add, 1012 void, 1013 price override, 1014 qty
  change, 1007 tender, 1008 change, 1022 **Arrondir** rounding, 1024
  **EasyPay/loyalty**, 1002 basket end.
- **Pole Display** (TCP, default `127.0.0.1:5439`): 20-char balance / change /
  item windows, **en-CA and fr-CA**.

**Bulloch** (`bulloch` register type)
- **Pole Display only** (TCP, default `127.0.0.1:5440`): `[C000] NEWSALE LANG=…`,
  `[C110] <barcode> <desc> QT= PR= AMT= STTL= DSC= TAX= TOTAL=`, `[C120] Undo
  Item`, `[C121] CLEAR SALE`, `[C200] Sale TRANS= TOTAL= CHNG= TAX=`. **No VJ
  socket is opened** for Bulloch (items are pole-authoritative).

Canada rules honoured: tax/balance are **pole-authoritative** (the Radiant6 VJ
never emits `1005`/`1020`); cash rounds to the nearest 5¢ and emits `Arrondir`;
fr-CA balance uses the legacy `dû` → `U+FFFD` → space substitution.

## Run

```bash
npm install
npm run dev      # launch the emulator (Electron) — renderer dev server on :5273
npm test         # unit + round-trip tests
npm run build    # typecheck + production build
```

> Launch order doesn't matter: the emulator's Vite dev server runs on **5273**
> (distinct from CK Player 2.0's `5173`), so starting it first no longer blanks
> the player. See *Tips*.

### Run as a web app (browser, LAN)

The same emulator also runs as a plain web server — open it at a URL instead of
the desktop window, with **identical functionality**. A small Node server holds
the TCP / filesystem / fetch logic (the part a browser can't do); the React UI is
unchanged and talks to it over one WebSocket.

```bash
npm run dev:web    # Vite UI on :5273 + API/WS server on :8788 (hot reload)
npm run serve      # production: build the UI, then serve it + API on :8788
```

Then open `http://<this-machine>:8788` from any device on the LAN. The desktop
Electron app (`npm run dev`) still works — both share one service implementation
(`src/server/emulatorService.ts`).

Server env knobs: `EMULATOR_PORT` (default `8788`), `EMULATOR_BIND` (default
`0.0.0.0`), `EMULATOR_TOKEN` (if set, append `?token=…` to the URL — the page
reuses it for the WebSocket), `EMULATOR_DATA_DIR` (where `player.key` is
persisted).

> The server binds `0.0.0.0` (LAN-reachable) by default and exposes register
> control + the persisted `player.key`. On an untrusted network set
> `EMULATOR_TOKEN`, or `EMULATOR_BIND=127.0.0.1` to keep it local. All connected
> browsers share one register session (one TCP link to the player), matching the
> single-window desktop behaviour.

## Bundled, self-contained fixtures

No external `liftck_player` checkout is required — the emulator ships its own:

- `resources/quickkey/usualsuspects.qk` — quick keys (legacy `usualsuspects`
  format), loaded automatically on startup.
- `resources/pricebook/sample.xml` — an OCT2000 sample pricebook (auto-loaded),
  so item descriptions/prices and quick-key colouring work out of the box.

## Register & connect (auto-detected backend)

1. Pick the **register type** in the top bar (`Radiant6 Canada` or `Bulloch`) —
   this sets the VJ/pole ports.
2. Paste your **player.key** in the creds bar and click **Register**. GlobalInit
   probes the datacenters, and the matching one (e2e / dev / prod) resolves the
   **player code + backend automatically** — you don't enter a backend URL.
3. Click **Connect** (status dots turn green).

## UI

- **Quick Keys** — fixed 3×3 paginated grid from the bundled `.qk`. Tapping fires
  an item; keys turn green when their UPC is an ad trigger.
- **Triggers & Completers** — loads the **live ads manifest** for the player and
  background-prefetches each ad's triggers/completers. Per ad: a 🟢/grey dot
  (has completers?), the **template name** with a blue accent for interactive
  (microsite/figs) templates, and **Triggers** / **Completers** buttons. Clicking
  a trigger scans it (with its real description) then opens the ad's completers;
  selecting a completer scans it. The modal auto-closes when CK Player 2.0 acts
  on the offer (completer inject) or the transaction ends.
- **Transaction** — the running basket + tender (Cash exact / Next $ / +$5 /
  Void).
- **Wire Log** — everything sent on the VJ/pole channels.

## Verify against CK Player 2.0

1. Configure the CK Player 2.0 Canada register in `system.properties`:
   - **Radiant6 Canada:** `virtualjournal.ioParams=TCP:5438`,
     `poledisp.className=plugins/radiant6-canada/Radiant6CanadaPoleDisplay`,
     `poledisp.ioParams=TCP:5439`.
   - **Bulloch:** `register.className=plugins/bulloch/BullochRegister`,
     `register.realTimeInputs=poledisp`,
     `poledisp.className=plugins/bulloch/BullochPoleDisplay`,
     `poledisp.ioParams=TCP:5440`.
2. Start CK Player 2.0 (it listens on those ports), then the emulator → Connect.
3. Tap quick keys / scan / tender. The matching register type's items appear in
   the player's basket and shopper receipt.

> The `parser-roundtrip` test imports CK Player 2.0's **real** Radiant6 Canada
> parsers from the sibling repo and asserts the emulator's output decodes to the
> expected `RegisterEvent`s — automated proof of compatibility.

## Tips

- **Launch order is free.** The emulator's renderer dev server is pinned to
  **5273** (`electron.vite.config.ts`), separate from CK Player 2.0's `5173`
  (which CKP2 requires via `strictPort`). Previously both defaulted to `5173`, so
  starting the emulator first stole the port and CK Player 2.0 rendered a
  **blank/white screen** — that's fixed; start them in any order.
- **Bulloch** connects pole-only — the VJ socket is intentionally never opened,
  so there's no `5438` reconnect spam in that mode.
- The completer modal **auto-closes** when CK Player 2.0 acts on the offer (a
  completer inject over the VJ reverse channel) or the transaction ends.

## Architecture

- `src/server/` — Node backend shared by **both** entry points: `emulatorService`
  (pricebook / quick-keys / ads-manifest fetch, GlobalInit registration, and
  transport control) plus `PosTransport` (TCP client socket(s) + auto-reconnect;
  pole-only for Bulloch). `index.ts` is the standalone web server — serves the
  built UI and exposes the service over one WebSocket (RPC + pushed events).
- `src/main/` (Electron) — thin: window creation + IPC handlers that delegate to
  `emulatorService`.
- `src/core/` — pure, browser-safe, unit-tested: `currency`, `Basket`,
  `Radiant6CanadaEncoder`, `BullochEncoder`, `RegisterSession` (routes by
  register type), `quickkeys`, `pricebook`, `adTriggers`, `globalInit`,
  `posTypes`, `webRpc` (shared client/server message protocol).
- `src/renderer/` — React UI (`useEmulator` hook over `RegisterSession`). The
  only platform seam is `window.emulator` (`EmulatorBridge`).
- `src/preload/` — typed `window.emulator` bridge for Electron (IPC).
- `src/renderer/src/bridge/webEmulator.ts` — the same bridge for the web build,
  backed by a WebSocket.

Plans and designs: `docs/plans/`.
