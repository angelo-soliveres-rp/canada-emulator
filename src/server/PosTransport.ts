/**
 * PosTransport — Electron main-process TCP client to CK Player 2.0's CA
 * adapters. The player listens as a TCP server on the virtual-journal and
 * pole-display ports (default 5438 / 5439); this connects as a client and
 * writes the encoder's bytes. Auto-reconnects when the player restarts.
 *
 * Node-only (uses `net`). Holds NO business logic — it ships bytes.
 */
import net from 'net';
import type { Channel, ConnState, Status, PosConfig, RegisterType } from '../core/posTypes';
import { parseInjectCommand, type InjectCommand } from '../core/injectProtocol';

export type { Channel, ConnState, Status } from '../core/posTypes';

export interface PosTransportConfig extends PosConfig {
  /** Delay before retrying a dropped/failed connection. Default 2000ms. */
  reconnectDelayMs?: number;
}

interface Connection {
  socket: net.Socket | null;
  state: ConnState;
  port: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class PosTransport {
  private readonly host: string;
  private readonly reconnectDelayMs: number;
  private readonly registerType: RegisterType;
  private readonly conns: Record<Channel, Connection>;
  private closed = false;
  private statusListeners: Array<(s: Status) => void> = [];
  private injectListeners: Array<(cmd: InjectCommand) => void> = [];
  /** Line buffer for inbound VJ bytes (player→register completer injects). */
  private vjBuffer = '';

  constructor(config: PosTransportConfig) {
    this.host = config.host;
    this.reconnectDelayMs = config.reconnectDelayMs ?? 2000;
    this.registerType = config.registerType;
    this.conns = {
      vj: { socket: null, state: 'disconnected', port: config.vjPort, reconnectTimer: null },
      pole: { socket: null, state: 'disconnected', port: config.polePort, reconnectTimer: null },
    };
  }

  /**
   * Begin connecting the channels this register uses. Resolves once the
   * attempts are initiated. Bulloch is pole-only (no virtual journal), so the
   * VJ socket is never opened — avoids endless ECONNREFUSED retries against a
   * port the Bulloch player doesn't listen on.
   */
  async connect(): Promise<void> {
    this.closed = false;
    if (this.registerType !== 'bulloch') this.openChannel('vj');
    this.openChannel('pole');
  }

  private openChannel(channel: Channel): void {
    if (this.closed) return;
    const conn = this.conns[channel];
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }

    this.setState(channel, 'connecting');
    console.log(`[PosTransport] ${channel}: connecting to ${this.host}:${conn.port}…`);
    const socket = net.connect({ host: this.host, port: conn.port });
    conn.socket = socket;

    socket.on('connect', () => {
      console.log(`[PosTransport] ${channel}: connected to ${this.host}:${conn.port}`);
      if (channel === 'vj') this.vjBuffer = '';
      this.setState(channel, 'connected');
    });
    // The player writes completer injects back down the VJ socket.
    if (channel === 'vj') {
      socket.on('data', (data: Buffer) => this.handleVjData(data.toString('utf-8')));
    }
    socket.on('error', (err: Error) => {
      console.warn(`[PosTransport] ${channel}: socket error — ${err.message}`);
    });
    socket.on('close', () => {
      conn.socket = null;
      this.setState(channel, 'disconnected');
      this.scheduleReconnect(channel);
    });
  }

  private scheduleReconnect(channel: Channel): void {
    if (this.closed) return;
    const conn = this.conns[channel];
    if (conn.reconnectTimer) return;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this.openChannel(channel);
    }, this.reconnectDelayMs);
  }

  /** Write bytes to a channel. No-op (returns false) if not connected. */
  send(channel: Channel, data: string): boolean {
    const conn = this.conns[channel];
    if (conn.socket && conn.state === 'connected') {
      conn.socket.write(data);
      console.log(`[PosTransport] → ${channel}: ${JSON.stringify(data.replace(/\r\n$/, ''))}`);
      return true;
    }
    console.warn(`[PosTransport] ✗ ${channel} not connected — dropped: ${JSON.stringify(data.replace(/\r\n$/, ''))}`);
    return false;
  }

  /** Buffer inbound VJ bytes, split into lines, and emit any inject commands. */
  private handleVjData(chunk: string): void {
    this.vjBuffer += chunk;
    let idx: number;
    while ((idx = this.vjBuffer.indexOf('\n')) >= 0) {
      const line = this.vjBuffer.slice(0, idx).replace(/\r$/, '');
      this.vjBuffer = this.vjBuffer.slice(idx + 1);
      const cmd = parseInjectCommand(line);
      if (cmd) {
        console.log(`[PosTransport] ← vj inject: ${JSON.stringify(cmd)}`);
        for (const l of this.injectListeners) l(cmd);
      }
    }
  }

  status(): Status {
    return { vj: this.conns.vj.state, pole: this.conns.pole.state };
  }

  onStatus(listener: (s: Status) => void): void {
    this.statusListeners.push(listener);
  }

  /** Subscribe to completer injects received from the player on the VJ socket. */
  onInject(listener: (cmd: InjectCommand) => void): void {
    this.injectListeners.push(listener);
  }

  private setState(channel: Channel, state: ConnState): void {
    if (this.conns[channel].state === state) return;
    this.conns[channel].state = state;
    console.log(`[PosTransport] ${channel}: ${state}`);
    const snapshot = this.status();
    for (const l of this.statusListeners) l(snapshot);
  }

  close(): void {
    this.closed = true;
    for (const channel of ['vj', 'pole'] as Channel[]) {
      const conn = this.conns[channel];
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      conn.socket?.destroy();
      conn.socket = null;
      conn.state = 'disconnected';
    }
  }
}
