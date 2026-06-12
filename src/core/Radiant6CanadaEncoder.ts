/**
 * Radiant6CanadaEncoder — produces the exact Virtual Journal (TCP:5438) lines
 * and Pole Display (TCP:5439) 20-char windows that CK Player 2.0's
 * `radiant6-canada` plugin parses.
 *
 * Pure / browser-safe (no Node or Electron imports). Cross-checked against
 *   ../CKPlayer2.0/electron/plugins/radiant6-canada/Radiant6CanadaMessageParser.ts
 *   ../CKPlayer2.0/electron/plugins/radiant6-canada/Radiant6CanadaPoleDisplayParser.ts
 *
 * Canada policy honoured here:
 *   - Tax/balance are pole-authoritative — this encoder NEVER emits VJ
 *     EventId 1005 (subtotal) or 1020 (tax).
 *   - Cash rounding emits EventId 1022 Description=Arrondir.
 *   - EasyPay loyalty emits EventId 1024 (the 12-digit-UPC discriminator runs
 *     player-side; the encoder just carries the card number).
 *   - The pole display is bilingual; fr-CA balance uses the legacy `dû` which
 *     the player receives as U+FFFD and replaces with a space.
 */

import { formatPoleAmount, formatVjAmount, type PosLocale } from './currency';

const REPLACEMENT_CHAR = '�'; // � — legacy substitute for fr `û` in pole output

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

// VJ amounts come from formatVjAmount with a PER-FIELD negative style — the
// player only un-parenthesizes ExtendedPrice (1011/1014/1021) and NewUnitPrice
// (1013); see the formatVjAmount doc comment in currency.ts for the parser
// line numbers. Each call site below states which style its field needs.

/**
 * Replace every char outside printable ASCII with U+FFFD. The real wire is a
 * single-byte charset, so the player decodes unknown bytes as U+FFFD and maps
 * them to a space before draining (PoleDisplayParser.ts:140
 * `chunk.replace(/�/g, ' ')`) — its 20-char run regex (TWENTY_CHARS,
 * PoleDisplayParser.ts:47 `[\x20-\x7E]{20}`) then keeps framing. A raw
 * non-ASCII char here would never match that run and would misframe the
 * stream permanently.
 */
function sanitizePoleText(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, REPLACEMENT_CHAR);
}

/** Single choke point for every pole window: sanitize, then exactly 20 chars. */
function clampPoleWindow(window: string): string {
  return sanitizePoleText(window).padEnd(20, ' ').slice(0, 20);
}

/**
 * Build a fixed-width pole window: label left-justified, amount right-justified.
 * Always exactly 20 chars — the player drains the stream in strict 20-char
 * runs, so one oversized window would misframe every window after it.
 */
function poleWindow(label: string, fieldWidth: number, amount: string): string {
  const window = label + amount.padStart(fieldWidth, ' ');
  if (window.length <= 20) return clampPoleWindow(window);
  // Overflow: the player's window regexes anchor on the FULL literal label
  // (FR_CHANGE PoleDisplayParser.ts:69, EN_BALANCE :50), so trimming the
  // label silently drops the window. Keep the label and tail-truncate to 20:
  // fr loses only the trailing `$` (the capture still reads the value); en
  // can lose the last cents digit — degraded but still parseable, and
  // realistic amounts never overflow.
  return clampPoleWindow(label + amount);
}

type Field = [key: string, value: string | number];

export class Radiant6CanadaEncoder {
  private readonly terminalNumber: number;
  private readonly clock: () => Date;

  constructor(options: EncoderOptions) {
    this.terminalNumber = options.terminalNumber;
    this.clock = options.clock ?? ((): Date => new Date());
  }

  // ---- Virtual Journal -----------------------------------------------------

