/**
 * Locale code for Canadian POS amount formatting.
 *   'en' → en-CA ($ prefix, period decimal, comma thousands)
 *   'fr' → fr-CA ($ suffix, comma decimal, U+00A0 thousands)
 */
export type PosLocale = 'en' | 'fr';

/** U+00A0 non-breaking space — the fr-CA thousands separator. */
const FR_THOUSANDS = ' ';

/** Group an integer-string into thousands using `sep`. */
function groupThousands(intStr: string, sep: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

export interface CentParts {
  negative: boolean;
  /** Whole dollars, no separators. */
  dollars: string;
  /** Two-digit cents fraction. */
  frac: string;
}

/**
 * Split integer cents into sign / whole dollars / two-digit fraction.
 *
 * Sign comes from the TRUNCATED value so fractional inputs in (-1, 0) are
 * plain `0.00`, never a negative zero. Non-finite input throws: every real
 * caller rounds at the boundary, so this is a fail-fast guard against
 * emitting `NaN` on the wire.
 */
export function decomposeCents(cents: number): CentParts {
  if (!Number.isFinite(cents)) {
    throw new TypeError(`decomposeCents: cents must be a finite number, got ${cents}`);
  }
  const truncated = Math.trunc(cents);
  const abs = Math.abs(truncated);
  return {
    negative: truncated < 0,
    dollars: Math.floor(abs / 100).toString(),
    frac: (abs % 100).toString().padStart(2, '0'),
  };
}

/**
 * Format integer cents as a Canadian currency DISPLAY string (UI only).
 *
 * Built directly from integer cents — never floats — so there is no rounding
 * drift. en-CA `$1.94` / `$5,000.00`, fr-CA `1,94$` / `5 000,00$`.
 * Never use this on the pole wire: see formatPoleAmount.
 */
export function formatCurrency(cents: number, locale: PosLocale): string {
  const { negative, dollars, frac } = decomposeCents(cents);
  const sign = negative ? '-' : '';

  if (locale === 'fr') {
    return `${sign}${groupThousands(dollars, FR_THOUSANDS)},${frac}$`;
  }

  return `${sign}$${groupThousands(dollars, ',')}.${frac}`;
}

/** How a negative wire amount is rendered: leading minus or parentheses. */
export type NegativeStyle = 'minus' | 'paren';

/** Bare `dollars<decimal>frac` with the locale decimal separator, no symbol. */
function bareAmount(dollars: string, frac: string, locale: PosLocale): string {
  return locale === 'fr' ? `${dollars},${frac}` : `${dollars}.${frac}`;
}

function applySign(amount: string, negative: boolean, style: NegativeStyle): string {
  if (!negative) return amount;
  return style === 'paren' ? `(${amount})` : `-${amount}`;
}

/**
 * Format integer cents as a Virtual Journal amount value (no currency symbol,
 * no thousands separator).
 *
 * `negativeStyle` is per-field because the player is asymmetric: only
 * ExtendedPrice (EventId 1011/1014/1021) and NewUnitPrice (1013) pass through
 * convertParenthesizedToSigned (omni Radiant6CanadaMessageParser.ts:384,463,
 * 478,517) before the locale parse — every other amount goes straight to
 * CurrencyManipulator.convertLocaleCurrencyToBigDecimal, which only
 * understands a leading/trailing minus (omni CurrencyManipulator.ts:32-38);
 * a parenthesized value there parses as +x.xx (en) or NaN (fr).
 */
export function formatVjAmount(
  cents: number,
  locale: PosLocale,
  negativeStyle: NegativeStyle,
): string {
  const { negative, dollars, frac } = decomposeCents(cents);
  return applySign(bareAmount(dollars, frac, locale), negative, negativeStyle);
}

/**
 * Format integer cents for the pole-display wire (currency symbol, no
 * thousands separator).
 *
 * No separators because the wire is a single-byte charset — U+00A0 cannot
 * exist there, and grouped amounts break the player's printable-ASCII window
 * regexes. Negatives use a leading minus, never parentheses: the player's
 * pole path (omni Radiant6CanadaPoleDisplayParser.ts amountToCents, ~104)
 * trims the window and hands it to
 * CurrencyManipulator.convertLocaleCurrencyToBigDecimal, whose only sign
 * handling is a leading/trailing minus (CurrencyManipulator.ts:32-38) —
 * `-$3.00` strips to -3.00 and `-3,00$` parses via the fr comma branch, while
 * `($3.00)` would sign-flip to +3.00 (en strips `[^\d.]`) and `(3,00$)` is
 * NaN on fr.
 */
export function formatPoleAmount(cents: number, locale: PosLocale): string {
  const { negative, dollars, frac } = decomposeCents(cents);
  const bare = bareAmount(dollars, frac, locale);
  const withSymbol = locale === 'fr' ? `${bare}$` : `$${bare}`;
  return applySign(withSymbol, negative, 'minus');
}
