import { describe, it, expect } from 'vitest';
import { TopazEncoder } from './TopazEncoder';

const CLOCK = (): Date => new Date(2026, 6, 16, 8, 17, 15);
const enc = new TopazEncoder({ registerId: 101, clock: CLOCK });

const HEADER = '07/16/26 08:17:15 101 ';

/** Payload = everything between the header and the trailing newline. */
function payload(frame: string): string {
  expect(frame.startsWith(HEADER)).toBe(true);
  expect(frame.endsWith('\n')).toBe(true);
  return frame.slice(HEADER.length, -1);
}

describe('TopazEncoder — VJ frames', () => {
  it('frames every line as MM/dd/yy HH:mm:ss <reg> <payload 10-40 chars>\\n', () => {
    for (const frame of [
      enc.cashier('LAKELEY'),
      enc.itemAdd({ description: 'COKE 20OZ', quantity: 1, extendedCents: 229 }),
      enc.subTotal(687),
      enc.tax(48),
      enc.total(735),
      enc.tender({ amountCents: 735 }),
      enc.voidTicket(7),
      enc.basketEnd({ storeNumber: '26', tx: 1011426 }),
      enc.loyalty('8018782603800034999992'),
    ]) {
      const body = payload(frame);
      expect(body.length).toBeGreaterThanOrEqual(10);
      expect(body.length).toBeLessThanOrEqual(40);
      expect(body).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it('cashier line reads CSH: plus exactly 17 characters', () => {
    expect(payload(enc.cashier('LAKELEY'))).toBe('CSH: LAKELEY          ');
  });

  it('amounts are decimal dollars with leading-minus negatives', () => {
    expect(payload(enc.itemVoid({ description: 'COKE 20OZ', quantity: 1, extendedCents: 229 }))).toContain('-2.29');
    expect(payload(enc.subTotal(687))).toContain('6.87');
    expect(payload(enc.subTotal(687))).not.toContain('(');
  });

  it('sanitizes # out of descriptions (fuel-regex trap) and clamps to 20 chars', () => {
    const line = payload(enc.itemAdd({ description: 'PUMP #4 SUPER LONG DESCRIPTION HERE', quantity: 1, extendedCents: 100 }));
    expect(line).not.toContain('#');
    expect(line).toContain('PUMP 4');
  });

  it('collapses fractional quantities to 1 (integer qty column)', () => {
    expect(payload(enc.itemAdd({ description: 'BANANAS', quantity: 1.38, extendedCents: 87 }))).toMatch(/\s1\s/);
  });
});

describe('TopazEncoder — pole windows', () => {
  it('emits ESC l \\x01\\x01 / \\x01\\x02 framed 20-char windows', () => {
    const total = enc.poleTotal(1129);
    expect(total.startsWith('\u001Bl\u0001\u0001')).toBe(true);
    expect(total.slice(4)).toHaveLength(20);
    expect(total.slice(4)).toBe('TOTAL          11.29');

    const change = enc.poleChange(0);
    expect(change.startsWith('\u001Bl\u0001\u0002')).toBe(true);
    expect(change.slice(4)).toBe('CHANGE          0.00');

    expect(enc.poleTender(1825).slice(4)).toBe('CASH           18.25');
  });
});
