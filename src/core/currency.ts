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

/** Split integer cents into sign / whole dollars / two-digit fraction. */
export function decomposeCents(cents: number): CentParts {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return {
    negative,
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

/**
 * Format integer cents for the pole-display wire.
 *
 * The real register never emits thousands separators on the pole (the wire is
 * a single-byte charset — U+00A0 cannot exist there, and grouped amounts break
 * the player's printable-ASCII window regexes), and negatives are
 * parenthesized per the legacy capture `Monnaie due: (3,00$)`.
 */
export function formatPoleAmount(cents: number, locale: PosLocale): string {
  const { negative, dollars, frac } = decomposeCents(cents);
  const bare = locale === 'fr' ? `${dollars},${frac}$` : `$${dollars}.${frac}`;
  return negative ? `(${bare})` : bare;
}
