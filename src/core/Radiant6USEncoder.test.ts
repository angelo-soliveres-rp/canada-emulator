import { describe, it, expect } from 'vitest';
import { Radiant6USEncoder } from './Radiant6USEncoder';

const CLOCK = (): Date => new Date(2026, 6, 16, 10, 30, 5, 7);
const enc = new Radiant6USEncoder({ terminalNumber: 1, clock: CLOCK });

const TIME = 'EventTime=2026-07-16T10:30:05.007';

describe('Radiant6USEncoder — virtual journal lines', () => {
  it('stamps EventId, TerminalNumber and EventTime on every line, CRLF-terminated', () => {
    const line = enc.registerOpen({ tx: 7, operatorId: '12599', operatorName: 'Timothy' });
    expect(line).toBe(
      `EventId=1001,TerminalNumber=1,${TIME},TransactionNumber=7,OperatorId=12599,OperatorName=Timothy\r\n`,
    );
  });

  it('basketStarted emits 1009 Sales', () => {
    expect(enc.basketStarted({ tx: 7 })).toContain('EventId=1009');
    expect(enc.basketStarted({ tx: 7 })).toContain('TransactionType=Sales');
  });

  it('itemAdd emits 1011 with Barcode and decimal-dollar amounts (never cents)', () => {
    const line = enc.itemAdd({
      tx: 7,
      lineNumber: 2,
      barcode: '049000000443',
      description: 'Coke 20oz',
      priceCents: 229,
      quantity: 3,
    });
    expect(line).toContain('EventId=1011');
    expect(line).toContain('Barcode=049000000443');
    expect(line).toContain('UnitPrice=2.29');
    expect(line).toContain('ExtendedPrice=6.87');
    expect(line).toContain('Quantity=3.000');
    expect(line).toContain('ItemType=Regular Sales Item');
  });

  it('itemAdd escapes embedded commas as ,, (wire contract)', () => {
    const line = enc.itemAdd({
      tx: 7,
      lineNumber: 1,
      barcode: '012000001291',
      description: 'CHIPS, BBQ 200G',
      priceCents: 319,
      quantity: 1,
    });
    expect(line).toContain('Description=CHIPS,, BBQ 200G');
  });

  it('itemVoid emits 1012 with ItemNumber AND Barcode (US-only field)', () => {
    const line = enc.itemVoid({ tx: 7, lineNumber: 2, barcode: '049000000443' });
    expect(line).toContain('EventId=1012');
    expect(line).toContain('ItemNumber=2');
    expect(line).toContain('Barcode=049000000443');
  });

  it('priceOverride emits 1013 with plain-decimal NewUnitPrice (no parens)', () => {
    const line = enc.priceOverride({ tx: 7, lineNumber: 2, newUnitPriceCents: 99 });
    expect(line).toContain('EventId=1013');
    expect(line).toContain('NewUnitPrice=0.99');
  });

  it('qtyChange emits 1014 with OldQuantity, NewQuantity and ExtendedPrice always present', () => {
    const line = enc.qtyChange({ tx: 7, lineNumber: 2, oldQuantity: 1, newQuantity: 3, extendedPriceCents: 687 });
    expect(line).toContain('EventId=1014');
    expect(line).toContain('OldQuantity=1.000');
    expect(line).toContain('NewQuantity=3.000');
    expect(line).toContain('ExtendedPrice=6.87');
  });

  it('subtotal emits 1005 with a decimal-dollar Amount (US: VJ-authoritative)', () => {
    const line = enc.subtotal({ tx: 7, amountCents: 687 });
    expect(line).toContain('EventId=1005');
    expect(line).toContain('Amount=6.87');
  });

  it('tax emits 1020 with Amount always present (parser hard-requires it)', () => {
    const line = enc.tax({ tx: 7, amountCents: 0 });
    expect(line).toContain('EventId=1020');
    expect(line).toContain('Amount=0.00');
  });

  it('tender emits 1007 Cash, change emits 1008', () => {
    expect(enc.tender({ tx: 7, amountCents: 800, mopDescription: 'Cash' })).toContain('EventId=1007');
    expect(enc.tender({ tx: 7, amountCents: 800, mopDescription: 'Cash' })).toContain('Amount=8.00');
    expect(enc.change({ tx: 7, amountCents: 65 })).toContain('EventId=1008');
    expect(enc.change({ tx: 7, amountCents: 65 })).toContain('Amount=0.65');
  });

  it('basketEnd emits 1002 with SubtotalAmount/TaxAmount/TotalAmount (US populates them)', () => {
    const line = enc.basketEnd({
      tx: 7,
      type: 'Sales',
      completion: 'Completed',
      subtotalCents: 687,
      taxCents: 48,
      totalCents: 735,
    });
    expect(line).toContain('EventId=1002');
    expect(line).toContain('TransactionCompletionType=Completed');
    expect(line).toContain('SubtotalAmount=6.87');
    expect(line).toContain('TaxAmount=0.48');
    expect(line).toContain('TotalAmount=7.35');
  });

  it('cancelled basketEnd omits the amount fields', () => {
    const line = enc.basketEnd({ tx: 7, type: 'Sales', completion: 'Cancelled' });
    expect(line).toContain('TransactionCompletionType=Cancelled');
    expect(line).not.toContain('SubtotalAmount');
  });

  it('loyalty emits 1024 with DiscountCardId/DiscountCardNumber', () => {
    const line = enc.loyalty({ tx: 7, cardNumber: '8018782603800034999992' });
    expect(line).toContain('EventId=1024');
    expect(line).toContain('DiscountCardNumber=8018782603800034999992');
    expect(line).toContain('DiscountCardId=');
  });

  it('negative amounts use a leading minus, never parentheses (US parseFloat path)', () => {
    const line = enc.qtyChange({ tx: 7, lineNumber: 1, oldQuantity: 2, newQuantity: 1, extendedPriceCents: -229 });
    expect(line).toContain('ExtendedPrice=-2.29');
    expect(line).not.toContain('(');
  });
});
