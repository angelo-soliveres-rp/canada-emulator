import { describe, it, expect } from 'vitest';
import { buildOrderDoc, centsToDollars, SOURCE_EMULATOR } from './NgrpEncoder';
import type { SessionSnapshot } from './RegisterSession';

/** Minimal snapshot builder for encoder tests. */
function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    tx: 1,
    started: true,
    locale: 'en',
    lines: [],
    subtotalCents: 0,
    taxCents: 0,
    totalCents: 0,
    ...overrides,
  };
}

describe('centsToDollars', () => {
  it('converts integer cents to 2-decimal dollars', () => {
    expect(centsToDollars(0)).toBe(0);
    expect(centsToDollars(5)).toBe(0.05);
    expect(centsToDollars(229)).toBe(2.29);
    expect(centsToDollars(100000)).toBe(1000);
  });

  it('rounds sub-cent inputs to the nearest cent', () => {
    expect(centsToDollars(229.4)).toBe(2.29);
    expect(centsToDollars(229.6)).toBe(2.3);
  });
});

describe('buildOrderDoc', () => {
  it('wraps the order in the Mashgin envelope with source=EMULATOR', () => {
    const doc = buildOrderDoc(snapshot(), { uuid: 'ABC', storeId: '3016875', status: 'OPEN' });
    expect(doc.source).toBe(SOURCE_EMULATOR);
    expect(doc.store).toEqual({ id: '3016875' });
    expect(doc.storeId).toBe('3016875');
    expect(doc.reportLocation).toBe('3016875');
    expect(doc.changed).toBe(true);
    expect(doc.menu).toEqual({});
    expect(doc.order.uuid).toBe('ABC');
    expect(doc.order.registerId).toBe('0501');
  });

  it('maps a line item to the real NGRP shape with dollar amounts', () => {
    const doc = buildOrderDoc(
      snapshot({
        lines: [
          {
            lineNumber: 1,
            code: '049000000443',
            description: 'Coke 20oz',
            quantity: 2,
            unitPriceCents: 229,
            extendedCents: 458,
            voided: false,
          },
        ],
        subtotalCents: 458,
        taxCents: 23,
        totalCents: 481,
      }),
      { uuid: 'U', storeId: 'S', status: 'OPEN' },
    );

    expect(doc.order.itemLines).toEqual([
      {
        id: 'line-1',
        itemId: 'item-049000000443',
        amount: 2.29,
        quantity: 2,
        code: '049000000443-0',
        posCode: '049000000443',
        voided: false,
        description: 'Coke 20oz',
        lineSeq: 1,
      },
    ]);
    expect(doc.order.subtotal).toBe(4.58);
    expect(doc.order.taxTotal).toBe(0.23);
    expect(doc.order.total).toBe(4.81);
    expect(doc.order.discountTotal).toBe(0);
  });

  it('keeps voided lines with the voided flag set', () => {
    const doc = buildOrderDoc(
      snapshot({
        lines: [
          { lineNumber: 1, code: '1', description: 'A', quantity: 1, unitPriceCents: 100, extendedCents: 100, voided: true },
        ],
      }),
      { uuid: 'U', storeId: 'S', status: 'OPEN' },
    );
    expect(doc.order.itemLines[0].voided).toBe(true);
  });

  it('falls back to the line number when an item has no code', () => {
    const doc = buildOrderDoc(
      snapshot({
        lines: [
          { lineNumber: 7, code: '', description: 'No code', quantity: 1, unitPriceCents: 50, extendedCents: 50, voided: false },
        ],
      }),
      { uuid: 'U', storeId: 'S', status: 'OPEN' },
    );
    expect(doc.order.itemLines[0].posCode).toBe('7');
    expect(doc.order.itemLines[0].code).toBe('7-0');
    expect(doc.order.itemLines[0].itemId).toBe('item-7');
  });

  it('omits customer unless one is supplied, and includes it when signed in', () => {
    const open = buildOrderDoc(snapshot(), { uuid: 'U', storeId: 'S', status: 'OPEN' });
    expect(open.order.customer).toBeUndefined();

    const signedIn = buildOrderDoc(snapshot(), {
      uuid: 'U',
      storeId: 'S',
      status: 'OPEN',
      customer: { brierleyId: '', mobileNumber: '+15551234567', oktaId: '', loyaltyCard: '6009' },
    });
    expect(signedIn.order.customer).toEqual({
      brierleyId: '',
      mobileNumber: '+15551234567',
      oktaId: '',
      loyaltyCard: '6009',
    });
  });

  it('carries the lifecycle status and a custom register id', () => {
    const doc = buildOrderDoc(snapshot(), { uuid: 'U', storeId: 'S', status: 'TENDERED', registerId: '0207' });
    expect(doc.order.status).toBe('TENDERED');
    expect(doc.order.registerId).toBe('0207');
  });
});
