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
    await wait(50);

    expect(transport.status()).toEqual({ vj: 'connected', pole: 'connected' });
  });

  it('sends VJ and pole bytes to the right server byte-for-byte', async () => {
    const vj = await listen();
    const pole = await listen();
    servers.push(vj.server, pole.server);

    transport = new PosTransport({ host: '127.0.0.1', vjPort: vj.port, polePort: pole.port });
    await transport.connect();
    await wait(50);

    transport.send('vj', 'EventId=1001,TerminalNumber=1\r\n');
    transport.send('pole', 'Balance Due    $1.94');
    await wait(50);

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
    await wait(50);

    // Player writes a completer inject back down the VJ socket (may arrive split).
    vj.push('EventId=2001,Barcode=049000000443,Quantity=2\r\nEventId=2001,Barcode=123,Quantity=1\r\n');
    await wait(50);

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
    await wait(50);

    // Pole is up; VJ is intentionally skipped even though a server is listening.
    expect(transport.status()).toEqual({ vj: 'disconnected', pole: 'connected' });
    expect(transport.send('vj', 'EventId=1001\r\n')).toBe(false);
    await wait(20);
    expect(vj.received()).toBe('');
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
    await wait(50);
    expect(transport.status().vj).toBe('connected');

    // Drop the VJ server (force-closing the live client socket), then bring a
    // new one up on the same port.
    await vj.drop();
    await wait(60);
    expect(transport.status().vj).not.toBe('connected');

    const vj2 = await listen(vj.port);
    servers.push(vj2.server);
    await wait(150);
    expect(transport.status().vj).toBe('connected');
  });
});
