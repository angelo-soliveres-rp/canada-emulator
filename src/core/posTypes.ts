/** Shared, browser-safe transport types used by main, preload and renderer. */
import type { PricebookLoadResult } from './pricebook';
import type { GlobalInitResult } from './globalInit';
import type { QuickKeyLoadResult } from './quickkeys';
import type { AdsManifestResult, AdDetailResult } from './adTriggers';
import type { InjectCommand } from './injectProtocol';

export type Channel = 'vj' | 'pole' | 'scanner';
export type ConnState = 'connected' | 'connecting' | 'disconnected';
export type Status = Record<Channel, ConnState>;

/**
 * Channels a WireMessage can target. The TCP transport only knows the hardware
 * `Channel`s; `loa` is a renderer-only pseudo-channel whose payload is an NGRP
 * order-document JSON string handed to the embedded loa-player over
 * cross-origin postMessage (LOA mode) — never over a socket.
 */
export type WireChannel = Channel | 'loa';

/** Entry URL of the embedded loa-player (LOA mode); serve the player there first. */
export const LOA_PLAYER_ENTRY_URL = 'http://localhost:9000/index.html';

/**
 * Build the embedded loa-player URL, passing the player key in the hash
 * (`#playerKey=…`) so it boots as that registered player and resolves its own
 * tenant, settings and station. An empty key yields the bare URL — the player
 * then boots on a default config and will not consume our order documents.
 */
export function loaEntryUrl(playerKey: string, baseUrl: string = LOA_PLAYER_ENTRY_URL): string {
  const key = playerKey.trim();
  return key ? `${baseUrl}#playerKey=${key}` : baseUrl;
}

/** POS register types — each listens on its own VJ/pole/scanner ports. */
export type RegisterType = 'radiant6-canada' | 'bulloch' | 'radiant6-us' | 'verifone' | 'loa-player';

/** US register families — monolingual en-US, cents-exact, no fr machinery. */
export function isUsRegisterType(type: RegisterType): boolean {
  return type === 'radiant6-us' || type === 'verifone';
}

/**
 * LOA mode drives an embedded player over postMessage instead of TCP, so it
 * opens no sockets and its "connection" is the iframe being loaded.
 */
export function isLoaRegisterType(type: RegisterType): boolean {
  return type === 'loa-player';
}

/**
 * Per-register-type defaults (the ports the player listens on). Radiant6 Canada
 * uses VJ 5438 / pole 5439; Bulloch is pole-primary on 5440 (legacy
 * `debug1.properties`: "Bulloch typically listens on TCP 5440"). Radiant6 US
 * has no pole display — VJ 5438 plus the scanner reverse channel on 10000
 * (legacy `scanner.ioParams=TCP:10000`), where the player writes completer
 * barcode injects. Verifone Topaz is serial on real hardware; local dev uses
 * the legacy serial-over-TCP dev ports (player `system.properties`:
 * scanner=TCP:10000, poledisplay=TCP:10001, virtualjournal=TCP:10002).
 */
export const REGISTER_TYPES: ReadonlyArray<{
  value: RegisterType;
  label: string;
  vjPort: number;
  polePort: number;
  scannerPort: number;
}> = [
  { value: 'radiant6-canada', label: 'Radiant6 Canada', vjPort: 5438, polePort: 5439, scannerPort: 10000 },
  { value: 'bulloch', label: 'Bulloch', vjPort: 5438, polePort: 5440, scannerPort: 10000 },
  { value: 'radiant6-us', label: 'Radiant6 US', vjPort: 5438, polePort: 5439, scannerPort: 10000 },
  { value: 'verifone', label: 'Verifone Topaz', vjPort: 10002, polePort: 10001, scannerPort: 10000 },
  // LOA has no sockets at all — the ports are placeholders so the row shape holds.
  { value: 'loa-player', label: 'LOA (loa-player)', vjPort: 0, polePort: 0, scannerPort: 0 },
];

