import { describe, it, expect } from 'vitest';
import {
  normalizePlayerConfig,
  DEFAULT_POS_CONFIG,
  DEFAULT_PLAYER_CONFIG,
  REGISTER_TYPES,
  portsForRegisterType,
  channelsForRegisterType,
  isUsRegisterType,
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

  it('lists the register types with labels', () => {
    expect(REGISTER_TYPES.map((r) => r.value)).toEqual(['radiant6-canada', 'bulloch', 'radiant6-us', 'verifone']);
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
