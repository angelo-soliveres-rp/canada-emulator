/**
 * EmulatorService — transport-agnostic core of the emulator's "main process".
 *
 * Holds the single PosTransport (TCP client to the player) plus the filesystem
 * and HTTP-fetch handlers that used to live inline in the Electron main process.
 * Both entry points delegate here so there is ONE implementation:
 *   - Electron main  → wraps each method in `ipcMain.handle`
 *   - Web server     → wraps each method in a WebSocket RPC dispatch
 *
 * Node-only (uses `net`/`fs`/`os`/`fetch`). All Electron/host-specific paths are
 * injected via the constructor so this module never imports `electron`.
 */
import { join, dirname } from 'path';
import { readdir, readFile, writeFile } from 'fs/promises';
import { networkInterfaces } from 'os';
import { gunzipSync, inflateSync } from 'zlib';
import { PosTransport } from './PosTransport';
import type { Channel, Status } from './PosTransport';
import type { PosConfig } from '../core/posTypes';
import { parsePricebook, resolvePricebookFilename, resolvePricebookDir } from '../core/pricebook';
import type { PricebookLoadResult } from '../core/pricebook';
import { parseQuickKeys, orderQuickKeyFiles, resolveQuickKeyDir } from '../core/quickkeys';
import type { QuickKeyFile, QuickKeyLoadResult } from '../core/quickkeys';
import {
  DATACENTERS,
  toGlobalInitConfig,
  configFromPlayerKeyFile,
  extractLocationCode,
} from '../core/globalInit';
import type { GlobalInitResult } from '../core/globalInit';
import type { AdsManifestResult, AdDetailResult, RawAdConfig } from '../core/adTriggers';
import type { InjectCommand } from '../core/injectProtocol';

export type { Channel, Status } from './PosTransport';

const IDLE_STATUS: Status = { vj: 'disconnected', pole: 'disconnected', scanner: 'disconnected' };

/** Host-specific paths injected by the entry point (Electron app dirs vs server cwd). */
export interface EmulatorServiceConfig {
  /** Absolute path of the file used to persist the generated `player.key` block. */
  playerKeyFilePath: string;
  /** Resolve the absolute path of a bundled resource subfolder (e.g. "quickkey"). */
  resolveResourceDir: (name: string) => string;
}

type StatusListener = (s: Status) => void;
type InjectListener = (cmd: InjectCommand) => void;

/**
 * The portal 403s the Electron User-Agent, so the pricebook fetch presents a
 * browser one — the same workaround the real player uses.
 */
const PRICEBOOK_DOWNLOAD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/** A real pricebook runs to tens of MB, so allow a generous window. */
const PRICEBOOK_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Refuse an absurd body rather than buffering it into memory. */
const PRICEBOOK_MAX_BYTES = 250 * 1024 * 1024;

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

async function fetchJsonWithTimeout(url: string, timeoutMs = 10000): Promise<unknown> {
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
}

/** True for a plain object (the only JSON shape we drill into). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** URL origin, or null when the string isn't a URL (empty endpoints etc.). */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// The fields are typed optional because they arrive off the wire — the
// null-return below is the validation, not defensive redundancy.
function adsBackendContext(req: {
  backendBaseUrl?: string;
  playerCode?: string;
  playerKey?: string;
}): { origin: string; tenant: string; locationCode: string; playerCode: string; playerKey: string } | null {
  const playerCode = req.playerCode?.trim();
  const playerKey = req.playerKey?.trim();
  // "https://host/api/lift/" → "https://host"
  const origin = (req.backendBaseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/api\/lift.*$/i, '');
  const tenant = (playerCode?.split('-')[0] ?? '').toLowerCase();
  if (!origin || !tenant || !playerCode || !playerKey) return null;
  return { origin, tenant, locationCode: extractLocationCode(playerCode), playerCode, playerKey };
}

export class EmulatorService {
  private transport: PosTransport | null = null;
  private readonly statusListeners = new Set<StatusListener>();
  private readonly injectListeners = new Set<InjectListener>();
  // Origins a client-supplied backendBaseUrl may target (SSRF guard for the
  // web RPC boundary): the static datacenter hosts, widened with the endpoint
  // origins each successful registration / persisted player.key returns.
  private readonly backendOrigins = new Set<string>(
    DATACENTERS.map((dc) => originOf(dc.host)).filter((o): o is string => o !== null),
  );