/** Look up the VJ/pole/scanner ports for a register type. */
export function portsForRegisterType(
  type: RegisterType,
): { vjPort: number; polePort: number; scannerPort: number } {
  const entry = REGISTER_TYPES.find((r) => r.value === type) ?? REGISTER_TYPES[0];
  return { vjPort: entry.vjPort, polePort: entry.polePort, scannerPort: entry.scannerPort };
}

/**
 * The channels a register type actually opens/uses:
 *   - radiant6-canada: VJ + pole (pole-authoritative tax/balance)
 *   - bulloch:         pole only (no virtual journal)
 *   - radiant6-us:     VJ (authoritative, 1005/1020 enabled) + scanner
 *                      (player→register completer injects); no pole display
 *   - verifone:        VJ (authoritative plaintext journal) + pole (present
 *                      but non-authoritative) + scanner (completer injects)
 */
export function channelsForRegisterType(type: RegisterType): Channel[] {
  // LOA talks to an iframe, not a socket, so there is nothing to connect.
  if (type === 'loa-player') return [];
  if (type === 'bulloch') return ['pole'];
  if (type === 'radiant6-us') return ['vj', 'scanner'];
  if (type === 'verifone') return ['vj', 'pole', 'scanner'];
  return ['vj', 'pole'];
}

/** Connection target for the CK Player 2.0 register adapters. */
export interface PosConfig {
  host: string;
  vjPort: number;
  polePort: number;
  scannerPort: number;
  registerType: RegisterType;
}

export const DEFAULT_POS_CONFIG: PosConfig = {
  host: '127.0.0.1',
  vjPort: 5438,
  polePort: 5439,
  scannerPort: 10000,
  registerType: 'radiant6-canada',
};

