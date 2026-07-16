/** Shared, browser-safe transport types used by main, preload and renderer. */
import type { PricebookLoadResult } from './pricebook';
import type { GlobalInitResult } from './globalInit';
import type { QuickKeyLoadResult } from './quickkeys';
import type { AdsManifestResult, AdDetailResult } from './adTriggers';
import type { InjectCommand } from './injectProtocol';

export type Channel = 'vj' | 'pole' | 'scanner';
export type ConnState = 'connected' | 'connecting' | 'disconnected';
export type Status = Record<Channel, ConnState>;

/** POS register types — each listens on its own VJ/pole/scanner ports. */
export type RegisterType = 'radiant6-canada' | 'bulloch' | 'radiant6-us';

/**
 * Per-register-type defaults (the ports the player listens on). Radiant6 Canada
 * uses VJ 5438 / pole 5439; Bulloch is pole-primary on 5440 (legacy
 * `debug1.properties`: "Bulloch typically listens on TCP 5440"). Radiant6 US
 * has no pole display — VJ 5438 plus the scanner reverse channel on 10000
 * (legacy `scanner.ioParams=TCP:10000`), where the player writes completer
 * barcode injects.
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
 */
export function channelsForRegisterType(type: RegisterType): Channel[] {
  if (type === 'bulloch') return ['pole'];
  if (type === 'radiant6-us') return ['vj', 'scanner'];
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
