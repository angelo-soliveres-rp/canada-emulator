import { describe, it, expect } from 'vitest';
import { Radiant6CanadaEncoder } from './Radiant6CanadaEncoder';

const FIXED = new Date('2023-01-01T00:00:00.000');
function enc(): Radiant6CanadaEncoder {
  return new Radiant6CanadaEncoder({ terminalNumber: 1, clock: () => FIXED });
}

describe('Radiant6CanadaEncoder — VJ session events', () => {
  it('registerOpen (1001) carries operator + transaction', () => {
    expect(enc().registerOpen({ tx: 1, operatorId: '42', operatorName: 'Joe' })).toBe(
      'EventId=1001,TerminalNumber=1,EventTime=2023-01-01T00:00:00.000,TransactionNumber=1,OperatorId=42,OperatorName=Joe\r\n',
    );
  });

  it('signOn (2010) carries the operator, shift and business date but no transaction', () => {
    expect(enc().signOn({ operatorId: '42', operatorName: 'Joe' })).toBe(
      'EventId=2010,TerminalNumber=1,EventTime=2023-01-01T00:00:00.000,OperatorId=42,OperatorName=Joe,' +
        'OperatorShiftNumber=1,BusinessDate=2023-01-01\r\n',
    );
  });

  it('basketSuspend (1003) carries only the transaction — a suspend has no totals', () => {
    expect(enc().basketSuspend({ tx: 505 })).toBe(
      'EventId=1003,TerminalNumber=1,EventTime=2023-01-01T00:00:00.000,TransactionNumber=505\r\n',
    );
  });

  it('basketResume (1004) carries the new tx plus the recalled StoredTransactionNumber', () => {
    expect(enc().basketResume({ tx: 507, storedTx: 505 })).toBe(
      'EventId=1004,TerminalNumber=1,EventTime=2023-01-01T00:00:00.000,TransactionNumber=507,StoredTransactionNumber=505\r\n',
    );
    // Recalling without naming a stored tx omits the field entirely.
    expect(enc().basketResume({ tx: 507 })).not.toContain('StoredTransactionNumber');
  });

  it('basketStarted (1009) is a Sales transaction', () => {
    const line = enc().basketStarted({ tx: 1 });
    expect(line).toContain('EventId=1009');
    expect(line).toContain('TransactionType=Sales');
  });

  it('basketEnd (1002) carries type + completion', () => {
    const line = enc().basketEnd({ tx: 1, type: 'Sales', completion: 'Completed' });
    expect(line).toContain('EventId=1002');
    expect(line).toContain('TransactionType=Sales,TransactionCompletionType=Completed');
  });
});

describe('Radiant6CanadaEncoder — item lifecycle VJ events', () => {
  it('itemAdd (1011) carries the item fields', () => {
    const line = enc().itemAdd({
      tx: 24,
      lineNumber: 1,
      barcode: '049000000443',
      description: 'Coke',
      priceCents: 169,
      quantity: 1,
    });
    expect(line).toContain('EventId=1011');
    expect(line).toContain('ItemNumber=1');
    expect(line).toContain('Barcode=049000000443');
    expect(line).toContain('Description=Coke');
    expect(line).toContain('ExtendedPrice=1.69');
    expect(line).toContain('ItemType=Regular Sales Item');
  });

  it('itemVoid (1012), priceOverride (1013), qtyChange (1014)', () => {
    expect(enc().itemVoid({ tx: 1, lineNumber: 2 })).toContain('EventId=1012,TerminalNumber=1');
    expect(enc().itemVoid({ tx: 1, lineNumber: 2 })).toContain('ItemNumber=2');
    expect(enc().priceOverride({ tx: 1, lineNumber: 2, newUnitPriceCents: 99 })).toContain('NewUnitPrice=0.99');
    const q = enc().qtyChange({ tx: 1, lineNumber: 2, oldQuantity: 1, newQuantity: 3, extendedPriceCents: 300 });
    expect(q).toContain('EventId=1014');
    expect(q).toContain('OldQuantity=1');
    expect(q).toContain('NewQuantity=3');
  });
});

