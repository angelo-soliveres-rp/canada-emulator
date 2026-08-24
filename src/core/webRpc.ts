/**
 * Wire protocol shared by the web server (`src/server/index.ts`) and the browser
 * bridge (`src/renderer/src/bridge/webEmulator.ts`).
 *
 * One persistent WebSocket carries both directions, mirroring the register's
 * single long-lived bidirectional TCP socket to the player:
 *   - client → server : RpcRequest   (an EmulatorBridge method call)
 *   - server → client : RpcResponse  (the awaited result) or ServerEvent (push)
 */
import type { Status } from './posTypes';
import type { InjectCommand } from './injectProtocol';

/** RPC method names — the request/response methods of `EmulatorBridge`. */
export type RpcMethod =
  | 'connect'
  | 'disconnect'
  | 'send'
  | 'getStatus'
  | 'loadPricebook'
  | 'downloadPricebook'
  | 'registerPlayer'
  | 'loadPlayerKey'
  | 'loadQuickKeys'
  | 'loadAds'
  | 'loadAdDetail';

export interface RpcRequest {
  t: 'rpc';
  id: number;
  method: RpcMethod;
  args: unknown[];
}

export interface RpcResponse {
  t: 'res';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Server-initiated push, mirroring the two IPC events (`onStatus`/`onInject`). */
export type ServerEvent =
  | { t: 'ev'; event: 'status'; payload: Status }
  | { t: 'ev'; event: 'inject'; payload: InjectCommand };

export type ServerMessage = RpcResponse | ServerEvent;
