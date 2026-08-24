import { describe, it, expect } from 'vitest';
import {
  normalizePlayerConfig,
  DEFAULT_POS_CONFIG,
  DEFAULT_PLAYER_CONFIG,
  REGISTER_TYPES,
  portsForRegisterType,
  channelsForRegisterType,
  isUsRegisterType,
  isLoaRegisterType,
  loaEntryUrl,
  LOA_PLAYER_ENTRY_URL,
  lolConfigForLane,
  normalizeLolLane,
  normalizeLolPreset,
  normalizePosConfig,
  LOL_HOST,
  type RegisterType,
} from './posTypes';

describe('normalizePlayerConfig', () => {
  it('returns defaults for null/empty input', () => {
    expect(normalizePlayerConfig(null)).toEqual(DEFAULT_PLAYER_CONFIG);
    expect(normalizePlayerConfig({})).toEqual(DEFAULT_PLAYER_CONFIG);
  });

  it('trims provided values', () => {
    expect(normalizePlayerConfig({ playerCode: '  31989  ', playerKey: ' abc ' })).toMatchObject({
      playerCode: '31989',
      playerKey: 'abc',
    });
  });

  it('falls back to the default backend URL when blank', () => {
    expect(normalizePlayerConfig({ backendBaseUrl: '   ' }).backendBaseUrl).toBe(DEFAULT_PLAYER_CONFIG.backendBaseUrl);
  });

  it('keeps a custom backend URL', () => {
    expect(normalizePlayerConfig({ backendBaseUrl: 'https://x.test/api/' }).backendBaseUrl).toBe('https://x.test/api/');
  });

  it('exposes sane defaults for the POS connection (Radiant6 Canada)', () => {
    expect(DEFAULT_POS_CONFIG).toEqual({
      host: '127.0.0.1',
      vjPort: 5438,
      polePort: 5439,
      scannerPort: 10000,
      registerType: 'radiant6-canada',
    });
  });
});

describe('register types & ports', () => {
  it('maps Radiant6 Canada to VJ 5438 / pole 5439', () => {
    expect(portsForRegisterType('radiant6-canada')).toEqual({ vjPort: 5438, polePort: 5439, scannerPort: 10000 });
  });

  it('maps Bulloch to VJ 5438 / pole 5440 (canonical legacy port)', () => {
    expect(portsForRegisterType('bulloch')).toEqual({ vjPort: 5438, polePort: 5440, scannerPort: 10000 });
  });

  it('maps Radiant6 US to VJ 5438 / scanner 10000 (legacy scanner.ioParams=TCP:10000)', () => {
    expect(portsForRegisterType('radiant6-us')).toEqual({ vjPort: 5438, polePort: 5439, scannerPort: 10000 });
  });

  it('maps Verifone Topaz to the serial-over-TCP dev ports (scanner 10000 / pole 10001 / VJ 10002)', () => {
    expect(portsForRegisterType('verifone')).toEqual({ vjPort: 10002, polePort: 10001, scannerPort: 10000 });
  });

  it('lists the register types with labels', () => {
    expect(REGISTER_TYPES.map((r) => r.value)).toEqual(['radiant6-canada', 'bulloch', 'radiant6-us', 'verifone', 'loa-player']);
    expect(REGISTER_TYPES.find((r) => r.value === 'bulloch')?.label).toBe('Bulloch');
    expect(REGISTER_TYPES.find((r) => r.value === 'radiant6-us')?.label).toBe('Radiant6 US');
    expect(REGISTER_TYPES.find((r) => r.value === 'verifone')?.label).toBe('Verifone Topaz');
  });

  it('opens only the channels each register family uses', () => {
    expect(channelsForRegisterType('radiant6-canada')).toEqual(['vj', 'pole']);
    expect(channelsForRegisterType('bulloch')).toEqual(['pole']);
    expect(channelsForRegisterType('radiant6-us')).toEqual(['vj', 'scanner']);
    expect(channelsForRegisterType('verifone')).toEqual(['vj', 'pole', 'scanner']);
  });

  it('classifies the US register families', () => {
    expect(isUsRegisterType('radiant6-us')).toBe(true);
    expect(isUsRegisterType('verifone')).toBe(true);
    expect(isUsRegisterType('radiant6-canada')).toBe(false);
    expect(isUsRegisterType('bulloch')).toBe(false);
  });
});

