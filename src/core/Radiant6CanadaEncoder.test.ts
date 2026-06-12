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

  it('emits negative amounts parenthesized (legacy fixture `Amount=(0,,02)`)', () => {
    expect(enc().rounding({ tx: 9, amountCents: -2, locale: 'fr' })).toContain('Amount=(0,,02)');
    expect(enc().rounding({ tx: 9, amountCents: -2 })).toContain('Amount=(0.02)');
  });

  it('survives the player parseKeyValues algorithm (mask `,,` → split `,` → restore)', () => {
    const line = enc().itemAdd({
      tx: 1,
      lineNumber: 1,
      barcode: 'x',
      description: 'CHIPS, BBQ 200G',
      priceCents: 194,
      quantity: 1,
      locale: 'fr',
    });
    const SENTINEL = '\u0001';
    const masked = line.trim().replace(/,,/g, SENTINEL);
    const parsed = new Map<string, string>();
    for (const piece of masked.split(',')) {
      const restored = piece.split(SENTINEL).join(',');
      const eq = restored.indexOf('=');
      if (eq <= 0) continue;
      parsed.set(restored.slice(0, eq), restored.slice(eq + 1));
    }
    expect(parsed.get('Description')).toBe('CHIPS, BBQ 200G');
    expect(parsed.get('UnitPrice')).toBe('1,94');
    expect(parsed.get('ExtendedPrice')).toBe('1,94');
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

  it('oversized amounts trim the label, never the amount, and never exceed 20 chars', () => {
    const chg = enc().poleChange(1000000, 'fr'); // `10000,00$` = 9 > field width 8
    expect(chg.length).toBe(20);
    expect(chg.endsWith('10000,00$')).toBe(true);
  });

  it('negative pole change is parenthesized (legacy fixture `Monnaie due: (3,00$)`)', () => {
    const chg = enc().poleChange(-300, 'fr');
    expect(chg).toBe('Monnaie due: (3,00$)');
    expect(chg.length).toBe(20);
  });
});
