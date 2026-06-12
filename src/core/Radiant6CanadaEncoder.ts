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

import { decomposeCents, formatPoleAmount, type PosLocale } from './currency';

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

/**
 * Plain numeric wire amount (no currency symbol, no thousands separator).
 * Negatives are parenthesized like the real register: `Amount=(0,02)`, which
 * eventLine's comma-escaping turns into the legacy fixture form `(0,,02)`.
 */
function wireAmount(cents: number, locale: PosLocale): string {
  const { negative, dollars, frac } = decomposeCents(cents);
  const decimal = locale === 'fr' ? ',' : '.';
  const bare = `${dollars}${decimal}${frac}`;
  return negative ? `(${bare})` : bare;
}

/**
 * Build a fixed-width pole window: label left-justified, amount right-justified.
 * Always at most 20 chars — the player drains the stream in strict 20-char
 * runs, so one oversized window would misframe every window after it. An
 * amount wider than its field trims the label, never the amount.
 */
function poleWindow(label: string, fieldWidth: number, amount: string): string {
  const window = label + amount.padStart(fieldWidth, ' ');
  if (window.length <= 20) return window;
  return (label.slice(0, Math.max(0, 20 - amount.length)) + amount).slice(0, 20);
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
    // splitting on `,` and restores it after.
    return parts.map(([k, v]) => `${k}=${String(v).replace(/,/g, ',,')}`).join(',') + '\r\n';
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
    const extended = wireAmount(Math.round(args.priceCents * args.quantity), locale);
    return this.eventLine(1011, [
      ['TransactionNumber', args.tx],
      ['ItemNumber', args.lineNumber],
      ['Barcode', args.barcode],
      ['ItemType', 'Regular Sales Item'],
      ['Description', args.description],
      ['UnitPrice', wireAmount(args.priceCents, locale)],
      ['ExtendedPrice', extended],
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
      ['NewUnitPrice', wireAmount(args.newUnitPriceCents, args.locale ?? 'en')],
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
      ['ExtendedPrice', wireAmount(args.extendedPriceCents, args.locale ?? 'en')],
    ]);
  }

  tender(args: { tx: number; amountCents: number; mopDescription: string; mopId?: number; locale?: PosLocale }): string {
    return this.eventLine(1007, [
      ['TransactionNumber', args.tx],
      ['MOPId', args.mopId ?? 5],
      ['MOPDescription', args.mopDescription],
      ['Amount', wireAmount(args.amountCents, args.locale ?? 'en')],
    ]);
  }

  change(args: { tx: number; amountCents: number; mopDescription?: string; locale?: PosLocale }): string {
    return this.eventLine(1008, [
      ['TransactionNumber', args.tx],
      ['MOPId', 5],
      ['MOPDescription', args.mopDescription ?? 'Cash'],
      ['Amount', wireAmount(args.amountCents, args.locale ?? 'en')],
    ]);
  }

  /** EventId 1022 — CAD cash rounding. The player ignores Arrondir/Rounding. */
  rounding(args: { tx: number; amountCents: number; description?: 'Arrondir' | 'Rounding'; locale?: PosLocale }): string {
    return this.eventLine(1022, [
      ['TransactionNumber', args.tx],
      ['Description', args.description ?? 'Arrondir'],
      ['Amount', wireAmount(args.amountCents, args.locale ?? 'en')],
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
    const qty = String(Math.trunc(quantity));
    const price = formatPoleAmount(priceCents, locale);
    const prefix = `${qty} ${description}`;
    const gap = Math.max(1, 20 - prefix.length - price.length);
    let window = prefix + ' '.repeat(gap) + price;
    if (window.length > 20) {
      // Trim the description so the whole window fits 20 chars.
      const overflow = window.length - 20;
      const trimmedDesc = description.slice(0, Math.max(0, description.length - overflow));
      window = `${qty} ${trimmedDesc} ${price}`;
    }
    return window.padEnd(20, ' ').slice(0, 20);
  }
}
