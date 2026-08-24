/**
 * TopazEncoder — produces the Verifone Topaz virtual-journal frames and pole
 * display windows that CK Player 2.0's `verifone` plugin parses.
 *
 * Pure / browser-safe (no Node or Electron imports). Cross-checked against
 *   ../omni/electron/plugins/verifone/TopazMessageParser.ts
 *   ../omni/electron/plugins/verifone/TopazPoleDisplayParser.ts (+ types.ts)
 * and legacy Topaz{VirtualJournal,PoleDisplay}.java (release/8.2.8.0).
 *
 * Wire shape (both directions serial on real hardware; the player accepts any
 * IODeviceFactory transport, so the emulator drives it over TCP):
 *
 *   VJ frame:   `MM/dd/yy HH:mm:ss <registerId> <payload{10,40}>\n`
 *               plaintext columns, decimal-dollar amounts. The player finds
 *               the header anywhere in the stream, so framing is forgiving —
 *               but a payload outside 10..40 chars never matches, so every
 *               payload is padded/clamped here.
 *   Pole frame: `ESC l \x01\x01 <20 printable chars>` (line 1)
 *               `ESC l \x01\x02 <20 printable chars>` (line 2)
 *
 * US invariants (Verifone is a US family): decimal dollars, leading-minus
 * negatives, monolingual en-US, no cash rounding, pole present but
 * NON-authoritative (the VJ owns items/subtotal/tax).
 *
 * Parser quirks encoded against (all legacy-preserved in the player):
 *   - `\s+Total` substring-matches "Sub Total", and the TOTAL branch runs
 *     first — a Sub Total line therefore decodes as BASKET_TOTAL. Real
 *     registers emit it anyway; we mirror them, not the parser's folklore.
 *   - The item regex caps descriptions at 20 printable chars with an integer
 *     1-4 digit quantity column; fractional quantities collapse to 1 with the
 *     extended amount carrying the value.
 *   - `#` inside a description would trip the fuel regex — sanitized out.
 *   - The VJ cascade has no CHANGE branch; change is pole-display-only.
 */

import { formatVjAmount } from './currency';

const ESC = '\u001B';
const POLE_LINE1_PREFIX = `${ESC}l\u0001\u0001`;
const POLE_LINE2_PREFIX = `${ESC}l\u0001\u0002`;

export interface TopazEncoderOptions {
  /** Register id stamped in every VJ frame header (fixtures use e.g. 101). */
  registerId: number;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  clock?: () => Date;
}

/** Decimal-dollar amount ("6.87", "-2.29") — parseFloat-safe for the player. */
function usAmount(cents: number): string {
  return formatVjAmount(cents, 'en', 'minus');
}