describe('Radiant6CanadaEncoder — tender / change / Arrondir / loyalty', () => {
  it('tender (1007) and change (1008)', () => {
    expect(enc().tender({ tx: 77, amountCents: 1800, mopDescription: 'Cash' })).toContain('MOPDescription=Cash,Amount=18.00');
    expect(enc().change({ tx: 77, amountCents: 6 })).toContain('EventId=1008');
  });

  it('rounding (1022) uses Description=Arrondir', () => {
    expect(enc().rounding({ tx: 9, amountCents: 2 })).toMatch(/EventId=1022,.*Description=Arrondir/);
  });

  it('loyalty (1024) carries the card number (loyalty and 12-digit UPC forms)', () => {
    expect(enc().loyalty({ tx: 9, cardId: '70000000001', cardNumber: '8018782603800034999992' })).toMatch(
      /EventId=1024,.*DiscountCardId=70000000001,DiscountCardNumber=8018782603800034999992\r\n$/,
    );
    expect(enc().loyalty({ tx: 9, cardNumber: '049000000443' })).toContain('DiscountCardNumber=049000000443');
  });

  it('NEVER emits VJ EventId 1005 (subtotal) or 1020 (tax)', () => {
    const e = enc();
    const all = [
      e.registerOpen({ tx: 1, operatorId: '42', operatorName: 'Joe' }),
      e.basketStarted({ tx: 1 }),
      e.itemAdd({ tx: 1, lineNumber: 1, barcode: 'x', description: 'X', priceCents: 100, quantity: 1 }),
      e.tender({ tx: 1, amountCents: 100, mopDescription: 'Cash' }),
      e.basketEnd({ tx: 1, type: 'Sales', completion: 'Completed' }),
    ].join('');
    expect(all).not.toContain('EventId=1005');
    expect(all).not.toContain('EventId=1020');
  });
});

describe('Radiant6CanadaEncoder — VJ value escaping (legacy `,,` contract)', () => {
  it('escapes the fr decimal comma as `,,` in amount values', () => {
    const line = enc().itemAdd({
      tx: 1,
      lineNumber: 1,
      barcode: '049000000443',
      description: 'Eau',
      priceCents: 194,
      quantity: 1,
      locale: 'fr',
    });
    expect(line).toContain('UnitPrice=1,,94');
    expect(line).toContain('ExtendedPrice=1,,94');
  });

  it('escapes commas embedded in text values (legacy fixture `OperatorName=Young,, Brianna`)', () => {
    const line = enc().itemAdd({
      tx: 1,
      lineNumber: 1,
      barcode: 'x',
      description: 'CHIPS, BBQ 200G',
      priceCents: 100,
      quantity: 1,
    });
    expect(line).toContain('Description=CHIPS,, BBQ 200G');
    const op = enc().registerOpen({ tx: 1, operatorId: '42', operatorName: 'Young, Brianna' });
    expect(op).toContain('OperatorName=Young,, Brianna');
  });

  it('rounding (1022) negatives stay parenthesized (legacy fixture `Amount=(0,,02)`)', () => {
    expect(enc().rounding({ tx: 9, amountCents: -2, locale: 'fr' })).toContain('Amount=(0,,02)');
    expect(enc().rounding({ tx: 9, amountCents: -2 })).toContain('Amount=(0.02)');
  });

  it('negative ExtendedPrice / NewUnitPrice are parenthesized (player un-parenthesizes them)', () => {
    const q = enc().qtyChange({ tx: 1, lineNumber: 2, oldQuantity: 2, newQuantity: 1, extendedPriceCents: -300 });
    expect(q).toContain('ExtendedPrice=(3.00)');
    expect(enc().priceOverride({ tx: 1, lineNumber: 2, newUnitPriceCents: -99 })).toContain('NewUnitPrice=(0.99)');
  });

  it('negative tender / change Amount use a leading minus (player parses them directly)', () => {
    expect(enc().tender({ tx: 1, amountCents: -500, mopDescription: 'Cash' })).toContain('Amount=-5.00');
    expect(enc().change({ tx: 1, amountCents: -500, locale: 'fr' })).toContain('Amount=-5,,00');
  });

  it('collapses CR/LF in values to a single space (one record per wire line)', () => {
    const line = enc().itemAdd({
      tx: 1,
      lineNumber: 1,
      barcode: 'x',
      description: 'AB\nCD',
      priceCents: 100,
      quantity: 1,
    });
    expect(line).toContain('Description=AB CD');
    expect(line.endsWith('\r\n')).toBe(true);
    expect(line.indexOf('\r')).toBe(line.length - 2); // no CR/LF inside the record
  });
});

