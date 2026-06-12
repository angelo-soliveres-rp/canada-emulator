import { describe, it, expect } from 'vitest';
import { decomposeCents, formatCurrency, formatPoleAmount, formatVjAmount } from './currency';

describe('formatCurrency', () => {
  it('en-CA: $ prefix, period decimal', () => {
    expect(formatCurrency(194, 'en')).toBe('$1.94');
    expect(formatCurrency(0, 'en')).toBe('$0.00');
    expect(formatCurrency(6, 'en')).toBe('$0.06');
    expect(formatCurrency(500000, 'en')).toBe('$5,000.00');
  });

  it('fr-CA: $ suffix, comma decimal, U+00A0 thousands separator', () => {
    expect(formatCurrency(194, 'fr')).toBe('1,94$');
    expect(formatCurrency(1030, 'fr')).toBe('10,30$');
    expect(formatCurrency(500000, 'fr')).toBe('5 000,00$');
  });

  it('handles negative amounts', () => {
    expect(formatCurrency(-194, 'en')).toBe('-$1.94');
    expect(formatCurrency(-194, 'fr')).toBe('-1,94$');
  });
});

describe('decomposeCents', () => {
  it('derives the sign from the truncated value (no negative zero)', () => {
    expect(decomposeCents(-0.5)).toEqual({ negative: false, dollars: '0', frac: '00' });
    expect(decomposeCents(-1)).toEqual({ negative: true, dollars: '0', frac: '01' });
  });

  it('throws a TypeError on non-finite cents (fail-fast, nothing hits the wire)', () => {
    expect(() => decomposeCents(NaN)).toThrow(TypeError);
    expect(() => decomposeCents(Infinity)).toThrow(TypeError);
  });
});

describe('formatPoleAmount (real pole wire: no separators, minus-sign negatives)', () => {
  it('en: $ prefix, period decimal, no thousands grouping', () => {
    expect(formatPoleAmount(194, 'en')).toBe('$1.94');
    expect(formatPoleAmount(123456, 'en')).toBe('$1234.56');
  });

  it('fr: $ suffix, comma decimal, never a U+00A0 separator', () => {
    expect(formatPoleAmount(1030, 'fr')).toBe('10,30$');
    expect(formatPoleAmount(123456, 'fr')).toBe('1234,56$');
    expect(formatPoleAmount(123456, 'fr')).not.toContain('\u00A0');
  });

  it('negatives carry a leading minus — the only sign the player pole path parses', () => {
    expect(formatPoleAmount(-300, 'fr')).toBe('-3,00$');
    expect(formatPoleAmount(-300, 'en')).toBe('-$3.00');
  });
});

describe('formatVjAmount (VJ wire: no symbol, per-field negative style)', () => {
  it('positive amounts are bare locale decimals', () => {
    expect(formatVjAmount(194, 'en', 'minus')).toBe('1.94');
    expect(formatVjAmount(194, 'fr', 'paren')).toBe('1,94');
  });

  it("'minus' style for fields the player parses directly (tender/change Amount)", () => {
    expect(formatVjAmount(-500, 'en', 'minus')).toBe('-5.00');
    expect(formatVjAmount(-500, 'fr', 'minus')).toBe('-5,00');
  });

  it("'paren' style for fields the player un-parenthesizes (ExtendedPrice, NewUnitPrice)", () => {
    expect(formatVjAmount(-2, 'en', 'paren')).toBe('(0.02)');
    expect(formatVjAmount(-2, 'fr', 'paren')).toBe('(0,02)');
  });
});
