import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { PosTransport } from './PosTransport';

interface TestServer {
  server: net.Server;
  port: number;
  received: () => string;
  /** Write bytes back to every connected client (simulate the player injecting). */
  push: (data: string) => void;
  /** Force-close the server AND any live client sockets (simulate player going away). */
  drop: () => Promise<void>;
}

function listen(port = 0): Promise<TestServer> {
  return new Promise((resolve) => {
    let buf = '';
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', (d) => {
        buf += d.toString('utf-8');
      });
    });
    server.listen(port, '127.0.0.1', () => {
      const actualPort = (server.address() as net.AddressInfo).port;
      const drop = (): Promise<void> => {
        for (const s of sockets) s.destroy();
        return new Promise<void>((r) => server.close(() => r()));
      };
      const push = (data: string): void => {
        for (const s of sockets) s.write(data);
      };
      resolve({ server, port: actualPort, received: () => buf, push, drop });
    });
  });
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `cond` holds (every 5ms) instead of sleeping a fixed delay —
 * deterministic under CI load. Fixed `wait` remains only for negative
 * assertions ("nothing arrived"), which are inherently time-based.
 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await wait(5);
  }
}

let transport: PosTransport | undefined;
const servers: net.Server[] = [];

afterEach(async () => {
  transport?.close();
  transport = undefined;
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers.length = 0;
});

describe('PosTransport', () => {
  it('connects to both ports and reports connected status', async () => {
    const vj = await listen();
    const pole = await listen();
    servers.push(vj.server, pole.server);

    transport = new PosTransport({ host: '127.0.0.1', vjPort: vj.port, polePort: pole.port });
    await transport.connect();
    await waitFor(() => transport!.status().vj === 'connected' && transport!.status().pole === 'connected');

    expect(transport.status()).toEqual({ vj: 'connected', pole: 'connected', scanner: 'disconnected' });
  });

  it('sends VJ and pole bytes to the right server byte-for-byte', async () => {
    const vj = await listen();
    const pole = await listen();
    servers.push(vj.server, pole.server);

    transport = new PosTransport({ host: '127.0.0.1', vjPort: vj.port, polePort: pole.port });
    await transport.connect();
    await waitFor(() => transport!.status().vj === 'connected' && transport!.status().pole === 'connected');

    transport.send('vj', 'EventId=1001,TerminalNumber=1\r\n');
    transport.send('pole', 'Balance Due    $1.94');
    await waitFor(() => vj.received() !== '' && pole.received() !== '');

    expect(vj.received()).toBe('EventId=1001,TerminalNumber=1\r\n');
    expect(pole.received()).toBe('Balance Due    $1.94');
  });

  it('parses an inbound inject command on the VJ channel and notifies onInject', async () => {
    const vj = await listen();
    const pole = await listen();
    servers.push(vj.server, pole.server);

    transport = new PosTransport({ host: '127.0.0.1', vjPort: vj.port, polePort: pole.port });
    const injects: Array<{ barcode: string; quantity: number }> = [];
    transport.onInject((cmd) => injects.push(cmd));
    await transport.connect();
    await waitFor(() => transport!.status().vj === 'connected');

    // Player writes a completer inject back down the VJ socket (may arrive split).
    vj.push('EventId=2001,Barcode=049000000443,Quantity=2\r\nEventId=2001,Barcode=123,Quantity=1\r\n');
    await waitFor(() => injects.length === 2);

    expect(injects).toEqual([
      { barcode: '049000000443', quantity: 2 },
      { barcode: '123', quantity: 1 },
    ]);
  });

  it('for the bulloch register type connects pole only and never touches the VJ', async () => {
    const vj = await listen();
    const pole = await listen();
    servers.push(vj.server, pole.server);

    transport = new PosTransport({
      host: '127.0.0.1',
      vjPort: vj.port,
      polePort: pole.port,
      registerType: 'bulloch',
    });
    await transport.connect();
    await waitFor(() => transport!.status().pole === 'connected');

    // Pole is up; VJ is intentionally skipped even though a server is listening.
    expect(transport.status()).toEqual({ vj: 'disconnected', pole: 'connected', scanner: 'disconnected' });
    expect(transport.send('vj', 'EventId=1001\r\n')).toBe(false);
    await wait(20);
    expect(vj.received()).toBe('');
  });

  it('for the radiant6-us register type connects VJ + scanner and never touches the pole', async () => {
    const vj = await listen();
    const pole = await listen();
    const scanner = await listen();
    servers.push(vj.server, pole.server, scanner.server);

    transport = new PosTransport({
      host: '127.0.0.1',
      vjPort: vj.port,
      polePort: pole.port,
      scannerPort: scanner.port,
      registerType: 'radiant6-us',
    });
    const injects: Array<{ barcode: string; quantity: number }> = [];
    transport.onInject((cmd) => injects.push(cmd));
    await transport.connect();
    await waitFor(() => transport!.status().vj === 'connected' && transport!.status().scanner === 'connected');

    expect(transport.status()).toEqual({ vj: 'connected', pole: 'disconnected', scanner: 'connected' });
    expect(transport.send('pole', 'anything')).toBe(false);

    // Player ACKs a US VJ line with a bare \r\n — must be silently tolerated.
    vj.push('\r\n\r\n');
    // Player injects a completer barcode on the scanner socket (default UPC-A
    // template output: A + 11 digits + literal check-digit placeholder).
    scanner.push('\r\nA04900000044c\r\n');
    await waitFor(() => injects.length === 1);

    expect(injects).toEqual([{ barcode: '049000000443', quantity: 1 }]);
  });

  it('auto-reconnects after the server drops and comes back', async () => {
    const vj = await listen();
    const pole = await listen();
    servers.push(pole.server);

    transport = new PosTransport({
      host: '127.0.0.1',
      vjPort: vj.port,
      polePort: pole.port,
      reconnectDelayMs: 30,
    });
    await transport.connect();
    await waitFor(() => transport!.status().vj === 'connected');

    // Drop the VJ server (force-closing the live client socket), then bring a
    // new one up on the same port.
    await vj.drop();
    await waitFor(() => transport!.status().vj !== 'connected');

    const vj2 = await listen(vj.port);
    servers.push(vj2.server);
    await waitFor(() => transport!.status().vj === 'connected', 3000);
  });
});
