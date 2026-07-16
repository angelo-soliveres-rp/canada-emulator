/**
 * Round-trip test: feed the Verifone Topaz emulator's encoder output through
 * CK Player 2.0's REAL verifone parsers and assert they decode the expected
 * events — same compatibility proof as the Canada and Radiant6 US suites.
 *
 * Topaz-specific expectations baked in:
 *   - the preserved "Sub Total"→BASKET_TOTAL shadow quirk (the player's TOTAL
 *     branch runs before SUBTOTAL and substring-matches " Total")
 *   - amounts are decimal dollars via the player's parseAmount
 *   - LOYALTY routes 10-digit numbers to mobile sign-in, others to swipe
 *   - the pole parser decodes TOTAL/CHANGE/TENDER windows and deliberately
 *     ignores generic item windows (VJ-authoritative in the US)
 */
import { describe, it, expect } from 'vitest';
import { TopazEncoder } from '../TopazEncoder';
import { RegisterSession } from '../RegisterSession';

import { TopazMessageParser } from '@ckp2/electron/plugins/verifone/TopazMessageParser';
import { TopazPoleDisplayParser, createTopazPoleDisplayContext } from '@ckp2/electron/plugins/verifone/TopazPoleDisplayParser';
import { DEFAULT_TOPAZ_CONTEXT } from '@ckp2/electron/plugins/verifone/types';
import type { RegisterEvent } from '@ckp2/electron/core/Peripheral';

const SOURCE = { name: 'emulator' };

const enc = new TopazEncoder({ registerId: 101 });

/** Parse one or more frames with a fresh parser and return the events. */
function parse(frames: string): RegisterEvent[] {
  return new TopazMessageParser({ ...DEFAULT_TOPAZ_CONTEXT }).append(frames);
}

function one(frames: string): RegisterEvent {
  const events = parse(frames);
  expect(events).toHaveLength(1);
  return events[0];
}