  constructor(private readonly config: EmulatorServiceConfig) {}

  /** Origins remote clients may pass as `backendBaseUrl` (see rpcGuards). */
  allowedBackendOrigins(): ReadonlySet<string> {
    return this.backendOrigins;
  }

  /** Trust the endpoint origins a registered datacenter handed back. */
  private trustEndpointOrigins(endpoints: Record<string, string>): void {
    for (const url of Object.values(endpoints)) {
      const origin = originOf(url);
      if (origin) this.backendOrigins.add(origin);
    }
  }

  /** Subscribe to status changes; returns an unsubscribe function. */
  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /** Subscribe to completer injects from the player (VJ reverse channel). */
  onInject(cb: InjectListener): () => void {
    this.injectListeners.add(cb);
    return () => this.injectListeners.delete(cb);
  }

  private emitStatus(s: Status): void {
    for (const l of this.statusListeners) l(s);
  }

  private emitInject(cmd: InjectCommand): void {
    for (const l of this.injectListeners) l(cmd);
  }

  // --- Transport (TCP client to the player) ---------------------------------

  async connect(config: PosConfig): Promise<Status> {
    this.transport?.close();
    const transport = new PosTransport(config);
    transport.onStatus((status) => this.emitStatus(status));
    // Forward completer injects (player→register) so the UI can ring them up.
    transport.onInject((cmd) => this.emitInject(cmd));
    this.transport = transport;
    await transport.connect();
    return transport.status();
  }

  // Async for signature consistency with `EmulatorBridge.disconnect()` — the
  // close itself is synchronous.
  async disconnect(): Promise<Status> {
    this.transport?.close();
    this.transport = null;
    // Broadcast so every connected client (web) reflects the disconnect.
    this.emitStatus({ ...IDLE_STATUS });
    return { ...IDLE_STATUS };
  }

  send(payload: { channel: Channel; data: string }): boolean {
    return this.transport?.send(payload.channel, payload.data) ?? false;
  }

  status(): Status {
    return this.transport?.status() ?? { ...IDLE_STATUS };
  }

  // --- Pricebook ------------------------------------------------------------

  // Load the OCT2000 pricebook that corresponds to the player code in use:
  // Circle K names exports `<siteCode>-<timestamp>.xml`, so we pick the match.
  /** Where a downloaded pricebook is cached — beside the persisted player.key. */
  private pricebookCachePath(playerCode: string): string {
    return join(dirname(this.config.playerKeyFilePath), `pricebook-${playerCode}.xml`);
  }

