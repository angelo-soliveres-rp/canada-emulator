/**
 * PosTransport — TCP client to CK Player 2.0's register adapters. The player
 * listens as a TCP server on the virtual-journal / pole-display / scanner
 * ports (defaults 5438 / 5439 / 10000); this connects as a client and writes
 * the encoder's bytes. Auto-reconnects when the player restarts.
 *
 * Node-only (uses `net`). Holds NO business logic — it ships bytes.
 */
import net from 'net';
import { channelsForRegisterType } from '../core/posTypes';
import type { Channel, ConnState, Status, PosConfig, RegisterType } from '../core/posTypes';
import { parseInjectCommand, type InjectCommand } from '../core/injectProtocol';
import { drainScanBuffer } from '../core/scanProtocol';

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
  /** Buffer for inbound scanner bytes (US player→register barcode injects). */
  private scannerBuffer = '';

  constructor(config: PosTransportConfig) {
    this.host = config.host;
    this.reconnectDelayMs = config.reconnectDelayMs ?? 2000;
    this.registerType = config.registerType;
    this.conns = {
      vj: { socket: null, state: 'disconnected', port: config.vjPort, reconnectTimer: null },
      pole: { socket: null, state: 'disconnected', port: config.polePort, reconnectTimer: null },
      scanner: { socket: null, state: 'disconnected', port: config.scannerPort, reconnectTimer: null },
    };
  }

  /**
   * Begin connecting only the channels this register type uses. Resolves once
   * the attempts are initiated. Opening an unused channel would spin endless
   * ECONNREFUSED retries against a port the player doesn't listen on —
   * Bulloch is pole-only, Radiant6 US is VJ + scanner (no pole display),
   * Radiant6 Canada is VJ + pole.
   */
  async connect(): Promise<void> {
    this.closed = false;
    for (const channel of channelsForRegisterType(this.registerType)) {
      this.openChannel(channel);
    }
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
      if (channel === 'scanner') this.scannerBuffer = '';
      this.setState(channel, 'connected');
    });
    // The player writes completer injects back down the VJ socket (Canada,
    // EventId 2001) or the scanner socket (US, raw barcode scans). It also
    // ACKs every received US VJ line with a bare \r\n — handleVjData's line
    // splitter drops those empties, so no special casing is needed.
    if (channel === 'vj') {
      socket.on('data', (data: Buffer) => this.handleVjData(data.toString('utf-8')));
    }
    if (channel === 'scanner') {
      socket.on('data', (data: Buffer) => this.handleScannerData(data.toString('utf-8')));
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

  /**
   * Drain buffered scanner bytes into barcode scans and surface each as an
   * InjectCommand — the US equivalent of the Canada VJ inject (the UI rings
   * the item and echoes 1011 back, which also releases the player's Zynstra
   * age-verification queue).
   */
  private handleScannerData(chunk: string): void {
    const { barcodes, rest } = drainScanBuffer(this.scannerBuffer + chunk);
    this.scannerBuffer = rest;
    for (const barcode of barcodes) {
      const cmd: InjectCommand = { barcode, quantity: 1 };
      console.log(`[PosTransport] ← scanner inject: ${JSON.stringify(cmd)}`);
      for (const l of this.injectListeners) l(cmd);
    }
  }

  status(): Status {
    return { vj: this.conns.vj.state, pole: this.conns.pole.state, scanner: this.conns.scanner.state };
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
    for (const channel of ['vj', 'pole', 'scanner'] as Channel[]) {
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
