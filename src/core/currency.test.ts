import { describe, it, expect } from 'vitest';
import { formatCurrency, formatPoleAmount } from './currency';

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

describe('formatPoleAmount (real pole wire: no separators, parenthesized negatives)', () => {
  it('en: $ prefix, period decimal, no thousands grouping', () => {
    expect(formatPoleAmount(194, 'en')).toBe('$1.94');
    expect(formatPoleAmount(123456, 'en')).toBe('$1234.56');
  });

  it('fr: $ suffix, comma decimal, never a U+00A0 separator', () => {
    expect(formatPoleAmount(1030, 'fr')).toBe('10,30$');
    expect(formatPoleAmount(123456, 'fr')).toBe('1234,56$');
    expect(formatPoleAmount(123456, 'fr')).not.toContain('\u00A0');
  });

  it('negatives are parenthesized like the register (legacy fixture `Monnaie due: (3,00$)`)', () => {
    expect(formatPoleAmount(-300, 'fr')).toBe('(3,00$)');
    expect(formatPoleAmount(-300, 'en')).toBe('($3.00)');
  });
});
