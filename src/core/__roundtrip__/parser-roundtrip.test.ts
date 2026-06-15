/**
 * Round-trip test: feed the emulator's encoder output through CK Player 2.0's
 * REAL radiant6-canada parsers and assert they decode the expected events.
 *
 * This is the proof that the emulator "works with CKPlayer2.0 radiant6canada":
 * if these parsers (imported directly from the sibling repo) accept our bytes
 * and emit the right RegisterEvents, the player will too.
 *
 * The parsers are pure (no Node/Electron imports), so they run unchanged here.
 */
import { describe, it, expect } from 'vitest';
import { Radiant6CanadaEncoder } from '../Radiant6CanadaEncoder';

// CK Player 2.0 sibling repo — real parsers, not copies. `@ckp2` is resolved
// by vitest.config.ts (CKP2_DIR env var, or an upward search for a sibling
// checkout named omni/ or CKPlayer2.0/); when the repo is absent the whole
// __roundtrip__ dir is excluded with a loud warning instead of failing.
import { Radiant6CanadaMessageParser } from '@ckp2/electron/plugins/radiant6-canada/Radiant6CanadaMessageParser';
import { Radiant6CanadaPoleDisplayParser } from '@ckp2/electron/plugins/radiant6-canada/Radiant6CanadaPoleDisplayParser';
import type { ParserContext, PoleDisplayContext } from '@ckp2/electron/plugins/radiant6-canada/types';

const SOURCE = { name: 'emulator' };

function vjCtx(locale: 'en' | 'fr' = 'en'): ParserContext {
  return {
    lastLine1: '',
    lastLine2: '',
    lastSubtotal: 0,
    txNumsToIgnore: [],
    locale,
    lookupItem: () => null,
    calibrationUpc: null,
    prepayFuelDescription: 'Pre-pay Fuel',
  };
}

const enc = new Radiant6CanadaEncoder({ terminalNumber: 1 });

/** Parse a VJ line and return the list of emitted action strings. */
function vjActions(line: string, ctx: ParserContext = vjCtx()): string[] {
  const events = Radiant6CanadaMessageParser.parseLine(SOURCE, line, ctx) ?? [];
  return events.map((e) => e.action);
}

describe('round-trip: VJ encoder → CKPlayer2.0 Radiant6CanadaMessageParser', () => {
  it('registerOpen decodes to REGISTER_OPEN (+ cashier recognition)', () => {
    const actions = vjActions(enc.registerOpen({ tx: 1, operatorId: '42', operatorName: 'Joe' }));
    expect(actions).toContain('REGISTER_OPEN');
    expect(actions).toContain('CASHIER_RECOGNIZED');
  });

  it('basketStarted decodes to BASKET_START', () => {
    expect(vjActions(enc.basketStarted({ tx: 1 }))).toContain('BASKET_START');
  });

  it('itemAdd decodes to SCAN_RECEIVED + ITEM_ADDED + POLEDISP_UPDATED with correct fields', () => {
    const ctx = vjCtx();
    const events = Radiant6CanadaMessageParser.parseLine(
      SOURCE,
      enc.itemAdd({ tx: 24, lineNumber: 1, barcode: '049000000443', description: 'Coke', priceCents: 169, quantity: 1 }),
      ctx,
    )!;
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['SCAN_RECEIVED', 'ITEM_ADDED', 'POLEDISP_UPDATED']));
    const itemAdded = events.find((e) => e.action === 'ITEM_ADDED')!;
    // ITEM_ADDED carries the barcode as `upc` since omni commit db29599
    // (2026-06-04, renamed from `code`); the fallback accepts pre-rename
    // checkouts. SCAN_RECEIVED uses `code` in both generations.
    expect(itemAdded.data.upc ?? itemAdded.data.code).toBe('049000000443');
    expect(itemAdded.data.description).toBe('Coke');
    expect(itemAdded.data.price).toBeCloseTo(1.69, 5);
  });

  it('itemAdd with embedded comma + fr decimal roundtrips the `,,` escaping through the real parser', () => {
    const ctx = vjCtx('fr');
    const events = Radiant6CanadaMessageParser.parseLine(
      SOURCE,
      enc.itemAdd({ tx: 24, lineNumber: 1, barcode: '060410012345', description: 'CHIPS, BBQ 200G', priceCents: 194, quantity: 1, locale: 'fr' }),
      ctx,
    )!;
    const itemAdded = events.find((e) => e.action === 'ITEM_ADDED')!;
    expect(itemAdded.data.upc ?? itemAdded.data.code).toBe('060410012345');
    // The comma survives unescaped: the parser masks `,,`, splits on `,`, restores.
    expect(itemAdded.data.description).toBe('CHIPS, BBQ 200G');
    // And the fr decimal `UnitPrice=1,,94` decodes back to 1.94.
    expect(itemAdded.data.price).toBeCloseTo(1.94, 5);
  });

  it('itemVoid / priceOverride / qtyChange decode to their actions', () => {
    expect(vjActions(enc.itemVoid({ tx: 1, lineNumber: 2 }))).toContain('ITEM_VOID');
    expect(vjActions(enc.priceOverride({ tx: 1, lineNumber: 2, newUnitPriceCents: 99 }))).toContain('PRICE_OVERRIDE');
    expect(vjActions(enc.qtyChange({ tx: 1, lineNumber: 2, oldQuantity: 1, newQuantity: 3, extendedPriceCents: 300 }))).toContain('ITEM_QTY_CHANGE');
  });

  it('tender / change decode to TENDER / CHANGE', () => {
    expect(vjActions(enc.tender({ tx: 77, amountCents: 1800, mopDescription: 'Cash' }))).toContain('TENDER');
    expect(vjActions(enc.change({ tx: 77, amountCents: 6 }))).toContain('CHANGE');
  });

  it('Arrondir rounding (1022) is silently ignored by the parser', () => {
    expect(vjActions(enc.rounding({ tx: 9, amountCents: 2 }))).toEqual([]);
  });

  it('loyalty (1024) decodes to LOYALTY_OR_UPC_SCANNED carrying the card number', () => {
    const events = Radiant6CanadaMessageParser.parseLine(
      SOURCE,
      enc.loyalty({ tx: 9, cardId: '70000000001', cardNumber: '8018782603800034999992' }),
      vjCtx(),
    )!;
    const loyalty = events.find((e) => e.action === 'LOYALTY_OR_UPC_SCANNED')!;
    expect(loyalty).toBeDefined();
    expect(loyalty.data.loyaltyOrUpc?.discountCardNumber).toBe('8018782603800034999992');
  });

  it('NEVER emits 1005/1020, so the parser never sees subtotal/tax on the VJ', () => {
    // The parser explicitly returns [] for these; our encoder never produces them.
    const lifecycle = [
      enc.registerOpen({ tx: 1, operatorId: '42', operatorName: 'Joe' }),
      enc.basketStarted({ tx: 1 }),
      enc.itemAdd({ tx: 1, lineNumber: 1, barcode: '049000000443', description: 'Coke', priceCents: 169, quantity: 1 }),
      enc.tender({ tx: 1, amountCents: 177, mopDescription: 'Cash' }),
    ].join('');
    expect(lifecycle).not.toMatch(/EventId=(1005|1020)/);
  });
});