/** Apply defaults + per-field validation to a persisted POS config (e.g. from localStorage). */
export function normalizePosConfig(partial: Partial<PosConfig> | null | undefined): PosConfig {
  const port = (v: number | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535 ? v : fallback;
  const host = (partial?.host ?? '').trim();
  const registerType = REGISTER_TYPES.some((r) => r.value === partial?.registerType)
    ? (partial!.registerType as RegisterType)
    : DEFAULT_POS_CONFIG.registerType;
  return {
    host: host || DEFAULT_POS_CONFIG.host,
    vjPort: port(partial?.vjPort, DEFAULT_POS_CONFIG.vjPort),
    polePort: port(partial?.polePort, DEFAULT_POS_CONFIG.polePort),
    scannerPort: port(partial?.scannerPort, DEFAULT_POS_CONFIG.scannerPort),
    registerType,
  };
}

/**
 * Lift-on-Linux lane lab — the Proxmox LXC that runs the legacy player, one
 * lane per Linux user. The lanes are Radiant6 US registers. Port scheme:
 * every lane's system.properties says `virtualjournal.ioParams=TCP:5438` and
 * the player itself offsets the listener by lane-1 (Zynstra `TCPDevice.java`);
 * the scanner port does NOT auto-offset, so the lab convention assigns
 * 10000 + (lane-1)*10 in each lane's system.properties.
 */
export const LOL_HOST = '10.1.2.167';
export const LOL_LANE_MIN = 1;
export const LOL_LANE_MAX = 6;

/** Persisted LoL preset state: whether the preset drives the config, and which lane. */
export interface LolPreset {
  enabled: boolean;
  lane: number;
}

export const DEFAULT_LOL_PRESET: LolPreset = { enabled: false, lane: 1 };

/** Clamp a lane to a valid integer in 1..6; anything unparseable becomes lane 1. */
export function normalizeLolLane(lane: number | undefined): number {
  if (typeof lane !== 'number' || !Number.isInteger(lane)) return LOL_LANE_MIN;
  return Math.min(LOL_LANE_MAX, Math.max(LOL_LANE_MIN, lane));
}

/** Apply defaults + validation to a persisted LoL preset. */
export function normalizeLolPreset(partial: Partial<LolPreset> | null | undefined): LolPreset {
  return {
    enabled: partial?.enabled === true,
    lane: normalizeLolLane(partial?.lane),
  };
}

/** The full connection target for a LoL lane — host, ports, and register type. */
export function lolConfigForLane(lane: number): PosConfig {
  const n = normalizeLolLane(lane);
  return {
    host: LOL_HOST,
    registerType: 'radiant6-us',
    vjPort: 5438 + (n - 1),
    polePort: portsForRegisterType('radiant6-us').polePort,
    scannerPort: 10000 + (n - 1) * 10,
  };
}

/**
 * Player identity / backend credentials — mirrors CKPlayer2.0's
 * `player.code` / `player.key` settings. Editable at runtime in the emulator
 * (like CKPlayer2.0) and used to resolve items against the LIFT backend.
 */
export interface PlayerConfig {
  playerCode: string;
  playerKey: string;
  backendBaseUrl: string;
}

export const DEFAULT_PLAYER_CONFIG: PlayerConfig = {
  playerCode: '',
  playerKey: '',
  backendBaseUrl: 'https://player.circlekliftdev.com/api/lift/',
};

/** Apply defaults + trim to a partial player config (e.g. from persisted storage). */
export function normalizePlayerConfig(partial: Partial<PlayerConfig> | null | undefined): PlayerConfig {
  const trimmed = (v: string | undefined, fallback: string): string => (v ?? fallback).trim();
  return {
    playerCode: trimmed(partial?.playerCode, DEFAULT_PLAYER_CONFIG.playerCode),
    playerKey: trimmed(partial?.playerKey, DEFAULT_PLAYER_CONFIG.playerKey),
    backendBaseUrl:
      trimmed(partial?.backendBaseUrl, DEFAULT_PLAYER_CONFIG.backendBaseUrl) || DEFAULT_PLAYER_CONFIG.backendBaseUrl,
  };
}

/** The emulator bridge exposed on `window.emulator` by the preload. */
export interface EmulatorBridge {
  connect(config: PosConfig): Promise<Status>;
  disconnect(): Promise<Status>;
  send(channel: Channel, data: string): Promise<boolean>;
  getStatus(): Promise<Status>;
  /** Subscribe to status changes; returns an unsubscribe function. */
  onStatus(cb: (status: Status) => void): () => void;
  /**
   * Subscribe to completer injects from the player — the VJ reverse channel
   * (Canada, EventId 2001) or the scanner socket (US, raw barcode scans),
   * normalized to one InjectCommand shape.
   */
  onInject(cb: (cmd: InjectCommand) => void): () => void;
  /** Load the pricebook matching the player code from a local directory. Empty dir uses the bundled sample. */
  loadPricebook(req: { dir?: string; playerCode: string }): Promise<PricebookLoadResult>;
  /**
   * Download the registered player's live pricebook and cache it. `pricebookUrl`
   * must be an origin the backend allow-list already trusts (SSRF guard).
   */
  downloadPricebook(req: {
    pricebookUrl: string;
    playerCode: string;
    playerKey: string;
    locationCode: string;
  }): Promise<PricebookLoadResult>;
  /** Register the player.key against the datacenters and return the generated config. */
  registerPlayer(req: { playerKey: string; product?: string }): Promise<GlobalInitResult>;
  /** Load the persisted player.key file (generated config) saved by a prior registration. */
  loadPlayerKey(): Promise<GlobalInitResult>;
  /** Load all `.qk` quick-key files from a folder (usualsuspects first). Empty dir uses the bundled defaults. */
  loadQuickKeys(req: { dir?: string }): Promise<QuickKeyLoadResult>;
  /** Fetch the live ads manifest (ad list) for the player. */
  loadAds(req: { backendBaseUrl: string; playerCode: string; playerKey: string }): Promise<AdsManifestResult>;
  /** Fetch one ad's full doc (triggers & completers), on demand. */
  loadAdDetail(req: {
    backendBaseUrl: string;
    playerCode: string;
    playerKey: string;
    id: string;
  }): Promise<AdDetailResult>;
}
