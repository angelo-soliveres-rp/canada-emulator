/**
 * Round-trip test: feed the US emulator's encoder output through CK Player
 * 2.0's REAL `radiant6` (US) parser and assert it decodes the expected events.
 *
 * Same contract as parser-roundtrip.test.ts for Canada: if the sibling repo's
 * parser accepts our bytes and emits the right RegisterEvents, the player will
 * too. The US-specific assertions are the inverse of Canada's:
 *   - 1005 subtotal and 1020 tax DECODE (VJ-authoritative; Canada drops them)
 *   - amounts are decimal dollars via parseFloat
 *   - 1012 carries the voided Barcode; 1002 carries Subtotal/Tax/TotalAmount
 *   - no Arrondir guard exists — the emulator never emits 1022 at all
 */
import { describe, it, expect } from 'vitest';
import { Radiant6USEncoder } from '../Radiant6USEncoder';
import { RegisterSession } from '../RegisterSession';

import { Radiant6MessageParser } from '@ckp2/electron/plugins/radiant6/Radiant6MessageParser';
import type { ParserContext } from '@ckp2/electron/plugins/radiant6/types';

const SOURCE = { name: 'emulator' };

function usCtx(): ParserContext {
  return {
    lastLine1: '',
    lastLine2: '',
    lastSubtotal: 0,
    txNumsToIgnore: [],
    calibrationUpc: null,
    prepayFuelDescription: 'Pre-pay Fuel',
    fuelBinRangeStart: '782603797000000000',
    fuelBinRangeEnd: '782603798999999999',
    lookupItem: () => null,
  };
}

const enc = new Radiant6USEncoder({ terminalNumber: 1 });

function vjActions(line: string, ctx: ParserContext = usCtx()): string[] {
  const events = Radiant6MessageParser.parseLine(SOURCE, line, ctx) ?? [];
  return events.map((e) => e.action);
}

