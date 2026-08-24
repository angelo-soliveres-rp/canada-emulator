/**
 * Radiant6USEncoder — produces the exact US Radiant6 Virtual Journal (TCP:5438)
 * lines that CK Player 2.0's `radiant6` (US) plugin parses.
 *
 * Pure / browser-safe (no Node or Electron imports). Cross-checked against
 *   ../omni/electron/plugins/radiant6/Radiant6MessageParser.ts
 * and the legacy Radiant6VirtualJournal.java (release/8.2.8.0).
 *
 * US policy honoured here (the inverse of Canada on every point):
 *   - The VJ is AUTHORITATIVE for subtotal/tax — EventId 1005 and 1020 are
 *     emitted (Canada never emits them; its pole display owns totals).
 *   - No pole display exists, so this encoder has no pole methods.
 *   - No cash rounding — cents-exact; EventId 1022 is never emitted as
 *     "Arrondir"/"Rounding" (the US parser would decode it as a discount void).
 *   - Amounts are plain decimal DOLLARS ("6.87"), negative = leading minus.
 *     The US parser reads every amount via parseFloat (tryParseDecimal) —
 *     a parenthesized or locale-formatted value would parse as NaN and drop.
 *   - 1012 item void carries Barcode (US-only field); 1002 basket end carries
 *     SubtotalAmount/TaxAmount/TotalAmount (US populates, Canada disables).
 *   - 1020 Amount and 1014 OldQuantity/NewQuantity are ALWAYS present — the
 *     legacy player NPEs without them, so their absence is a wire violation
 *     even if the modern parser tolerates it.
 *   - Monolingual en-US: no locale parameter anywhere.
 */

import { formatVjAmount } from './currency';

export interface EncoderOptions {
  terminalNumber: number;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  clock?: () => Date;
}

