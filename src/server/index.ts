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
 *   EMULATOR_PORT         listen port (default 8788)
 *   EMULATOR_BIND         bind address (default 0.0.0.0 — LAN reachable)
 *   EMULATOR_TOKEN        required as `?token=` on the WS handshake. When the
 *                         bind is non-loopback and no token is set, a random
 *                         one is generated per run and printed in the banner —
 *                         the server never listens on the LAN unauthenticated.
 *   EMULATOR_ALLOWED_DIRS path-delimiter-separated roots that remote clients
 *                         may load pricebooks/quick keys from (unset = bundled
 *                         resources only)
 *   EMULATOR_DATA_DIR     where the generated player.key is persisted
 *   EMULATOR_WEB_DIR      static dir to serve (default <cwd>/dist-web)
 */
import { createServer } from 'http';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, networkInterfaces } from 'os';
import { randomBytes } from 'crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import sirv from 'sirv';
import { EmulatorService } from './emulatorService';
import { PLAYER_KEY_FILENAME } from '../core/globalInit';
import {
  parseConnectArgs,
  parseSendArgs,
  parsePricebookArgs,
  parseQuickKeysArgs,
  parseRegisterPlayerArgs,
  parseAdsArgs,
  parseAdDetailArgs,
  parseAllowedDirs,
  isLoopbackHost,
  tokenEquals,
} from './rpcGuards';
import type { RpcRequest, RpcResponse, RpcMethod, ServerEvent } from '../core/webRpc';

const PORT = Number(process.env.EMULATOR_PORT ?? 8788);
const BIND = process.env.EMULATOR_BIND ?? '0.0.0.0';
const DATA_DIR = process.env.EMULATOR_DATA_DIR ?? join(homedir(), '.canada-emulator');
const WEB_DIR = process.env.EMULATOR_WEB_DIR ?? join(process.cwd(), 'dist-web');
const ALLOWED_DIRS = parseAllowedDirs(process.env.EMULATOR_ALLOWED_DIRS);

// Fail closed: a non-loopback bind never runs without a token. If the operator
// didn't set one, generate a per-run token and print it with the URLs below.
const TOKEN_GENERATED = !process.env.EMULATOR_TOKEN?.trim() && !isLoopbackHost(BIND);
const TOKEN = process.env.EMULATOR_TOKEN?.trim() || (TOKEN_GENERATED ? randomBytes(16).toString('hex') : null);

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
// Every argument is validated by rpcGuards before it reaches the service —
// this boundary is reachable by anything that can open the WebSocket.
const handlers: Record<RpcMethod, (args: unknown[]) => unknown | Promise<unknown>> = {
  connect: (a) => service.connect(parseConnectArgs(a)),
  disconnect: () => service.disconnect(),
  send: (a) => service.send(parseSendArgs(a)),
  getStatus: () => service.status(),
  loadPricebook: (a) => service.loadPricebook(parsePricebookArgs(a, ALLOWED_DIRS)),
  registerPlayer: (a) => service.registerPlayer(parseRegisterPlayerArgs(a)),
  loadPlayerKey: () => service.loadPlayerKey(),
  loadQuickKeys: (a) => service.loadQuickKeys(parseQuickKeysArgs(a, ALLOWED_DIRS)),
  loadAds: (a) => service.loadAds(parseAdsArgs(a, service.allowedBackendOrigins())),
  loadAdDetail: (a) => service.loadAdDetail(parseAdDetailArgs(a, service.allowedBackendOrigins())),
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
    if (!tokenEquals(url.searchParams.get('token'), TOKEN)) {
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
  const tokenSuffix = TOKEN ? `/?token=${TOKEN}` : '';
  console.log('[WebServer] Canada emulator — web mode');
  console.log(`[WebServer]   local:  http://localhost:${PORT}${tokenSuffix}`);
  for (const url of lanUrls(PORT)) console.log(`[WebServer]   lan:    ${url}${tokenSuffix}`);
  console.log(`[WebServer]   data:   ${DATA_DIR}`);
  if (!existsSync(WEB_DIR)) {
    console.warn(`[WebServer]   note:   web build missing (${WEB_DIR}). Run "npm run build:web" for production serving.`);
  }
  if (TOKEN_GENERATED) {
    console.warn(
      '[WebServer]   auth:   EMULATOR_TOKEN not set — generated a one-run token (baked into the URLs above). ' +
        'Set EMULATOR_TOKEN to pin one, or EMULATOR_BIND=127.0.0.1 to skip auth locally.',
    );
  }
  if (ALLOWED_DIRS.length > 0) {
    console.log(`[WebServer]   dirs:   remote pricebook/quick-key loads allowed under: ${ALLOWED_DIRS.join(', ')}`);
  }
});