describe('round-trip: US VJ encoder → CKPlayer2.0 Radiant6MessageParser', () => {
  it('registerOpen decodes to REGISTER_OPEN (+ cashier recognition)', () => {
    const actions = vjActions(enc.registerOpen({ tx: 1, operatorId: '42', operatorName: 'Joe' }));
    expect(actions).toContain('REGISTER_OPEN');
    expect(actions).toContain('CASHIER_RECOGNIZED');
  });

  it('itemAdd decodes to SCAN_RECEIVED + ITEM_ADDED with barcode, description and dollar price', () => {
    const events = Radiant6MessageParser.parseLine(
      SOURCE,
      enc.itemAdd({ tx: 24, lineNumber: 1, barcode: '049000000443', description: 'Coke', priceCents: 169, quantity: 1 }),
      usCtx(),
    )!;
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['SCAN_RECEIVED', 'ITEM_ADDED']));
    const itemAdded = events.find((e) => e.action === 'ITEM_ADDED')!;
    expect(itemAdded.data.upc).toBe('049000000443');
    expect(itemAdded.data.description).toBe('Coke');
    expect(itemAdded.data.price).toBeCloseTo(1.69, 5);
  });

  it('itemAdd with embedded comma roundtrips the `,,` escaping', () => {
    const events = Radiant6MessageParser.parseLine(
      SOURCE,
      enc.itemAdd({ tx: 24, lineNumber: 1, barcode: '012000001291', description: 'CHIPS, BBQ 200G', priceCents: 194, quantity: 1 }),
      usCtx(),
    )!;
    expect(events.find((e) => e.action === 'ITEM_ADDED')!.data.description).toBe('CHIPS, BBQ 200G');
  });

  it('subtotal (1005) DECODES — US VJ is authoritative (Canada drops this)', () => {
    const ctx = usCtx();
    const events = Radiant6MessageParser.parseLine(SOURCE, enc.subtotal({ tx: 9, amountCents: 687 }), ctx)!;
    const st = events.find((e) => e.action === 'SUBTOTAL')!;
    expect(st.data.subtotal).toBeCloseTo(6.87, 5);
    expect(ctx.lastSubtotal).toBeCloseTo(6.87, 5);
  });

  it('tax (1020) DECODES with the amount and updates the Balance Due pole line', () => {
    const ctx = usCtx();
    Radiant6MessageParser.parseLine(SOURCE, enc.subtotal({ tx: 9, amountCents: 687 }), ctx);
    const events = Radiant6MessageParser.parseLine(SOURCE, enc.tax({ tx: 9, amountCents: 48 }), ctx)!;
    const tax = events.find((e) => e.action === 'TAX')!;
    expect(tax.data.tax).toBeCloseTo(0.48, 5);
    // Balance Due = subtotal + tax, rendered on the parser's virtual pole line.
    expect(events.some((e) => e.action === 'POLEDISP_UPDATED')).toBe(true);
    expect(ctx.lastLine2).toContain('Balance Due');
    expect(ctx.lastLine2).toContain('7.35');
  });

  it('itemVoid decodes to ITEM_VOID carrying the US-only Barcode as upc', () => {
    const events = Radiant6MessageParser.parseLine(
      SOURCE,
      enc.itemVoid({ tx: 9, lineNumber: 2, barcode: '049000000443' }),
      usCtx(),
    )!;
    const v = events.find((e) => e.action === 'ITEM_VOID')!;
    expect(v.data.lineNum).toBe(2);
    expect(v.data.upc).toBe('049000000443');
  });

  it('priceOverride / qtyChange decode with dollar amounts', () => {
    expect(vjActions(enc.priceOverride({ tx: 1, lineNumber: 2, newUnitPriceCents: 99 }))).toContain('PRICE_OVERRIDE');
    const events = Radiant6MessageParser.parseLine(
      SOURCE,
      enc.qtyChange({ tx: 1, lineNumber: 2, oldQuantity: 1, newQuantity: 3, extendedPriceCents: 300 }),
      usCtx(),
    )!;
    const qc = events.find((e) => e.action === 'ITEM_QTY_CHANGE')!;
    expect(qc.data.quantity).toBe(3);
    expect(qc.data.oldQuantity).toBe(1);
    expect(qc.data.price).toBeCloseTo(3.0, 5);
  });

  it('tender / change decode to TENDER / CHANGE', () => {
    expect(vjActions(enc.tender({ tx: 77, amountCents: 1800, mopDescription: 'Cash' }))).toContain('TENDER');
    expect(vjActions(enc.change({ tx: 77, amountCents: 6 }))).toContain('CHANGE');
  });

  it('completed basketEnd decodes BASKET_END with subtotal/tax/total', () => {
    const events = Radiant6MessageParser.parseLine(
      SOURCE,
      enc.basketEnd({ tx: 7, type: 'Sales', completion: 'Completed', subtotalCents: 687, taxCents: 48, totalCents: 735 }),
      usCtx(),
    )!;
    const end = events.find((e) => e.action === 'BASKET_END')!;
    expect(end.data.subtotal).toBeCloseTo(6.87, 5);
    expect(end.data.tax).toBeCloseTo(0.48, 5);
    expect(end.data.total).toBeCloseTo(7.35, 5);
  });

  it('cancelled basketEnd decodes to BASKET_VOIDED', () => {
    expect(vjActions(enc.basketEnd({ tx: 7, type: 'Sales', completion: 'Cancelled' }))).toContain('BASKET_VOIDED');
  });

  it('loyalty (1024) decodes to LOYALTY_OR_UPC_SCANNED for all three discriminator inputs', () => {
    // The parser emits the raw sentinel; the VJ discriminates (sign-in vs
    // 12-digit UPC coupon vs fuel-BIN ignore). All three must survive parsing.
    for (const card of ['8018782603800034999992', '049000000443', '782603797000000001']) {
      const events = Radiant6MessageParser.parseLine(SOURCE, enc.loyalty({ tx: 9, cardNumber: card }), usCtx())!;
      const loyalty = events.find((e) => e.action === 'LOYALTY_OR_UPC_SCANNED')!;
      expect(loyalty.data.loyaltyOrUpc?.discountCardNumber).toBe(card);
    }
  });

  it('a full RegisterSession US sale decodes 1005/1020 and never contains a 1022', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    const wire = [
      ...s.addItem({ code: '049000000443', description: 'Coke', priceCents: 99, quantity: 3 }),
      ...s.tender('cash-exact'),
    ];
    expect(wire.every((m) => m.channel === 'vj')).toBe(true);
    expect(wire.map((m) => m.data).join('')).not.toMatch(/EventId=1022/);

    const ctx = usCtx();
    const actions = wire.flatMap((m) => Radiant6MessageParser.parseLine(SOURCE, m.data, ctx)?.map((e) => e.action) ?? []);
    expect(actions).toEqual(
      expect.arrayContaining(['REGISTER_OPEN', 'BASKET_START', 'ITEM_ADDED', 'SUBTOTAL', 'TAX', 'TENDER', 'CHANGE', 'BASKET_END']),
    );
  });
});
