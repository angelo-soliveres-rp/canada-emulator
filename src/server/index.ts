/**
 * Web server entry point — serves the built renderer and exposes the shared
 * EmulatorService over a single WebSocket (RPC + pushed events), so the emulator
 * can be driven from a browser at a URL instead of an Electron window.
 *
 * The renderer code is identical to the Electron build; only the `window.emulator`
 * implementation differs (see `src/renderer/src/bridge/webEmulator.ts`).
 *
 * Run with `tsx` (dev/serve). Resolves paths from `process.cwd()`, so always
 * launch from the repo root (npm scripts do this).
 *
 * Env knobs:
 *   EMULATOR_PORT      listen port (default 8788)
 *   EMULATOR_BIND      bind address (default 0.0.0.0 — LAN reachable)
 *   EMULATOR_TOKEN     if set, required as `?token=` on the WS handshake
 *   EMULATOR_DATA_DIR  where the generated player.key is persisted
 *   EMULATOR_WEB_DIR   static dir to serve (default <cwd>/dist-web)
 */
import { createServer } from 'http';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, networkInterfaces } from 'os';
import { WebSocketServer, type WebSocket } from 'ws';
import sirv from 'sirv';
import { EmulatorService } from './emulatorService';
import { PLAYER_KEY_FILENAME } from '../core/globalInit';
import type { Channel, PosConfig } from '../core/posTypes';
import type { RpcRequest, RpcResponse, RpcMethod, ServerEvent } from '../core/webRpc';

const PORT = Number(process.env.EMULATOR_PORT ?? 8788);
const BIND = process.env.EMULATOR_BIND ?? '0.0.0.0';
const TOKEN = process.env.EMULATOR_TOKEN?.trim() || null;
const DATA_DIR = process.env.EMULATOR_DATA_DIR ?? join(homedir(), '.canada-emulator');
const WEB_DIR = process.env.EMULATOR_WEB_DIR ?? join(process.cwd(), 'dist-web');

mkdirSync(DATA_DIR, { recursive: true });

/** Resolve a bundled resource subfolder relative to the repo root / build dir. */
function resolveResourceDir(name: string): string {
  const candidates = [join(process.cwd(), 'resources', name), join(__dirname, '../../resources', name)];
  return candidates.find(existsSync) ?? candidates[0];
}

const service = new EmulatorService({
  playerKeyFilePath: join(DATA_DIR, PLAYER_KEY_FILENAME),
  resolveResourceDir,
});

// One handler per EmulatorBridge method. Args arrive as a positional array,
// mirroring the preload's `ipcRenderer.invoke(channel, ...args)` calls.
const handlers: Record<RpcMethod, (args: unknown[]) => unknown | Promise<unknown>> = {
  connect: (a) => service.connect(a[0] as PosConfig),
  disconnect: () => service.disconnect(),
  send: (a) => service.send({ channel: a[0] as Channel, data: a[1] as string }),
  getStatus: () => service.status(),
  loadPricebook: (a) => service.loadPricebook(a[0] as { dir?: string; playerCode: string }),
  registerPlayer: (a) => service.registerPlayer(a[0] as { playerKey: string; product?: string }),
  loadPlayerKey: () => service.loadPlayerKey(),
  loadQuickKeys: (a) => service.loadQuickKeys(a[0] as { dir?: string }),
  loadAds: (a) => service.loadAds(a[0] as { backendBaseUrl: string; playerCode: string; playerKey: string }),
  loadAdDetail: (a) =>
    service.loadAdDetail(a[0] as { backendBaseUrl: string; playerCode: string; playerKey: string; id: string }),
};

// --- HTTP (static renderer) -------------------------------------------------

const serveStatic = existsSync(WEB_DIR)
  ? sirv(WEB_DIR, { single: true, dev: false })
  : (_req: unknown, _res: unknown, next: () => void): void => next();

const httpServer = createServer((req, res) => {
  serveStatic(req, res, () => {
    res.statusCode = 404;
    res.end(
      existsSync(WEB_DIR)
        ? 'Not found'
        : `Web build missing at ${WEB_DIR}. Run "npm run build:web" first (or use "npm run dev:web").`,
    );
  });
});

// --- WebSocket (RPC + events) -----------------------------------------------

const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

function broadcast(msg: ServerEvent): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

// One transport shared by every connected browser (matches the single-window
// Electron behaviour). Status/inject pushes fan out to all clients.
service.onStatus((payload) => broadcast({ t: 'ev', event: 'status', payload }));
service.onInject((payload) => broadcast({ t: 'ev', event: 'inject', payload }));

httpServer.on('upgrade', (req, socket, head) => {
  if (TOKEN) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('token') !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws: WebSocket) => {
  clients.add(ws);
  console.log(`[WebServer] client connected (${clients.size} total)`);
  // Sync current status immediately, mirroring the renderer's getStatus on mount.
  ws.send(JSON.stringify({ t: 'ev', event: 'status', payload: service.status() } satisfies ServerEvent));

  ws.on('message', async (raw: Buffer) => {
    let req: RpcRequest;
    try {
      req = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (req?.t !== 'rpc' || typeof req.id !== 'number') return;
    const res: RpcResponse = { t: 'res', id: req.id, ok: true };
    try {
      const handler = handlers[req.method];
      if (!handler) throw new Error(`Unknown method: ${req.method}`);
      res.result = await handler(Array.isArray(req.args) ? req.args : []);
    } catch (err) {
      res.ok = false;
      res.error = err instanceof Error ? err.message : String(err);
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(res));
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WebServer] client disconnected (${clients.size} total)`);
  });
  ws.on('error', (err: Error) => console.warn(`[WebServer] ws error: ${err.message}`));
});

// --- Startup banner ---------------------------------------------------------

function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) urls.push(`http://${iface.address}:${port}`);
    }
  }
  return urls;
}

httpServer.listen(PORT, BIND, () => {
  console.log('[WebServer] Canada emulator — web mode');
  console.log(`[WebServer]   local:  http://localhost:${PORT}`);
  for (const url of lanUrls(PORT)) console.log(`[WebServer]   lan:    ${url}`);
  console.log(`[WebServer]   data:   ${DATA_DIR}`);
  if (!existsSync(WEB_DIR)) {
    console.warn(`[WebServer]   note:   web build missing (${WEB_DIR}). Run "npm run build:web" for production serving.`);
  }
  if (BIND !== '127.0.0.1' && !TOKEN) {
    console.warn(
      '[WebServer]   WARNING: reachable on the LAN with no token. Anyone who can reach this host can drive the ' +
        'register and read the persisted player.key. Set EMULATOR_TOKEN, or EMULATOR_BIND=127.0.0.1 to restrict.',
    );
  }
});
