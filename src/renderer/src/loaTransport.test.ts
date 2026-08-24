import { describe, it, expect } from 'vitest';
import { injectCommandsFromMessage } from './loaTransport';

describe('injectCommandsFromMessage', () => {
  it('translates each completer itemCode into a barcode inject (qty 1)', () => {
    const cmds = injectCommandsFromMessage({
      name: 'rp-inject-item',
      details: { completers: [{ itemCode: '049000000443', upsellId: 2 }, { itemCode: '012000001291', upsellId: 3 }] },
    });
    expect(cmds).toEqual([
      { barcode: '049000000443', quantity: 1 },
      { barcode: '012000001291', quantity: 1 },
    ]);
  });

  it('coerces a numeric itemCode to a string barcode', () => {
    expect(injectCommandsFromMessage({ name: 'rp-inject-item', details: { completers: [{ itemCode: 12345 }] } })).toEqual([
      { barcode: '12345', quantity: 1 },
    ]);
  });

  it('skips completers with a missing or empty itemCode', () => {
    const cmds = injectCommandsFromMessage({
      name: 'rp-inject-item',
      details: { completers: [{ itemCode: '' }, { upsellId: 9 }, { itemCode: 'ABC' }] },
    });
    expect(cmds).toEqual([{ barcode: 'ABC', quantity: 1 }]);
  });

  it('yields nothing for non-inject messages or empty/absent details', () => {
    expect(injectCommandsFromMessage({ name: 'rp-ad-shown', details: {} })).toEqual([]);
    expect(injectCommandsFromMessage({ name: 'rp-inject-item' })).toEqual([]);
    expect(injectCommandsFromMessage({ name: 'rp-inject-item', details: { completers: [] } })).toEqual([]);
    expect(injectCommandsFromMessage(null)).toEqual([]);
    expect(injectCommandsFromMessage(undefined)).toEqual([]);
  });
});
