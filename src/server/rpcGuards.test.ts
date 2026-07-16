import { describe, it, expect } from 'vitest';
import { resolve, delimiter } from 'path';
import {
  RpcArgError,
  parseConnectArgs,
  parseSendArgs,
  parseDirArg,
  parseAllowedDirs,
  parsePricebookArgs,
  parseQuickKeysArgs,
  parseRegisterPlayerArgs,
  parseAdsArgs,
  parseAdDetailArgs,
  isLoopbackHost,
  tokenEquals,
} from './rpcGuards';

const goodConnect = {
  host: '127.0.0.1',
  vjPort: 5438,
  polePort: 5439,
  scannerPort: 10000,
  registerType: 'radiant6-us',
};

describe('parseConnectArgs', () => {
  it('accepts a well-formed PosConfig and strips unknown fields', () => {
    const config = parseConnectArgs([{ ...goodConnect, extra: 'ignored' }]);
    expect(config).toEqual(goodConnect);
    expect('extra' in config).toBe(false);
  });

  it('rejects a missing host, out-of-range port, and unknown register type', () => {
    expect(() => parseConnectArgs([{ ...goodConnect, host: '' }])).toThrow(RpcArgError);
    expect(() => parseConnectArgs([{ ...goodConnect, vjPort: 0 }])).toThrow(RpcArgError);
    expect(() => parseConnectArgs([{ ...goodConnect, vjPort: 5438.5 }])).toThrow(RpcArgError);
    expect(() => parseConnectArgs([{ ...goodConnect, registerType: 'gilbarco' }])).toThrow(RpcArgError);
  });

  it('rejects non-object args', () => {
    expect(() => parseConnectArgs([])).toThrow(RpcArgError);
    expect(() => parseConnectArgs(['tcp://evil'])).toThrow(RpcArgError);
  });
});

describe('parseSendArgs', () => {
  it('accepts a known channel with string data', () => {
    expect(parseSendArgs(['vj', 'EventId=1011\r\n'])).toEqual({ channel: 'vj', data: 'EventId=1011\r\n' });
  });

  it('rejects unknown channels and oversized/non-string data', () => {
    expect(() => parseSendArgs(['stdin', 'x'])).toThrow(RpcArgError);
    expect(() => parseSendArgs(['vj', 42])).toThrow(RpcArgError);
    expect(() => parseSendArgs(['vj', 'x'.repeat(70000)])).toThrow(RpcArgError);
  });
});

describe('parseDirArg (path traversal / allow-list)', () => {
  const allowed = [resolve('/srv/pricebooks')];

  it('treats empty/absent dir as "use bundled" (always allowed)', () => {
    expect(parseDirArg(undefined, [])).toBeUndefined();
    expect(parseDirArg('', allowed)).toBeUndefined();
    expect(parseDirArg('   ', allowed)).toBeUndefined();
  });

  it('accepts a dir inside an allowed root and resolves it', () => {
    expect(parseDirArg('/srv/pricebooks/site-31989', allowed)).toBe(resolve('/srv/pricebooks/site-31989'));
    expect(parseDirArg('/srv/pricebooks', allowed)).toBe(resolve('/srv/pricebooks'));
  });

  it('rejects escapes: outside roots, ../ traversal out, and prefix cousins', () => {
    expect(() => parseDirArg('/etc', allowed)).toThrow(RpcArgError);
    expect(() => parseDirArg('/srv/pricebooks/../../etc', allowed)).toThrow(RpcArgError);
    expect(() => parseDirArg('/srv/pricebooks-evil', allowed)).toThrow(RpcArgError);
  });

  it('rejects every non-empty dir when no allow-list is configured', () => {
    expect(() => parseDirArg('/srv/pricebooks', [])).toThrow(/EMULATOR_ALLOWED_DIRS/);
  });
});

describe('parseAllowedDirs', () => {
  it('splits on the platform delimiter and resolves entries', () => {
    const env = ['/srv/a', ' /srv/b ', ''].join(delimiter);
    expect(parseAllowedDirs(env)).toEqual([resolve('/srv/a'), resolve('/srv/b')]);
  });

  it('returns empty for unset env', () => {
    expect(parseAllowedDirs(undefined)).toEqual([]);
  });
});

describe('request-shaped parsers', () => {
  it('parsePricebookArgs requires playerCode and validates dir', () => {
    expect(parsePricebookArgs([{ playerCode: 'CAD-31989' }], [])).toEqual({ dir: undefined, playerCode: 'CAD-31989' });
    expect(() => parsePricebookArgs([{ playerCode: '' }], [])).toThrow(RpcArgError);
    expect(() => parsePricebookArgs([{ playerCode: 'x', dir: '/etc' }], [])).toThrow(RpcArgError);
  });

  it('parseQuickKeysArgs tolerates a missing request object (bundled defaults)', () => {
    expect(parseQuickKeysArgs([], [])).toEqual({ dir: undefined });
  });

  it('parseRegisterPlayerArgs requires a playerKey', () => {
    expect(parseRegisterPlayerArgs([{ playerKey: 'abc' }])).toEqual({ playerKey: 'abc', product: undefined });
    expect(() => parseRegisterPlayerArgs([{ playerKey: '' }])).toThrow(RpcArgError);
  });

  it('parseAdsArgs/parseAdDetailArgs require an http(s) backend URL on an allowed origin', () => {
    const origins = new Set(['https://player.example.com']);
    const good = { backendBaseUrl: 'https://player.example.com/api/lift/', playerCode: 'us-1', playerKey: 'k' };
    expect(parseAdsArgs([good], origins).backendBaseUrl).toBe(good.backendBaseUrl);
    expect(() => parseAdsArgs([{ ...good, backendBaseUrl: 'file:///etc/passwd' }], origins)).toThrow(RpcArgError);
    expect(() => parseAdsArgs([{ ...good, backendBaseUrl: 'not a url' }], origins)).toThrow(RpcArgError);
    // SSRF guard: syntactically fine URLs on unknown origins are refused.
    expect(() => parseAdsArgs([{ ...good, backendBaseUrl: 'https://169.254.169.254/latest/' }], origins)).toThrow(
      RpcArgError,
    );
    expect(() => parseAdsArgs([{ ...good, backendBaseUrl: 'https://evil.example.net/api/lift/' }], origins)).toThrow(
      RpcArgError,
    );
    expect(parseAdDetailArgs([{ ...good, id: 'ad-1' }], origins).id).toBe('ad-1');
    expect(() => parseAdDetailArgs([{ ...good }], origins)).toThrow(RpcArgError);
  });
});

describe('auth helpers', () => {
  it('isLoopbackHost accepts every loopback spelling and rejects LAN binds', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', 'localhost', 'LOCALHOST', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ['0.0.0.0', '::', '192.168.1.10', '10.1.2.202']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it('tokenEquals matches only the exact token', () => {
    expect(tokenEquals('secret', 'secret')).toBe(true);
    expect(tokenEquals('Secret', 'secret')).toBe(false);
    expect(tokenEquals('secre', 'secret')).toBe(false);
    expect(tokenEquals(null, 'secret')).toBe(false);
  });
});