/** `MM/dd/yy HH:mm:ss` header timestamp. */
function formatHeaderTime(d: Date): string {
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${p(d.getFullYear() % 100)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Sanitize a description for the Topaz plaintext columns: printable ASCII
 * only, `#` stripped (fuel-regex trap), CR/LF collapsed, trimmed to the
 * 20-char item-column cap and padded to the 5-char regex minimum.
 */
function sanitizeDescription(description: string): string {
  const clean = description
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/#/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return clean.padEnd(5, ' ');
}

/**
 * The item quantity column is a 1-4 digit integer. Fractional quantities
 * (weighed items) collapse to 1 — the extended amount still carries the value.
 */
function quantityColumn(quantity: number): string {
  const qty = Number.isInteger(quantity) && quantity > 0 && quantity <= 9999 ? quantity : 1;
  return qty.toString();
}

export class TopazEncoder {
  private readonly registerId: number;
  private readonly clock: () => Date;

  constructor(options: TopazEncoderOptions) {
    this.registerId = options.registerId;
    this.clock = options.clock ?? ((): Date => new Date());
  }

  // ---- Virtual journal (plaintext frames) -----------------------------------

  /**
   * Wrap a payload in the Topaz header. The player's line regex requires a
   * 10-40 char payload — pad short ones and hard-clamp long ones so a frame
   * can never desync the stream.
   */
  private frame(payload: string): string {
    const body = payload.replace(/[\r\n]+/g, ' ').padEnd(10, ' ').slice(0, 40);
    return `${formatHeaderTime(this.clock())} ${this.registerId} ${body}\n`;
  }

  /**
   * Age-verification journal line. Two real forms exist (fixtures
   * liftck_player dev/playbackFiles marlboro/ckgc-2702524-3.xml:5 and
   * marlboro/Ruby/ckhl-1683-1.xml:5):
   *   ID CHECK SKIPPED
   *   CUSTOMER ID VERIFIED  11/22/33
   *
   * The player recognizes both only to DISCARD them (TopazMessageParser.ts:287
   * returns []). That swallow is the point: the line's shape could otherwise
   * match the item-add regex and be rung up as a phantom item, so emitting it
   * is how you prove the player still throws it away.
   */
  idCheck(args: { verified: boolean; dob?: string }): string {
    if (!args.verified) return this.frame('ID CHECK SKIPPED');
    return this.frame(`CUSTOMER ID VERIFIED  ${args.dob ?? '11/22/33'}`);
  }

  /** `CSH: <name>` — cashier recognition. The player reads exactly 17 chars. */
  cashier(name: string): string {
    const clean = name.replace(/[^\x20-\x7E]/g, ' ').slice(0, 17);
    return this.frame(`CSH: ${clean.padEnd(17, ' ')}`);
  }

  /**
   * Item add line: `  <desc padded to 20> <qty> <extended>` (extended dollars).
   * The explicit space between the description and quantity fields is
   * load-bearing: a 20-char description with a 3-4 digit quantity would
   * otherwise abut with no whitespace, and the player's item regex (which
   * requires `\s+` between the columns) would drop the line entirely.
   *
   * Known parser-parity quirk (NOT worked around here): the player's
   * positive-void rescue treats `\s+V…` as a void marker, so a description
   * starting with "V" (V8, VELVEETA…) loses its leading letter in the
   * player's basket — identical to real hardware against the legacy Java
   * (TopazVirtualJournal.java 426-461, ported verbatim). Pinned by a
   * round-trip test; a faithful wire beats a mangled description.
   */
  itemAdd(args: { description: string; quantity: number; extendedCents: number }): string {
    const desc = sanitizeDescription(args.description);
    const qty = quantityColumn(args.quantity);
    const amount = usAmount(args.extendedCents);
    return this.frame(`  ${desc.padEnd(20, ' ')} ${qty.padStart(3, ' ')}  ${amount.padStart(8, ' ')}`);
  }

  /** Item void line: `  V <desc> <qty> -<extended>` (explicit V marker). */
  itemVoid(args: { description: string; quantity: number; extendedCents: number }): string {
    const desc = sanitizeDescription(args.description);
    const qty = quantityColumn(args.quantity);
    const amount = usAmount(-Math.abs(args.extendedCents));
    return this.frame(`  V ${desc.padEnd(20, ' ')} ${qty.padStart(3, ' ')}  ${amount.padStart(8, ' ')}`);
  }

  /** `Sub Total <amt>` — decodes as BASKET_TOTAL per the preserved shadow quirk. */
  subTotal(amountCents: number): string {
    return this.frame(`             Sub Total${usAmount(amountCents).padStart(14, ' ')}`);
  }

  /** `TAX <amt>`. */
  tax(amountCents: number): string {
    return this.frame(`                   TAX${usAmount(amountCents).padStart(14, ' ')}`);
  }

  /** `TOTAL <amt>`. */
  total(amountCents: number): string {
    return this.frame(`                 TOTAL${usAmount(amountCents).padStart(14, ' ')}`);
  }

  /** Tender line, e.g. `CASH <amt>`. */
  tender(args: { mop?: 'CASH' | 'CREDIT' | 'DEBIT'; amountCents: number }): string {
    const mop = args.mop ?? 'CASH';
    return this.frame(`${mop.padStart(22, ' ')}${usAmount(args.amountCents).padStart(14, ' ')}`);
  }

  /** `VOID TICKET <tx>` — whole-ticket void (decodes as BASKET_VOIDED). */
  voidTicket(tx: number): string {
    return this.frame(`VOID TICKET ${tx}`);
  }

  /** `ST# <store> DR# <drawer> TRAN# <tx>` — end of basket (receiptNum = TRAN#). */
  basketEnd(args: { storeNumber: string; drawer?: number; tx: number }): string {
    return this.frame(`ST# ${args.storeNumber} DR# ${args.drawer ?? 1} TRAN# ${args.tx}`);
  }

  /**
   * `LOYALTY <digits>` — the player routes exactly-10-digit numbers to
   * LOYALTY_MOBILE_SIGNIN (phone) and everything else to LOYALTY_SWIPE.
   */
  loyalty(cardNumber: string): string {
    return this.frame(`  LOYALTY ${cardNumber}`);
  }

  // ---- Pole display (ESC-framed 20-char windows) ----------------------------

  /** One pole window: prefix + exactly 20 printable chars. */
  private poleWindow(prefix: string, text: string): string {
    const body = text.replace(/[^\x20-\x7E]/g, ' ').padEnd(20, ' ').slice(0, 20);
    return `${prefix}${body}`;
  }

  /** Label left, dollar amount right, 20 chars. */
  private poleAmountLine(label: string, cents: number): string {
    const amount = usAmount(cents);
    return `${label}${amount.padStart(20 - label.length, ' ')}`;
  }

  /** `TOTAL <amt>` on pole line 1. */
  poleTotal(cents: number): string {
    return this.poleWindow(POLE_LINE1_PREFIX, this.poleAmountLine('TOTAL', cents));
  }

  /** `CASH <amt>` on pole line 1 (tender echo). */
  poleTender(cents: number, mop: 'CASH' | 'CHECK' | 'DEBIT' | 'CREDIT' = 'CASH'): string {
    return this.poleWindow(POLE_LINE1_PREFIX, this.poleAmountLine(mop, cents));
  }

  /** `CHANGE <amt>` on pole line 2 — the only place change appears on the wire. */
  poleChange(cents: number): string {
    return this.poleWindow(POLE_LINE2_PREFIX, this.poleAmountLine('CHANGE', cents));
  }

  /**
   * Item echo on pole line 1. The player deliberately ignores generic pole
   * item lines (VJ-authoritative since 1/2/18) — emitted for realism only.
   * `#` is sanitized out so the line can't trip the pole fuel regex.
   */
  poleItem(description: string, cents: number): string {
    const amount = usAmount(cents);
    const desc = sanitizeDescription(description).slice(0, Math.max(1, 19 - amount.length));
    return this.poleWindow(POLE_LINE1_PREFIX, `${desc}${amount.padStart(20 - desc.length, ' ')}`);
  }
}