describe('round-trip: Topaz VJ encoder → CKPlayer2.0 TopazMessageParser', () => {
  it('cashier line decodes to CASHIER_RECOGNIZED with the trimmed name', () => {
    const e = one(enc.cashier('LAKELEY'));
    expect(e.action).toBe('CASHIER_RECOGNIZED');
    expect(e.data.cashierName).toBe('LAKELEY');
  });

  it('item add decodes to ITEM_ADDED with description, quantity and dollar amount', () => {
    const e = one(enc.itemAdd({ description: 'COKE ZERO EACH', quantity: 5, extendedCents: 745 }));
    expect(e.action).toBe('ITEM_ADDED');
    expect(e.data.description).toContain('COKE ZERO');
    expect(e.data.quantity).toBe(5);
    expect(e.data.price).toBeCloseTo(7.45, 5);
  });

  it('a short description still decodes as an item (padded to the 5-char regex minimum)', () => {
    const e = one(enc.itemAdd({ description: 'GUM', quantity: 1, extendedCents: 99 }));
    expect(e.action).toBe('ITEM_ADDED');
    expect(e.data.price).toBeCloseTo(0.99, 5);
  });

  it('a 3-digit quantity with a full-width 20-char description still parses (column separator)', () => {
    const e = one(enc.itemAdd({ description: 'COCACOLA 20OZ BOTTLE XL', quantity: 150, extendedCents: 34350 }));
    expect(e.action).toBe('ITEM_ADDED');
    expect(e.data.quantity).toBe(150);
    expect(e.data.price).toBeCloseTo(343.5, 5);
  });

  it('PARSER-PARITY QUIRK: a V-leading description loses its V to the positive-void rescue', () => {
    // The player's positive-void rescue (legacy TopazVirtualJournal.java
    // 426-461, ported verbatim) treats `\s+V…` as a void marker — real
    // hardware corrupts "V8 JUICE" the same way. The emulator stays faithful
    // to the wire; this test pins the shared behavior so a change on either
    // side surfaces here.
    const e = one(enc.itemAdd({ description: 'V8 JUICE', quantity: 1, extendedCents: 229 }));
    expect(e.action).toBe('ITEM_ADDED');
    expect(e.data.description).toBe('8 JUICE');
  });

  it('item void decodes to ITEM_VOID with the negative amount and voided flag', () => {
    const e = one(enc.itemVoid({ description: 'RICKER POP 44OZ', quantity: 1, extendedCents: 109 }));
    expect(e.action).toBe('ITEM_VOID');
    expect(e.data.voided).toBe(true);
    expect(e.data.price).toBeCloseTo(-1.09, 5);
    expect(e.data.description).toContain('RICKER POP');
  });

  it('SHADOW QUIRK: the Sub Total line decodes as BASKET_TOTAL (preserved legacy behavior)', () => {
    const e = one(enc.subTotal(500));
    expect(e.action).toBe('BASKET_TOTAL');
    expect(e.data.total).toBeCloseTo(5.0, 5);
  });

  it('TAX and TOTAL lines decode with dollar amounts', () => {
    expect(one(enc.tax(48)).action).toBe('TAX');
    expect(one(enc.tax(48)).data.tax).toBeCloseTo(0.48, 5);
    expect(one(enc.total(735)).action).toBe('BASKET_TOTAL');
    expect(one(enc.total(735)).data.total).toBeCloseTo(7.35, 5);
  });

  it('CASH tender decodes to TENDER with the tender type', () => {
    const e = one(enc.tender({ amountCents: 4000 }));
    expect(e.action).toBe('TENDER');
    expect(e.data.tenderType).toBe('CASH');
    expect(e.data.total).toBeCloseTo(40.0, 5);
  });

  it('VOID TICKET decodes to BASKET_VOIDED', () => {
    expect(one(enc.voidTicket(1010676)).action).toBe('BASKET_VOIDED');
  });

  it('ST#/DR#/TRAN# decodes to BASKET_END with receiptNum = TRAN#', () => {
    const e = one(enc.basketEnd({ storeNumber: '26', tx: 1011426 }));
    expect(e.action).toBe('BASKET_END');
    expect(e.data.receiptNum).toBe('1011426');
  });

  it('LOYALTY routes 22-digit cards to LOYALTY_SWIPE and 10-digit numbers to mobile sign-in', () => {
    const swipe = one(enc.loyalty('8018782603800034999992'));
    expect(swipe.action).toBe('LOYALTY_SWIPE');
    expect(swipe.data.loyaltyCard).toBe('8018782603800034999992');

    const mobile = one(enc.loyalty('5551234567'));
    expect(mobile.action).toBe('LOYALTY_MOBILE_SIGNIN');
    expect(mobile.data.mobileNumber).toBe('5551234567');
  });

  it('a voided ticket decodes BASKET_VOIDED followed by BASKET_END (trailer closes the basket)', () => {
    const s = new RegisterSession({ registerType: 'verifone' });
    s.addItem({ code: 'a', description: 'GUM PACK', priceCents: 99 });
    const parser = new TopazMessageParser({ ...DEFAULT_TOPAZ_CONTEXT });
    const actions = s
      .voidTicket()
      .flatMap((m) => parser.append(m.data))
      .map((e) => e.action);
    expect(actions.indexOf('BASKET_VOIDED')).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf('BASKET_END')).toBeGreaterThan(actions.indexOf('BASKET_VOIDED'));
  });

  it('frames split across chunks reassemble (buffered header find)', () => {
    const parser = new TopazMessageParser({ ...DEFAULT_TOPAZ_CONTEXT });
    const frame = enc.itemAdd({ description: 'COKE ZERO EACH', quantity: 1, extendedCents: 229 });
    const events = [...parser.append(frame.slice(0, 15)), ...parser.append(frame.slice(15))];
    expect(events.map((e) => e.action)).toContain('ITEM_ADDED');
  });

  it('a full RegisterSession verifone sale decodes end-to-end with exact cents', () => {
    const s = new RegisterSession({ registerType: 'verifone' });
    const wire = [
      ...s.addItem({ code: '049000000443', description: 'GUM PACK', priceCents: 99, quantity: 3 }),
      ...s.tender('cash-exact'),
    ];
    const parser = new TopazMessageParser({ ...DEFAULT_TOPAZ_CONTEXT });
    const events = wire
      .filter((m) => m.channel === 'vj')
      .flatMap((m) => parser.append(m.data));
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['CASHIER_RECOGNIZED', 'ITEM_ADDED', 'BASKET_TOTAL', 'TAX', 'TENDER', 'BASKET_END']),
    );
    // Cents-exact: the TOTAL line carries 3.12, never a 5¢-rounded 3.10.
    const totals = events.filter((e) => e.action === 'BASKET_TOTAL').map((e) => e.data.total);
    expect(totals).toContain(3.12);
    expect(totals).not.toContain(3.1);
  });
});

describe('round-trip: Topaz pole encoder → CKPlayer2.0 TopazPoleDisplayParser', () => {
  function pole(chunk: string): RegisterEvent[] {
    return TopazPoleDisplayParser.parseChunk(SOURCE, chunk, createTopazPoleDisplayContext());
  }

  it('TOTAL window decodes to POLEDISP_TOTAL with cents (en-US)', () => {
    const events = pole(enc.poleTotal(1129));
    const total = events.find((e) => e.action === 'POLEDISP_TOTAL')!;
    expect(total.data.poleDisplay).toMatchObject({ kind: 'total', totalCents: 1129, posLocale: 'en-US' });
  });

  it('CHANGE window decodes to POLEDISP_CHANGE', () => {
    const events = pole(enc.poleChange(88));
    const change = events.find((e) => e.action === 'POLEDISP_CHANGE')!;
    expect(change.data.poleDisplay).toMatchObject({ kind: 'change', changeCents: 88 });
  });

  it('CASH tender window decodes to POLEDISP_TENDER', () => {
    const events = pole(enc.poleTender(1825));
    const tender = events.find((e) => e.action === 'POLEDISP_TENDER')!;
    expect(tender.data.poleDisplay).toMatchObject({ kind: 'tender', mop: 'CASH', tenderCents: 1825 });
  });

  it('generic item windows are deliberately ignored (VJ-authoritative) but still mirror to POLEDISP_UPDATED', () => {
    const events = pole(enc.poleItem('COKE 20OZ', 229));
    expect(events.some((e) => e.action === 'POLEDISP_ITEM_ADD')).toBe(false);
    expect(events.some((e) => e.action === 'POLEDISP_UPDATED')).toBe(true);
  });
});