describe('round-trip: pole encoder → CKPlayer2.0 Radiant6CanadaPoleDisplayParser', () => {
  function pole(window: string, locale: 'en' | 'fr' = 'en') {
    const ctx: PoleDisplayContext = { buffer: '', locale };
    return Radiant6CanadaPoleDisplayParser.parseChunk(SOURCE, window, ctx);
  }

  it('en balance decodes to POLEDISP_TOTAL totalCents=194 (en-CA)', () => {
    const e = pole(enc.poleBalance(194, 'en'))[0];
    expect(e.action).toBe('POLEDISP_TOTAL');
    expect(e.data.poleDisplay).toMatchObject({ kind: 'total', totalCents: 194, posLocale: 'en-CA' });
  });

  it('fr balance decodes to POLEDISP_TOTAL totalCents=194 (fr-CA) after U+FFFD→space', () => {
    const e = pole(enc.poleBalance(194, 'fr'), 'fr')[0];
    expect(e.action).toBe('POLEDISP_TOTAL');
    expect(e.data.poleDisplay).toMatchObject({ kind: 'total', totalCents: 194, posLocale: 'fr-CA' });
  });

  it('en change decodes to POLEDISP_CHANGE changeCents=6', () => {
    const e = pole(enc.poleChange(6, 'en'))[0];
    expect(e.action).toBe('POLEDISP_CHANGE');
    expect(e.data.poleDisplay).toMatchObject({ kind: 'change', changeCents: 6, posLocale: 'en-CA' });
  });

  it('fr change decodes to POLEDISP_CHANGE changeCents=6 (fr-CA)', () => {
    const e = pole(enc.poleChange(6, 'fr'), 'fr')[0];
    expect(e.action).toBe('POLEDISP_CHANGE');
    expect(e.data.poleDisplay).toMatchObject({ kind: 'change', changeCents: 6, posLocale: 'fr-CA' });
  });

  it('en product line decodes to POLEDISP_ITEM_ADD', () => {
    const e = pole(enc.poleItem(1, 'Coke', 194, 'en'))[0];
    expect(e.action).toBe('POLEDISP_ITEM_ADD');
    expect(e.data.poleDisplay).toMatchObject({ kind: 'item', qty: 1, description: 'Coke', priceCents: 194 });
  });
});
