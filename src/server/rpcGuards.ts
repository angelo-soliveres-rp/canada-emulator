/**
 * Runtime guards for the LAN-facing WebSocket RPC boundary (`src/server/index.ts`).
 *
 * The Electron entry point deliberately skips these: its IPC senders are the
 * local user's own renderer (same-user trust). The web server, by contrast,
 * accepts connections from anything that can reach the port, so every argument
 * is validated here before it can touch the filesystem (`loadPricebook`/
 * `loadQuickKeys` read directories) or the network (`connect` opens outbound
 * TCP sockets).
 *
 * Zero-dependency by design (the repo avoids runtime deps) — small hand-rolled
 * narrowing helpers instead of a schema library.
 */
import { resolve, sep, delimiter } from 'path';
import { timingSafeEqual } from 'crypto';
import { REGISTER_TYPES } from '../core/posTypes';
import type { Channel, PosConfig, RegisterType } from '../core/posTypes';

/** Raised for any malformed / out-of-policy RPC argument. Message is client-safe. */
export class RpcArgError extends Error {}

const MAX_SEND_BYTES = 65536;
const MAX_KEY_LENGTH = 4096;
const MAX_CODE_LENGTH = 64;
const MAX_ID_LENGTH = 128;
const MAX_HOST_LENGTH = 255;
const MAX_URL_LENGTH = 2048;

function fail(message: string): never {
  throw new RpcArgError(message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== 'string') fail(`${what}: expected a string`);
  const trimmed = value.trim();
  if (trimmed === '') fail(`${what}: must not be empty`);
  if (trimmed.length > maxLength) fail(`${what}: too long (max ${maxLength})`);
  return trimmed;
}

function optionalString(value: unknown, what: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${what}: expected a string`);
  if (value.length > maxLength) fail(`${what}: too long (max ${maxLength})`);
  return value;
}

function requirePort(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    fail(`${what}: expected an integer port 1-65535`);
  }
  return value;
}

function requireRegisterType(value: unknown): RegisterType {
  const known = REGISTER_TYPES.find((r) => r.value === value);
  if (!known) fail(`registerType: expected one of ${REGISTER_TYPES.map((r) => r.value).join(', ')}`);
  return known.value;
}

const CHANNELS: readonly Channel[] = ['vj', 'pole', 'scanner'];

// --- Per-method argument parsers ---------------------------------------------

export function parseConnectArgs(args: unknown[]): PosConfig {
  const raw = asRecord(args[0], 'connect config');
  return {
    host: requireString(raw.host, 'host', MAX_HOST_LENGTH),
    vjPort: requirePort(raw.vjPort, 'vjPort'),
    polePort: requirePort(raw.polePort, 'polePort'),
    scannerPort: requirePort(raw.scannerPort, 'scannerPort'),
    registerType: requireRegisterType(raw.registerType),
  };
}

export function parseSendArgs(args: unknown[]): { channel: Channel; data: string } {
  const channel = args[0];
  if (!CHANNELS.includes(channel as Channel)) fail(`channel: expected one of ${CHANNELS.join(', ')}`);
  const data = args[1];
  if (typeof data !== 'string') fail('data: expected a string');
  if (data.length > MAX_SEND_BYTES) fail(`data: too long (max ${MAX_SEND_BYTES})`);
  return { channel: channel as Channel, data };
}

/**
 * Validate a client-supplied directory against the allow-list. Empty/absent
 * means "use the bundled resources" and is always allowed. Anything else must
 * resolve inside one of `allowedDirs` (EMULATOR_ALLOWED_DIRS) — without an
 * allow-list, remote directory reads are refused outright.
 */
export function parseDirArg(value: unknown, allowedDirs: readonly string[]): string | undefined {
  const dir = optionalString(value, 'dir', 1024)?.trim();
  if (!dir) return undefined;
  const resolved = resolve(dir);
  const permitted = allowedDirs.some((root) => resolved === root || resolved.startsWith(root + sep));
  if (!permitted) {
    fail(
      allowedDirs.length === 0
        ? 'dir: custom directories are disabled in web mode (set EMULATOR_ALLOWED_DIRS on the server)'
        : 'dir: not inside an allowed directory (see EMULATOR_ALLOWED_DIRS)',
    );
  }
  return resolved;
}

/** Parse EMULATOR_ALLOWED_DIRS (path.delimiter-separated) into resolved roots. */
export function parseAllowedDirs(env: string | undefined): string[] {
  return (env ?? '')
    .split(delimiter)
    .map((d) => d.trim())
    .filter((d) => d !== '')
    .map((d) => resolve(d));
}

export function parsePricebookArgs(args: unknown[], allowedDirs: readonly string[]): { dir?: string; playerCode: string } {
  const raw = asRecord(args[0], 'loadPricebook request');
  return {
    dir: parseDirArg(raw.dir, allowedDirs),
    playerCode: requireString(raw.playerCode, 'playerCode', MAX_CODE_LENGTH),
  };
}

export function parseQuickKeysArgs(args: unknown[], allowedDirs: readonly string[]): { dir?: string } {
  const raw = asRecord(args[0] ?? {}, 'loadQuickKeys request');
  return { dir: parseDirArg(raw.dir, allowedDirs) };
}

export function parseRegisterPlayerArgs(args: unknown[]): { playerKey: string; product?: string } {
  const raw = asRecord(args[0], 'registerPlayer request');
  return {
    playerKey: requireString(raw.playerKey, 'playerKey', MAX_KEY_LENGTH),
    product: optionalString(raw.product, 'product', MAX_CODE_LENGTH),
  };
}

function requireBackendUrl(value: unknown): string {
  const url = requireString(value, 'backendBaseUrl', MAX_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail('backendBaseUrl: not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail('backendBaseUrl: must be http(s)');
  }
  return url;
}

export function parseAdsArgs(args: unknown[]): { backendBaseUrl: string; playerCode: string; playerKey: string } {
  const raw = asRecord(args[0], 'loadAds request');
  return {
    backendBaseUrl: requireBackendUrl(raw.backendBaseUrl),
    playerCode: requireString(raw.playerCode, 'playerCode', MAX_CODE_LENGTH),
    playerKey: requireString(raw.playerKey, 'playerKey', MAX_KEY_LENGTH),
  };
}

export function parseAdDetailArgs(
  args: unknown[],
): { backendBaseUrl: string; playerCode: string; playerKey: string; id: string } {
  const raw = asRecord(args[0], 'loadAdDetail request');
  return {
    ...parseAdsArgs(args),
    id: requireString(raw.id, 'id', MAX_ID_LENGTH),
  };
}

// --- Auth helpers -------------------------------------------------------------

/** True for any spelling of a loopback bind address. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || h.startsWith('127.');
}

/** Constant-time token comparison (length leak is fine; content is not). */
export function tokenEquals(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