describe('Lift-on-Linux (LoL) lane preset', () => {
  it('lane 1 targets the LXC with the base ports', () => {
    expect(lolConfigForLane(1)).toEqual({
      host: LOL_HOST,
      registerType: 'radiant6-us',
      vjPort: 5438,
      polePort: 5439,
      scannerPort: 10000,
    });
  });

  it('offsets VJ by lane-1 (Zynstra TCPDevice rule) and scanner by (lane-1)*10 (lab convention)', () => {
    expect(lolConfigForLane(2)).toMatchObject({ vjPort: 5439, scannerPort: 10010 });
    expect(lolConfigForLane(6)).toMatchObject({ vjPort: 5443, scannerPort: 10050 });
  });

  it('clamps out-of-range or non-integer lanes into 1..6', () => {
    expect(normalizeLolLane(0)).toBe(1);
    expect(normalizeLolLane(7)).toBe(6);
    expect(normalizeLolLane(2.5)).toBe(1);
    expect(normalizeLolLane(NaN)).toBe(1);
    expect(normalizeLolLane(undefined)).toBe(1);
  });

  it('normalizes a persisted LoL preset with defaults', () => {
    expect(normalizeLolPreset(null)).toEqual({ enabled: false, lane: 1 });
    expect(normalizeLolPreset({ enabled: true, lane: 3 })).toEqual({ enabled: true, lane: 3 });
    expect(normalizeLolPreset({ enabled: 'yes' as unknown as boolean, lane: 99 })).toEqual({ enabled: false, lane: 6 });
  });
});

describe('normalizePosConfig (persisted connection restore)', () => {
  it('returns defaults for null/empty input', () => {
    expect(normalizePosConfig(null)).toEqual(DEFAULT_POS_CONFIG);
    expect(normalizePosConfig({})).toEqual(DEFAULT_POS_CONFIG);
  });

  it('keeps a valid persisted config', () => {
    const cfg = { host: '10.1.2.167', vjPort: 5439, polePort: 5439, scannerPort: 10010, registerType: 'radiant6-us' as const };
    expect(normalizePosConfig(cfg)).toEqual(cfg);
  });

  it('falls back per-field on junk: bad ports, unknown register type, blank host', () => {
    expect(
      normalizePosConfig({
        host: '   ',
        vjPort: 0,
        polePort: 70000,
        scannerPort: 1.5 as number,
        registerType: 'ncr-9000' as unknown as RegisterType,
      }),
    ).toEqual(DEFAULT_POS_CONFIG);
  });
});

describe('LOA mode', () => {
  it('opens no channels — it talks to an iframe, not a socket', () => {
    expect(channelsForRegisterType('loa-player')).toEqual([]);
    expect(isLoaRegisterType('loa-player')).toBe(true);
    for (const t of ['radiant6-canada', 'bulloch', 'radiant6-us', 'verifone'] as const) {
      expect(isLoaRegisterType(t)).toBe(false);
    }
  });

  it('is not a US register family (no en-US/cents-exact machinery applies)', () => {
    expect(isUsRegisterType('loa-player')).toBe(false);
  });

  it('loaEntryUrl passes the player key in the hash, and omits it when blank', () => {
    expect(loaEntryUrl('abc-123', 'http://localhost:9000/index.html')).toBe(
      'http://localhost:9000/index.html#playerKey=abc-123',
    );
    // A blank key yields the bare URL: the player then boots on a default config
    // and will not consume our order documents.
    expect(loaEntryUrl('   ', 'http://localhost:9000/index.html')).toBe('http://localhost:9000/index.html');
    expect(loaEntryUrl('k')).toBe(`${LOA_PLAYER_ENTRY_URL}#playerKey=k`);
  });
});
