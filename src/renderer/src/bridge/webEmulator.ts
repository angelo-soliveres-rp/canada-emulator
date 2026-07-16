/**
 * webEmulator — the browser implementation of `EmulatorBridge` (`window.emulator`).
 *
 * The Electron build wires the bridge to `ipcRenderer` in the preload; the web
 * build wires it here to a single persistent WebSocket. This mirrors the IPC
 * model 1:1: each method = one request/response, plus two pushed event streams
 * (status / inject) — which in turn mirrors the register's one long-lived
 * bidirectional socket to the player. The renderer is otherwise unchanged.
 */
import type { Channel, PosConfig, Status, EmulatorBridge } from '../../../core/posTypes';
import type { InjectCommand } from '../../../core/injectProtocol';
import type { RpcMethod, RpcRequest, ServerMessage } from '../../../core/webRpc';
import type { PricebookLoadResult } from '../../../core/pricebook';
import type { GlobalInitResult } from '../../../core/globalInit';
import type { QuickKeyLoadResult } from '../../../core/quickkeys';
import type { AdsManifestResult, AdDetailResult } from '../../../core/adTriggers';

const RECONNECT_DELAY_MS = 1500;
/** Reject an RPC that got no response — keeps `pending` from growing forever. */
const RPC_TIMEOUT_MS = 15000;
/** Cap on requests queued while the server is unreachable. */
const MAX_QUEUED_REQUESTS = 100;

/** Base WS URL. Dev: UI is on Vite's port, the server runs on 8788. Prod: same-origin. */
function wsBaseUrl(): string {
  const override = import.meta.env.VITE_EMULATOR_WS as string | undefined;
  if (override) return override;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = import.meta.env.DEV ? `${location.hostname}:8788` : location.host;
  return `${proto}//${host}`;
}

/** Reuse a `?token=` on the page URL for the WS handshake (matches EMULATOR_TOKEN). */
function wsUrl(): string {
  const base = wsBaseUrl();
  const pageToken = new URLSearchParams(location.search).get('token');
  return pageToken ? `${base}?token=${encodeURIComponent(pageToken)}` : base;
}

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createWebEmulator(): EmulatorBridge {
  let ws: WebSocket | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingRpc>();
  const statusListeners = new Set<(s: Status) => void>();
  const injectListeners = new Set<(c: InjectCommand) => void>();
  let outbox: string[] = [];
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Complete a pending RPC exactly once, clearing its timeout. */
  const settle = (id: number, complete: (p: PendingRpc) => void): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    complete(p);
  };

  const open = (): void => {
    const socket = new WebSocket(wsUrl());
    ws = socket;

    socket.onopen = (): void => {
      for (const msg of outbox) socket.send(msg);
      outbox = [];
    };

    socket.onmessage = (ev: MessageEvent): void => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.t === 'res') {
        const res = msg;
        settle(res.id, (p) => (res.ok ? p.resolve(res.result) : p.reject(new Error(res.error ?? 'RPC error'))));
      } else if (msg.t === 'ev') {
        if (msg.event === 'status') for (const l of statusListeners) l(msg.payload);
        else if (msg.event === 'inject') for (const l of injectListeners) l(msg.payload);
      }
    };

    socket.onclose = (): void => {
      ws = null;
      // Reject in-flight requests so awaiting callers fail fast instead of hanging.
      for (const id of [...pending.keys()]) settle(id, (p) => p.reject(new Error('WebSocket closed')));
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          open();
        }, RECONNECT_DELAY_MS);
      }
    };

    socket.onerror = (): void => socket.close();
  };

  const invoke = <T>(method: RpcMethod, args: unknown[]): Promise<T> => {
    const id = nextId++;
    const payload = JSON.stringify({ t: 'rpc', id, method, args } satisfies RpcRequest);
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => settle(id, (p) => p.reject(new Error(`RPC ${method} timed out after ${RPC_TIMEOUT_MS}ms`))),
        RPC_TIMEOUT_MS,
      );
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else if (outbox.length < MAX_QUEUED_REQUESTS) {
      outbox.push(payload);
    } else {
      settle(id, (p) => p.reject(new Error('Emulator server unreachable (request queue full)')));
    }
    return promise;
  };

  open();

  return {
    connect: (config: PosConfig): Promise<Status> => invoke<Status>('connect', [config]),
    disconnect: (): Promise<Status> => invoke<Status>('disconnect', []),
    send: (channel: Channel, data: string): Promise<boolean> => invoke<boolean>('send', [channel, data]),
    getStatus: (): Promise<Status> => invoke<Status>('getStatus', []),
    onStatus: (cb: (status: Status) => void): (() => void) => {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },
    onInject: (cb: (cmd: InjectCommand) => void): (() => void) => {
      injectListeners.add(cb);
      return () => {
        injectListeners.delete(cb);
      };
    },
    loadPricebook: (req): Promise<PricebookLoadResult> => invoke<PricebookLoadResult>('loadPricebook', [req]),
    registerPlayer: (req): Promise<GlobalInitResult> => invoke<GlobalInitResult>('registerPlayer', [req]),
    loadPlayerKey: (): Promise<GlobalInitResult> => invoke<GlobalInitResult>('loadPlayerKey', []),
    loadQuickKeys: (req): Promise<QuickKeyLoadResult> => invoke<QuickKeyLoadResult>('loadQuickKeys', [req]),
    loadAds: (req): Promise<AdsManifestResult> => invoke<AdsManifestResult>('loadAds', [req]),
    loadAdDetail: (req): Promise<AdDetailResult> => invoke<AdDetailResult>('loadAdDetail', [req]),
  };
}