describe('Radiant6CanadaEncoder — pole display windows (20-char)', () => {
  it('en balance / change are exactly 20 chars and match the parser regexes', () => {
    const bal = enc().poleBalance(194, 'en');
    expect(bal).toBe('Balance Due    $1.94');
    expect(bal.length).toBe(20);
    const chg = enc().poleChange(6, 'en');
    expect(chg).toBe('Change Due     $0.06');
    expect(chg.length).toBe(20);
  });

  it('fr balance / change are 20 chars (after U+FFFD→space) and match the parser regexes', () => {
    const bal = enc().poleBalance(194, 'fr');
    expect(bal.length).toBe(20);
    // After the player replaces U+FFFD with a space, FR_BALANCE must match.
    expect(/Solde d.:[\x20-\x7E]{11}/.test(bal.replace(/�/g, ' '))).toBe(true);
    const chg = enc().poleChange(6, 'fr');
    expect(chg.length).toBe(20);
    expect(/Monnaie due:[\x20-\x7E]{8}/.test(chg.replace(/�/g, ' '))).toBe(true);
  });

  it('en product line matches the parser PRODUCT_LINE regex', () => {
    const item = enc().poleItem(1, 'Coke', 194, 'en');
    expect(item.length).toBe(20);
    expect(/^(\d+)\s+([\x20-\x7E]+?)\s+\$(\d+\.\d\d)$/.test(item)).toBe(true);
  });

  it('pole amounts ≥ $1,000 carry no thousands separator (none exists on the real wire)', () => {
    const fr = enc().poleBalance(123456, 'fr');
    expect(fr).not.toContain('\u00A0');
    expect(fr.length).toBe(20);
    expect(fr.endsWith('1234,56$')).toBe(true);
    const en = enc().poleBalance(123456, 'en');
    expect(en).toBe('Balance Due $1234.56');
    const item = enc().poleItem(1, 'TV', 123456, 'en');
    expect(/^(\d+)\s+([\x20-\x7E]+?)\s+\$(\d+\.\d\d)$/.test(item)).toBe(true);
  });

  it('en balance at $10,000.05 is exactly 20 chars and keeps the full amount', () => {
    const bal = enc().poleBalance(1000005, 'en');
    expect(bal).toBe('Balance Due$10000.05');
    expect(bal.length).toBe(20);
  });

  it('oversized fr change keeps the full label and tail-truncates (FR_CHANGE still matches)', () => {
    const chg = enc().poleChange(1000000, 'fr'); // `10000,00$` = 9 > field width 8
    expect(chg).toBe('Monnaie due:10000,00'); // drops only the trailing `$`
    expect(chg.length).toBe(20);
    const m = /Monnaie due:([\x20-\x7E]{8})/.exec(chg);
    expect(m?.[1]).toBe('10000,00'); // player parses the correct value
  });

  it('oversized en balance keeps the full label and tail-truncates (EN_BALANCE still matches)', () => {
    const bal = enc().poleBalance(10000005, 'en'); // `$100000.05` = 10 > field width 9
    expect(bal).toBe('Balance Due$100000.0'); // loses the last cents digit, framing holds
    expect(bal.length).toBe(20);
    expect(/Balance Due([\x20-\x7E]{9})/.test(bal)).toBe(true);
  });

  it('non-ASCII pole item text is replaced with U+FFFD (player maps it to a space, framing holds)', () => {
    const item = enc().poleItem(1, 'Café crème', 199, 'en');
    expect(item.length).toBe(20);
    expect(item).not.toContain('é');
    expect(item).not.toContain('è');
    expect(item).toContain('Caf� cr�me');
    // After the player's `chunk.replace(/�/g, ' ')`, the 20-char run matches.
    expect(/^[\x20-\x7E]{20}$/.test(item.replace(/�/g, ' '))).toBe(true);
  });

  it('fractional quantity renders as its plain decimal string (dropped by PRODUCT_LINE, like real hardware)', () => {
    const item = enc().poleItem(0.5, 'Coke', 194, 'en');
    expect(item.startsWith('0.5 Coke')).toBe(true);
    expect(item.length).toBe(20);
    expect(/^(\d+)\s+([\x20-\x7E]+?)\s+\$(\d+\.\d\d)$/.test(item)).toBe(false);
  });

  it('negative pole change uses a leading minus (the only sign the player pole path parses)', () => {
    const chg = enc().poleChange(-300, 'fr');
    expect(chg).toBe('Monnaie due:  -3,00$');
    expect(chg.length).toBe(20);
  });
});
