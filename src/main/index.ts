import { app, shell, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { readdir, readFile, writeFile } from 'fs/promises';
import { networkInterfaces } from 'os';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { PosTransport } from './PosTransport';
import type { Channel, Status } from './PosTransport';
import type { PosConfig } from '../core/posTypes';
import { parsePricebook, resolvePricebookFilename, resolvePricebookDir } from '../core/pricebook';
import type { PricebookLoadResult } from '../core/pricebook';
import { parseQuickKeys, orderQuickKeyFiles, resolveQuickKeyDir } from '../core/quickkeys';
import type { QuickKeyFile, QuickKeyLoadResult } from '../core/quickkeys';
import { DATACENTERS, toGlobalInitConfig, configFromPlayerKeyFile, PLAYER_KEY_FILENAME, extractLocationCode } from '../core/globalInit';
import type { GlobalInitResult } from '../core/globalInit';
import type { AdsManifestResult, AdDetailResult, RawAdConfig } from '../core/adTriggers';

/** First non-internal MAC address (matches the player's GlobalInit param). */
function getMacAddress(): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') return iface.mac;
    }
  }
  return '00:00:00:00:00:00';
}

async function fetchDatacenterConfig(
  register: string,
  name: string,
  playerKey: string,
  product: string,
  mac: string,
): Promise<GlobalInitResult['config'] | null> {
  const url = new URL(register);
  url.searchParams.set('product', product);
  url.searchParams.set('initKey', playerKey);
  url.searchParams.set('macAddress', mac);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    console.log(`[GlobalInit] → ${name}: GET ${register} (initKey=${playerKey.slice(0, 8)}…, mac=${mac})`);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'CK-Player-2.0/1.0' } });
    console.log(`[GlobalInit]   ${name}: HTTP ${res.status}`);
    if (!res.ok) return null;
    const config = toGlobalInitConfig(await res.text(), name);
    if (config) {
      console.log(`[GlobalInit] ✅ ${name}: player.code=${config.playerCode} tenant=${config.tenant}`);
    } else {
      console.log(`[GlobalInit]   ${name}: 200 but no player.code in response`);
    }
    return config ?? null;
  } catch (err) {
    console.warn(`[GlobalInit]   ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Absolute path of a folder under the repo's bundled `resources/`. Tries the
 * candidates for dev (project root), packaged builds (resourcesPath), and the
 * built main dir, returning the first that exists so the emulator is
 * self-contained without an external liftck_player checkout.
 */
function bundledResourceDir(name: string): string {
  const candidates = [
    join(app.getAppPath(), 'resources', name),
    join(process.resourcesPath, name),
    join(__dirname, `../../resources/${name}`),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

const bundledQuickKeyDir = (): string => bundledResourceDir('quickkey');
const bundledPricebookDir = (): string => bundledResourceDir('pricebook');

let transport: PosTransport | null = null;

/** Absolute path of the persisted generated config (the legacy `player.key` file). */
function playerKeyFilePath(): string {
  return join(app.getPath('userData'), PLAYER_KEY_FILENAME);
}

/** Persist the generated `# Generated on …` block, mirroring the legacy `writePlayerKeyFile`. */
async function persistPlayerKeyFile(raw: string): Promise<void> {
  const path = playerKeyFilePath();
  try {
    await writeFile(path, raw, 'utf-8');
    console.log(`[GlobalInit] Wrote player.key file → ${path}`);
  } catch (err) {
    console.error(`[GlobalInit] Failed to write player.key file (${path}):`, err);
  }
}

function registerEmulatorIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('emulator:connect', async (_evt, config: PosConfig) => {
    transport?.close();
    transport = new PosTransport(config);
    transport.onStatus((status: Status) => {
      getWindow()?.webContents.send('emulator:status-changed', status);
    });
    // Forward completer injects (player→register) to the renderer to ring up.
    transport.onInject((cmd) => {
      getWindow()?.webContents.send('emulator:inject', cmd);
    });
    await transport.connect();
    return transport.status();
  });

  ipcMain.handle('emulator:disconnect', () => {
    transport?.close();
    transport = null;
    return { vj: 'disconnected', pole: 'disconnected' } satisfies Status;
  });

  ipcMain.handle('emulator:send', (_evt, payload: { channel: Channel; data: string }) => {
    return transport?.send(payload.channel, payload.data) ?? false;
  });

  ipcMain.handle('emulator:status', () => {
    return transport?.status() ?? ({ vj: 'disconnected', pole: 'disconnected' } satisfies Status);
  });

  // Load the OCT2000 pricebook that corresponds to the player code in use:
  // Circle K names exports `<siteCode>-<timestamp>.xml`, so we pick the match.
  ipcMain.handle(
    'pricebook:load',
    async (_evt, req: { dir?: string; playerCode: string }): Promise<PricebookLoadResult> => {
      const { playerCode } = req;
      // No external dir → use the bundled sample, picking the first .xml as a
      // last resort since its name can't match an arbitrary player code.
      const usingBundled = (req.dir ?? '').trim() === '';
      const dir = resolvePricebookDir(req.dir, bundledPricebookDir());
      console.log(`[Pricebook] Loading for player code "${playerCode}" from ${dir}${usingBundled ? ' (bundled)' : ''}`);
      try {
        const files = await readdir(dir);
        const filename = resolvePricebookFilename(files, playerCode, { fallbackToFirst: usingBundled });
        console.log(`[Pricebook]   matched file: ${filename ?? '(none)'}`);
        if (!filename) {
          return {
            ok: false,
            count: 0,
            entries: [],
            path: dir,
            error: `No pricebook matching player code "${playerCode}" in ${dir}`,
          };
        }
        const full = join(dir, filename);
        const xml = await readFile(full, 'utf-8');
        const entries = parsePricebook(xml);
        console.log(`[Pricebook]   parsed ${entries.length} items from ${filename}`);
        return { ok: true, count: entries.length, entries, path: full };
      } catch (err) {
        return {
          ok: false,
          count: 0,
          entries: [],
          path: dir,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Load every *.qk quick-key file from a folder (usualsuspects pinned first),
  // mirroring the legacy emulator's quickkey/ directory scan. When no folder is
  // requested, fall back to the .qk files bundled with this repo so the emulator
  // works on a fresh clone without an external liftck_player checkout.
  ipcMain.handle('quickkeys:load', async (_evt, req: { dir?: string }): Promise<QuickKeyLoadResult> => {
    const dir = resolveQuickKeyDir(req.dir, bundledQuickKeyDir());
    console.log(`[QuickKeys] Loading *.qk from ${dir}`);
    try {
      const names = orderQuickKeyFiles((await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.qk')));
      const files: QuickKeyFile[] = [];
      for (const name of names) {
        const text = await readFile(join(dir, name), 'utf-8');
        const entries = parseQuickKeys(text);
        console.log(`[QuickKeys]   ${name}: ${entries.length} keys`);
        files.push({ file: name, entries });
      }
      return { ok: true, files, dir };
    } catch (err) {
      return { ok: false, files: [], dir, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Ads triggers & completers. Two-step (lazy) to keep the UI snappy:
  //   ads:load     → GET …/manifests?collectionKey=ads → just the ad list (id + name). Fast.
  //   ads:adDetail → GET …/elastic/ads/_doc?id=…       → ONE ad's full doc, on demand.
  // Mirrors the CKPlayer2.0 ContentWorker fetch flow.
  const adsBackendContext = (req: {
    backendBaseUrl: string;
    playerCode: string;
    playerKey: string;
  }): { origin: string; tenant: string; locationCode: string; playerCode: string; playerKey: string } | null => {
    const playerCode = req.playerCode?.trim();
    const playerKey = req.playerKey?.trim();
    // "https://host/api/lift/" → "https://host"
    const origin = (req.backendBaseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/api\/lift.*$/i, '');
    const tenant = (playerCode?.split('-')[0] ?? '').toLowerCase();
    if (!origin || !tenant || !playerCode || !playerKey) return null;
    return { origin, tenant, locationCode: extractLocationCode(playerCode), playerCode, playerKey };
  };

  const fetchJsonWithTimeout = async (url: string, timeoutMs = 10000): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'CK-Canada-Emulator/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  ipcMain.handle(
    'ads:load',
    async (_evt, req: { backendBaseUrl: string; playerCode: string; playerKey: string }): Promise<AdsManifestResult> => {
      const ctx = adsBackendContext(req);
      if (!ctx) return { ok: false, ads: [], error: 'Need backend URL, player code, and player key (register first).' };
      try {
        const today = new Date();
        const end = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
        const ymd = (d: Date): string => {
          const p = (n: number): string => n.toString().padStart(2, '0');
          return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
        };
        const mparams = new URLSearchParams({
          playerCode: ctx.playerCode,
          playerKey: ctx.playerKey,
          locationCode: ctx.locationCode,
          collectionKey: 'ads',
          startDate: ymd(today),
          endDate: ymd(end),
        });
        const manifestUrl = `${ctx.origin}/api/lift/${ctx.tenant}/manifests?${mparams}`;
        console.log(`[Ads] Fetching ads manifest: ${manifestUrl}`);
        const manifest = (await fetchJsonWithTimeout(manifestUrl)) as { data?: Array<{ id: string | number; name?: string }> };
        const items = Array.isArray(manifest?.data) ? manifest.data : [];
        console.log(`[Ads] Manifest returned ${items.length} ad(s)`);
        return { ok: true, ads: items.map((it) => ({ id: String(it.id), name: it.name ?? String(it.id) })) };
      } catch (err) {
        console.error('[Ads] manifest load failed:', err);
        return { ok: false, ads: [], error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'ads:adDetail',
    async (
      _evt,
      req: { backendBaseUrl: string; playerCode: string; playerKey: string; id: string },
    ): Promise<AdDetailResult> => {
      const ctx = adsBackendContext(req);
      if (!ctx || !req.id) return { ok: false, error: 'Missing player config or ad id.' };
      try {
        const dparams = new URLSearchParams({
          id: req.id,
          playerCode: ctx.playerCode,
          playerKey: ctx.playerKey,
          excludes: 'keywords',
        });
        const doc = (await fetchJsonWithTimeout(`${ctx.origin}/api/lift/${ctx.tenant}/elastic/ads/_doc?${dparams}`)) as {
          data?: Array<{ json?: RawAdConfig }>;
        };
        const json = Array.isArray(doc?.data) && doc.data[0]?.json ? doc.data[0].json : null;
        if (!json) return { ok: false, error: `No ad doc for id ${req.id}` };
        return { ok: true, ad: json };
      } catch (err) {
        console.error(`[Ads] ad doc ${req.id} load failed:`, err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // GlobalInit: send the player.key to each datacenter's services/init and
  // return the first generated config (player.code + tenant endpoint URLs).
  // Mirrors CKPlayer2.0 GlobalInitClient + the legacy Java player.
  ipcMain.handle(
    'globalinit:register',
    async (_evt, req: { playerKey: string; product?: string }): Promise<GlobalInitResult> => {
      const playerKey = req.playerKey?.trim();
      if (!playerKey) return { ok: false, error: 'No player.key provided' };
      const product = req.product?.trim() || 'ckplayer2';
      const mac = getMacAddress();
      console.log(`[GlobalInit] Registering player.key=${playerKey.slice(0, 8)}… across ${DATACENTERS.length} datacenters (product=${product})`);
      try {
        const results = await Promise.allSettled(
          DATACENTERS.map((dc) => fetchDatacenterConfig(dc.register, dc.name, playerKey, product, mac)),
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) {
            console.log(`[GlobalInit] Done — registered as ${r.value.playerCode} on ${r.value.datacenter}`);
            // Persist the generated config so endpoints survive a restart (legacy player.key file parity).
            await persistPlayerKeyFile(r.value.raw);
            return { ok: true, config: r.value };
          }
        }
        console.warn('[GlobalInit] Not registered on any datacenter');
        return { ok: false, error: 'player.key not registered on any datacenter (or network unreachable)' };
      } catch (err) {
        console.error('[GlobalInit] register failed:', err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Load the persisted player.key file (if any) so the renderer can rehydrate
  // the generated config + endpoints on startup without re-registering.
  ipcMain.handle('globalinit:load', async (): Promise<GlobalInitResult> => {
    const path = playerKeyFilePath();
    try {
      const raw = await readFile(path, 'utf-8');
      const config = configFromPlayerKeyFile(raw);
      if (!config) {
        return { ok: false, error: 'player.key file present but has no player.code' };
      }
      console.log(`[GlobalInit] Loaded player.key file ← ${path} (player.code=${config.playerCode})`);
      return { ok: true, config };
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return { ok: false, error: 'No persisted player.key file yet' };
      }
      console.error(`[GlobalInit] Failed to read player.key file (${path}):`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 1000,
    // Low minimums so the window can be parked at a quarter of a laptop screen;
    // the renderer's compact layout (mode = one region) takes over below ~720px.
    minWidth: 380,
    minHeight: 320,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  });

  win.on('ready-to-show', () => {
    win.show();
  });
  win.on('closed', () => {
    mainWindow = null;
  });

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow = win;
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.rocketpartners.canada-emulator');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerEmulatorIpc(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