  /** Assemble one `EventId=..,TerminalNumber=..,EventTime=..,<fields>\r\n` line. */
  private eventLine(eventId: number, fields: Field[]): string {
    const parts: Field[] = [
      ['EventId', eventId],
      ['TerminalNumber', this.terminalNumber],
      ['EventTime', formatEventTime(this.clock())],
      ...fields,
    ];
    // The register escapes commas embedded in values as `,,` (fr decimals,
    // names, descriptions); the player's parseKeyValues masks `,,` before
    // splitting on `,` and restores it after. Line framing is the wire
    // contract: CR/LF cannot appear inside a record, so collapse to a space.
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

  basketStarted(args: { tx: number }): string {
    return this.eventLine(1009, [
      ['TransactionNumber', args.tx],
      ['TransactionType', 'Sales'],
    ]);
  }

  basketEnd(args: {
    tx: number;
    type: 'Sales' | 'Refund' | 'Cancelled';
    completion: 'Completed' | 'Cancelled';
  }): string {
    return this.eventLine(1002, [
      ['TransactionNumber', args.tx],
      ['TransactionType', args.type],
      ['TransactionCompletionType', args.completion],
    ]);
  }

  itemAdd(args: {
    tx: number;
    lineNumber: number;
    barcode: string;
    description: string;
    priceCents: number;
    quantity: number;
    locale?: PosLocale;
  }): string {
    const locale = args.locale ?? 'en';
    // ExtendedPrice is un-parenthesized by the player (parser:384) → paren.
    // UnitPrice is never read by the player's 1011 handler; minus keeps it on
    // the convertLocaleCurrencyToBigDecimal-parseable path if that changes.
    const extended = formatVjAmount(Math.round(args.priceCents * args.quantity), locale, 'paren');
    return this.eventLine(1011, [
      ['TransactionNumber', args.tx],
      ['ItemNumber', args.lineNumber],
      ['Barcode', args.barcode],
      ['ItemType', 'Regular Sales Item'],
      ['Description', args.description],
      ['UnitPrice', formatVjAmount(args.priceCents, locale, 'minus')],
      ['ExtendedPrice', extended],
      // Period-decimal Quantity on a comma-decimal fr line is an
      // uncorroborated assumption pending a real fr register capture; the
      // only legacy evidence is the en-only legacy emulator's BigDecimal
      // toString (Radiant6RegisterEmulator.java).
      ['Quantity', args.quantity.toFixed(3)],
      ['AgeMinimum', 0],
    ]);
  }

  itemVoid(args: { tx: number; lineNumber: number }): string {
    return this.eventLine(1012, [
      ['TransactionNumber', args.tx],
      ['ItemNumber', args.lineNumber],
    ]);
  }

  priceOverride(args: { tx: number; lineNumber: number; newUnitPriceCents: number; locale?: PosLocale }): string {
    return this.eventLine(1013, [
      ['TransactionNumber', args.tx],
      ['ItemNumber', args.lineNumber],
      // Un-parenthesized by the player (parser:463) → paren.
      ['NewUnitPrice', formatVjAmount(args.newUnitPriceCents, args.locale ?? 'en', 'paren')],
    ]);
  }

  qtyChange(args: {
    tx: number;
    lineNumber: number;
    oldQuantity: number;
    newQuantity: number;
    extendedPriceCents: number;
    locale?: PosLocale;
  }): string {
    return this.eventLine(1014, [
      ['TransactionNumber', args.tx],
      ['ItemNumber', args.lineNumber],
      ['OldQuantity', args.oldQuantity.toFixed(3)],
      ['NewQuantity', args.newQuantity.toFixed(3)],
      // Un-parenthesized by the player (parser:478) → paren.
      ['ExtendedPrice', formatVjAmount(args.extendedPriceCents, args.locale ?? 'en', 'paren')],
    ]);
  }

  tender(args: { tx: number; amountCents: number; mopDescription: string; mopId?: number; locale?: PosLocale }): string {
    return this.eventLine(1007, [
      ['TransactionNumber', args.tx],
      ['MOPId', args.mopId ?? 5],
      ['MOPDescription', args.mopDescription],
      // Parsed directly by convertLocaleCurrencyToBigDecimal (parser:275,289),
      // which never sees convertParenthesizedToSigned → minus.
      ['Amount', formatVjAmount(args.amountCents, args.locale ?? 'en', 'minus')],
    ]);
  }

  change(args: { tx: number; amountCents: number; mopDescription?: string; locale?: PosLocale }): string {
    return this.eventLine(1008, [
      ['TransactionNumber', args.tx],
      ['MOPId', 5],
      ['MOPDescription', args.mopDescription ?? 'Cash'],
      // Parsed directly by convertLocaleCurrencyToBigDecimal (parser:309) → minus.
      ['Amount', formatVjAmount(args.amountCents, args.locale ?? 'en', 'minus')],
    ]);
  }

  /** EventId 1022 — CAD cash rounding. The player ignores Arrondir/Rounding. */
  rounding(args: { tx: number; amountCents: number; description?: 'Arrondir' | 'Rounding'; locale?: PosLocale }): string {
    return this.eventLine(1022, [
      ['TransactionNumber', args.tx],
      ['Description', args.description ?? 'Arrondir'],
      // The player never reads this Amount (Arrondir/Rounding early-return,
      // parser:546); paren is what the real register emits per the legacy
      // fixture `Amount=(0,,02)` (Radiant6CanadaVirtualJournalTest.java:32).
      ['Amount', formatVjAmount(args.amountCents, args.locale ?? 'en', 'paren')],
    ]);
  }

  /** EventId 1024 — EasyPay / loyalty. cardNumber may be a loyalty id or a 12-digit UPC. */
  loyalty(args: { tx: number; cardId?: string; cardNumber: string }): string {
    return this.eventLine(1024, [
      ['TransactionNumber', args.tx],
      ['DiscountCardId', args.cardId ?? '70000000001'],
      ['DiscountCardNumber', args.cardNumber],
    ]);
  }

  // ---- Pole display (20-char printable windows) ----------------------------

  /** Running balance (incl. tax). en: `Balance Due` + 9; fr: `Solde d�:` + 11. */
  poleBalance(cents: number, locale: PosLocale): string {
    if (locale === 'fr') {
      return poleWindow(`Solde d${REPLACEMENT_CHAR}:`, 11, formatPoleAmount(cents, 'fr'));
    }
    return poleWindow('Balance Due', 9, formatPoleAmount(cents, 'en'));
  }

  /** Change due. en: `Change Due` + 10; fr: `Monnaie due:` + 8. */
  poleChange(cents: number, locale: PosLocale): string {
    if (locale === 'fr') {
      return poleWindow('Monnaie due:', 8, formatPoleAmount(cents, 'fr'));
    }
    return poleWindow('Change Due', 10, formatPoleAmount(cents, 'en'));
  }

  /**
   * Item line. The player's product regex only matches en (`$#.##`, period
   * decimal); fr item lines are produced for realism but drop at the parser
   * (documented limitation) — balance/change still carry fr amounts.
   */
  poleItem(quantity: number, description: string, priceCents: number, locale: PosLocale): string {
    // Plain decimal string matches the legacy register's BigDecimal
    // toPlainString() (Radiant6RegisterEmulator.java:99). Fractional-qty
    // windows fail the player's PRODUCT_LINE `^(\d+)` anchor and are
    // dropped — same as real hardware, which is the point.
    const qty = String(quantity);
    const price = formatPoleAmount(priceCents, locale);
    const prefix = `${qty} ${description}`;
    const gap = Math.max(1, 20 - prefix.length - price.length);
    const raw = prefix + ' '.repeat(gap) + price;
    const overflow = raw.length - 20;
    // Trim the description first so the whole window fits 20 chars.
    const window =
      overflow <= 0
        ? raw
        : `${qty} ${description.slice(0, Math.max(0, description.length - overflow))} ${price}`;
    // Last resort: with the description fully trimmed and qty+price still
    // ≥ 19 chars, the clamp cuts the price tail — that window is unparseable,
    // but the 20-char stream framing survives.
    return clampPoleWindow(window);
  }
}