  /**
   * Download the registered player's live pricebook and cache it, so the bench
   * resolves real item names/prices instead of the bundled sample.
   *
   * `pricebookUrl` comes from the registered datacenter's endpoints
   * (`pricebook.url`), and its origin must already be in the backend allow-list
   * — the same SSRF guard the ads RPC uses, since this method is reachable from
   * the web RPC boundary where the URL is client-supplied.
   */
  async downloadPricebook(req: {
    pricebookUrl: string;
    playerCode: string;
    playerKey: string;
    locationCode: string;
  }): Promise<PricebookLoadResult> {
    const { pricebookUrl, playerCode, playerKey, locationCode } = req;
    const fail = (error: string): PricebookLoadResult => ({ ok: false, count: 0, entries: [], path: pricebookUrl, error });
    if (!pricebookUrl) {
      return { ok: false, count: 0, entries: [], path: '', error: 'No pricebook URL — register the player first.' };
    }
    const origin = originOf(pricebookUrl);
    if (origin === null || !this.backendOrigins.has(origin)) {
      return fail('Pricebook URL is not a known backend origin (register the player first).');
    }
    const url =
      `${pricebookUrl}?playerCode=${encodeURIComponent(playerCode)}` +
      `&playerKey=${encodeURIComponent(playerKey)}&locationCode=${encodeURIComponent(locationCode)}`;
    console.log(`[Pricebook] Downloading for ${playerCode} (location=${locationCode}) <- ${pricebookUrl}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PRICEBOOK_DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': PRICEBOOK_DOWNLOAD_UA }, signal: controller.signal });
      console.log(`[Pricebook]   HTTP ${res.status}`);
      if (!res.ok) return fail(`HTTP ${res.status} from pricebook.url`);
      const declared = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > PRICEBOOK_MAX_BYTES) {
        return fail(
          `Pricebook too large (${Math.round(declared / 1e6)} MB > ${Math.round(PRICEBOOK_MAX_BYTES / 1e6)} MB cap).`,
        );
      }
      const xml = await this.readPricebookBody(res, pricebookUrl);
      const entries = parsePricebook(xml);
      console.log(`[Pricebook]   parsed ${entries.length} items`);
      // Cache before the empty check: a body that parses to nothing is still
      // worth keeping on disk to diagnose the dialect.
      try {
        await writeFile(this.pricebookCachePath(playerCode), xml, 'utf-8');
      } catch (writeErr) {
        console.warn('[Pricebook] Failed to cache downloaded pricebook:', writeErr);
      }
      if (entries.length === 0) return fail('Downloaded pricebook parsed to 0 items (unsupported dialect?).');
      return { ok: true, count: entries.length, entries, path: pricebookUrl };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return fail(
        aborted
          ? `Pricebook download timed out after ${PRICEBOOK_DOWNLOAD_TIMEOUT_MS / 1000}s.`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Decode a pricebook response. The portal serves gzip unless the URL ends in
   * `.xml` (matching the real player); fall back through raw inflate to plain
   * text so an unexpected encoding degrades instead of throwing.
   */
  private async readPricebookBody(res: Response, pricebookUrl: string): Promise<string> {
    if (pricebookUrl.toLowerCase().endsWith('.xml')) return res.text();
    const buf = Buffer.from(await res.arrayBuffer());
    try {
      return gunzipSync(buf).toString('utf-8');
    } catch {
      try {
        return inflateSync(buf).toString('utf-8');
      } catch {
        return buf.toString('utf-8');
      }
    }
  }

  async loadPricebook(req: { dir?: string; playerCode: string }): Promise<PricebookLoadResult> {
    const { playerCode } = req;
    // No external dir → use the bundled sample, picking the first .xml as a
    // last resort since its name can't match an arbitrary player code.
    const usingBundled = (req.dir ?? '').trim() === '';
    // A previously downloaded pricebook outranks the bundled sample, so the
    // real catalogue survives a restart without re-downloading. An explicit
    // dir still wins — that override is the user being deliberate.
    if (usingBundled) {
      const cachePath = this.pricebookCachePath(playerCode);
      try {
        const xml = await readFile(cachePath, 'utf-8');
        const entries = parsePricebook(xml);
        if (entries.length > 0) {
          console.log(`[Pricebook] Loaded ${entries.length} items from download cache ${cachePath}`);
          return { ok: true, count: entries.length, entries, path: cachePath };
        }
      } catch {
        // No cache yet (or unreadable) — fall through to the bundled sample.
      }
    }
    const dir = resolvePricebookDir(req.dir, this.config.resolveResourceDir('pricebook'));
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
  }

  // --- Quick keys -----------------------------------------------------------

  // Load every *.qk quick-key file from a folder (usualsuspects pinned first),
  // mirroring the legacy emulator's quickkey/ directory scan. When no folder is
  // requested, fall back to the .qk files bundled with this repo.
  async loadQuickKeys(req: { dir?: string }): Promise<QuickKeyLoadResult> {
    const dir = resolveQuickKeyDir(req.dir, this.config.resolveResourceDir('quickkey'));
    console.log(`[QuickKeys] Loading *.qk from ${dir}`);
    try {
      const names = orderQuickKeyFiles((await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.qk')));
      const files: QuickKeyFile[] = await Promise.all(
        names.map(async (name) => {
          const text = await readFile(join(dir, name), 'utf-8');
          const entries = parseQuickKeys(text);
          console.log(`[QuickKeys]   ${name}: ${entries.length} keys`);
          return { file: name, entries };
        }),
      );
      return { ok: true, files, dir };
    } catch (err) {
      return { ok: false, files: [], dir, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- Ads (triggers & completers) ------------------------------------------
  //   loadAds      → GET …/manifests?collectionKey=ads → just the ad list. Fast.
  //   loadAdDetail → GET …/elastic/ads/_doc?id=…       → ONE ad's full doc, lazy.
  // Mirrors the CKPlayer2.0 ContentWorker fetch flow.

  async loadAds(req: { backendBaseUrl: string; playerCode: string; playerKey: string }): Promise<AdsManifestResult> {
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
      const manifest = await fetchJsonWithTimeout(manifestUrl);
      const data = isRecord(manifest) ? manifest.data : undefined;
      const items = Array.isArray(data)
        ? data.filter(isRecord).filter((it) => typeof it.id === 'string' || typeof it.id === 'number')
        : [];
      console.log(`[Ads] Manifest returned ${items.length} ad(s)`);
      return {
        ok: true,
        ads: items.map((it) => ({ id: String(it.id), name: typeof it.name === 'string' ? it.name : String(it.id) })),
      };
    } catch (err) {
      console.error('[Ads] manifest load failed:', err);
      return { ok: false, ads: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  async loadAdDetail(req: {
    backendBaseUrl: string;
    playerCode: string;
    playerKey: string;
    id: string;
  }): Promise<AdDetailResult> {
    const ctx = adsBackendContext(req);
    if (!ctx || !req.id) return { ok: false, error: 'Missing player config or ad id.' };
    try {
      const dparams = new URLSearchParams({
        id: req.id,
        playerCode: ctx.playerCode,
        playerKey: ctx.playerKey,
        excludes: 'keywords',
      });
      const doc = await fetchJsonWithTimeout(`${ctx.origin}/api/lift/${ctx.tenant}/elastic/ads/_doc?${dparams}`);
      const data = isRecord(doc) ? doc.data : undefined;
      const first = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
      // The ad doc's deep shape is the backend's contract; we verify it is an
      // object before trusting it as RawAdConfig.
      const json = first && isRecord(first.json) ? (first.json as RawAdConfig) : null;
      if (!json) return { ok: false, error: `No ad doc for id ${req.id}` };
      return { ok: true, ad: json };
    } catch (err) {
      console.error(`[Ads] ad doc ${req.id} load failed:`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- GlobalInit -----------------------------------------------------------

  // Send the player.key to each datacenter's services/init and return the first
  // generated config (player.code + tenant endpoint URLs). Mirrors CKPlayer2.0
  // GlobalInitClient + the legacy Java player.
  async registerPlayer(req: { playerKey: string; product?: string }): Promise<GlobalInitResult> {
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
          this.trustEndpointOrigins(r.value.endpoints);
          // Persist the generated config so endpoints survive a restart (legacy player.key file parity).
          await this.persistPlayerKeyFile(r.value.raw);
          return { ok: true, config: r.value };
        }
      }
      console.warn('[GlobalInit] Not registered on any datacenter');
      return { ok: false, error: 'player.key not registered on any datacenter (or network unreachable)' };
    } catch (err) {
      console.error('[GlobalInit] register failed:', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Load the persisted player.key file (if any) so the renderer can rehydrate
  // the generated config + endpoints on startup without re-registering.
  async loadPlayerKey(): Promise<GlobalInitResult> {
    const path = this.config.playerKeyFilePath;
    try {
      const raw = await readFile(path, 'utf-8');
      const config = configFromPlayerKeyFile(raw);
      if (!config) {
        return { ok: false, error: 'player.key file present but has no player.code' };
      }
      console.log(`[GlobalInit] Loaded player.key file ← ${path} (player.code=${config.playerCode})`);
      this.trustEndpointOrigins(config.endpoints);
      return { ok: true, config };
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return { ok: false, error: 'No persisted player.key file yet' };
      }
      console.error(`[GlobalInit] Failed to read player.key file (${path}):`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Persist the generated `# Generated on …` block, mirroring legacy `writePlayerKeyFile`. */
  private async persistPlayerKeyFile(raw: string): Promise<void> {
    const path = this.config.playerKeyFilePath;
    try {
      await writeFile(path, raw, 'utf-8');
      console.log(`[GlobalInit] Wrote player.key file → ${path}`);
    } catch (err) {
      console.error(`[GlobalInit] Failed to write player.key file (${path}):`, err);
    }
  }
}