/** Format a Date as Radiant6 wire EventTime: `yyyy-MM-ddTHH:mm:ss.SSS` (local). */
function formatEventTime(d: Date): string {
  const p = (n: number, len = 2): string => n.toString().padStart(len, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * US decimal-dollar amount ("6.87", "-2.29"). Reuses the en/minus branch of
 * formatVjAmount: period decimal, no symbol, no separators, leading minus —
 * exactly what the US parser's parseFloat path accepts.
 */
function usAmount(cents: number): string {
  return formatVjAmount(cents, 'en', 'minus');
}

type Field = [key: string, value: string | number];

export class Radiant6USEncoder {
  private readonly terminalNumber: number;
  private readonly clock: () => Date;

  constructor(options: EncoderOptions) {
    this.terminalNumber = options.terminalNumber;
    this.clock = options.clock ?? ((): Date => new Date());
  }

  /** Assemble one `EventId=..,TerminalNumber=..,EventTime=..,<fields>\r\n` line. */
  private eventLine(eventId: number, fields: Field[]): string {
    const parts: Field[] = [
      ['EventId', eventId],
      ['TerminalNumber', this.terminalNumber],
      ['EventTime', formatEventTime(this.clock())],
      ...fields,
    ];
    // The register escapes commas embedded in values as `,,` (descriptions,
    // names); the player's parseKeyValues masks `,,` before splitting on `,`
    // and restores it after. Line framing is the wire contract: CR/LF cannot
    // appear inside a record, so collapse to a space.
    return (
      parts
        .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ').replace(/,/g, ',,')}`)
        .join(',') + '\r\n'
    );
  }

  registerOpen(args: { tx: number; operatorId: string; operatorName: string }): string {
    return this.eventLine(1001, [
      ['TransactionNumber', args.tx],
      ['OperatorId', args.operatorId],
      ['OperatorName', args.operatorName],
    ]);
  }

  /**
   * EventId 2010 — cashier sign-on. Carries no TransactionNumber: it happens
   * between baskets, and real captures open with it before the first 1001
   * (liftck_player dev/playbackFiles GREAT_LAKES.xml:1, marlboro/ckhl-6716-1.xml:1).
   *
   * The player has no 2010 branch — both the legacy VJ (Radiant6VirtualJournal.java:157-163)
   * and CK Player 2.0 (Radiant6MessageParser.ts:203) raise CASHIER_RECOGNIZED from any
   * line carrying OperatorId/OperatorName *before* the EventId switch, then let this one
   * fall through unhandled. So 2010 is chosen for wire realism, not because it is routed.
   */
  signOn(args: { operatorId: string; operatorName: string; shift?: number }): string {
    return this.eventLine(2010, [
      ['OperatorId', args.operatorId],
      ['OperatorName', args.operatorName],
      ['OperatorShiftNumber', args.shift ?? 1],
      // Same calendar day as EventTime, which is already local-formatted.
      ['BusinessDate', formatEventTime(this.clock()).slice(0, 10)],
    ]);
  }

  basketStarted(args: { tx: number }): string {
    return this.eventLine(1009, [
      ['TransactionNumber', args.tx],
      ['TransactionType', 'Sales'],
    ]);
  }

  /**
   * EventId 1002 — basket end. On a completed US sale the register reports the
   * final SubtotalAmount/TaxAmount/TotalAmount here (parser reads all three);
   * a cancelled ticket carries none.
   */
  basketEnd(args: {
    tx: number;
    type: 'Sales' | 'Refund';
    completion: 'Completed' | 'Cancelled';
    subtotalCents?: number;
    taxCents?: number;
    totalCents?: number;
  }): string {
    const amounts: Field[] =
      args.completion === 'Completed' &&
      args.subtotalCents !== undefined &&
      args.taxCents !== undefined &&
      args.totalCents !== undefined
        ? [
            ['SubtotalAmount', usAmount(args.subtotalCents)],
            ['TaxAmount', usAmount(args.taxCents)],
            ['TotalAmount', usAmount(args.totalCents)],
          ]
        : [];
    return this.eventLine(1002, [
      ['TransactionNumber', args.tx],
      ['TransactionType', args.type],
      ['TransactionCompletionType', args.completion],
      ...amounts,
    ]);
  }

  itemAdd(args: {
    tx: number;
    lineNumber: number;
    barcode: string;
    description: string;
    priceCents: number;
    quantity: number;
  }): string {
    return this.eventLine(1011, [
      ['TransactionNumber', args.tx],
      ['ItemNumber', args.lineNumber],
      ['Barcode', args.barcode],
      ['ItemType', 'Regular Sales Item'],
      ['Description', args.description],
      ['UnitPrice', usAmount(args.priceCents)],
      // The parser takes the item price from ExtendedPrice, not UnitPrice.
      ['ExtendedPrice', usAmount(Math.round(args.priceCents * args.quantity))],
      ['Quantity', args.quantity.toFixed(3)],
      ['AgeMinimum', 0],
    ]);
  }

  /** EventId 1012 — item void. US includes the voided line's Barcode. */
  itemVoid(args: { tx: number; lineNumber: number; barcode: string }): string {
    return this.eventLine(1012, [
      ['TransactionNumber', args.tx],
      ['ItemNumber', args.lineNumber],
      ['Barcode', args.barcode],
    ]);
  }

  priceOverride(args: { tx: number; lineNumber: number; newUnitPriceCents: number }): string {
    return this.eventLine(1013, [
      ['TransactionNumber', args.tx],
      ['ItemNumber', args.lineNumber],
      ['NewUnitPrice', usAmount(args.newUnitPriceCents)],
    ]);
  }

  /** EventId 1014 — qty change. Old/NewQuantity are hard-required by the player. */
  qtyChange(args: {
    tx: number;
    lineNumber: number;
    oldQuantity: number;
    newQuantity: number;
    extendedPriceCents: number;
  }): string {
    return this.eventLine(1014, [
      ['TransactionNumber', args.tx],
      ['ItemNumber', args.lineNumber],
      ['OldQuantity', args.oldQuantity.toFixed(3)],
      ['NewQuantity', args.newQuantity.toFixed(3)],
      ['ExtendedPrice', usAmount(args.extendedPriceCents)],
    ]);
  }

  /** EventId 1005 — subtotal. US-only: the VJ is authoritative (no pole display). */
  subtotal(args: { tx: number; amountCents: number }): string {
    return this.eventLine(1005, [
      ['TransactionNumber', args.tx],
      ['Amount', usAmount(args.amountCents)],
    ]);
  }

  /** EventId 1020 — tax. US-only; Amount is always present (player NPEs without it). */
  tax(args: { tx: number; amountCents: number }): string {
    return this.eventLine(1020, [
      ['TransactionNumber', args.tx],
      ['Amount', usAmount(args.amountCents)],
    ]);
  }

  tender(args: { tx: number; amountCents: number; mopDescription: string; mopId?: number }): string {
    return this.eventLine(1007, [
      ['TransactionNumber', args.tx],
      ['MOPId', args.mopId ?? 5],
      ['MOPDescription', args.mopDescription],
      ['Amount', usAmount(args.amountCents)],
    ]);
  }

  change(args: { tx: number; amountCents: number; mopDescription?: string }): string {
    return this.eventLine(1008, [
      ['TransactionNumber', args.tx],
      ['MOPId', 5],
      ['MOPDescription', args.mopDescription ?? 'Cash'],
      ['Amount', usAmount(args.amountCents)],
    ]);
  }

  /**
   * EventId 1024 — EasyPay / loyalty. The player discriminates cardNumber:
   * exactly 12 digits → UPC-as-coupon (LIFTBAU-565); inside the fuel-card BIN
   * range (string compare, default 782603797000000000..782603798999999999) →
   * ignored; anything else → loyalty sign-in.
   */
  loyalty(args: { tx: number; cardId?: string; cardNumber: string }): string {
    return this.eventLine(1024, [
      ['TransactionNumber', args.tx],
      ['DiscountCardId', args.cardId ?? '70000000001'],
      ['DiscountCardNumber', args.cardNumber],
    ]);
  }
}
