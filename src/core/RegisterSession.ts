/**
 * RegisterSession — orchestrates the Basket + Radiant6CanadaEncoder for one
 * register lane. Every action returns the ordered list of wire messages to
 * push to CK Player 2.0 (VJ lines + pole windows) and mutates the basket.
 *
 * Pure / browser-safe so the UI stays a thin shell over tested logic.
 */
import { Basket } from './Basket';
import { Radiant6CanadaEncoder } from './Radiant6CanadaEncoder';
import { Radiant6USEncoder } from './Radiant6USEncoder';
import { TopazEncoder } from './TopazEncoder';
import { BullochEncoder } from './BullochEncoder';
import { isUsRegisterType } from './posTypes';
import type { Channel, RegisterType } from './posTypes';
import type { PosLocale } from './currency';

export interface WireMessage {
  channel: Channel;
  data: string;
}

export interface AddItemInput {
  code: string;
  description: string;
  priceCents: number;
  quantity?: number;
}

export interface LineSnapshot {
  lineNumber: number;
  code: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  extendedCents: number;
  voided: boolean;
}

export interface SessionSnapshot {
  tx: number;
  started: boolean;
  locale: PosLocale;
  lines: LineSnapshot[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export type TenderKind = 'cash-exact' | 'next-dollar' | 'amount';

export interface RegisterSessionOptions {
  terminalNumber?: number;
  taxRateBps?: number;
  operatorId?: string;
  operatorName?: string;
  startTx?: number;
  clock?: () => Date;
  /** Wire protocol: 'radiant6-canada' (VJ + pole) or 'bulloch' (pole-only). */
  registerType?: RegisterType;
}

export class RegisterSession {
  private readonly encoder: Radiant6CanadaEncoder;
  private readonly us: Radiant6USEncoder;
  private readonly topaz: TopazEncoder;
  private readonly bulloch: BullochEncoder;
  private readonly registerType: RegisterType;
  private readonly taxRateBps: number;
  private readonly operatorId: string;
  private readonly operatorName: string;
  private basket: Basket;
  private tx: number;
  private started = false;
  locale: PosLocale = 'en';

  constructor(options: RegisterSessionOptions = {}) {
    this.encoder = new Radiant6CanadaEncoder({
      terminalNumber: options.terminalNumber ?? 1,
      clock: options.clock,
    });
    this.us = new Radiant6USEncoder({
      terminalNumber: options.terminalNumber ?? 1,
      clock: options.clock,
    });
    this.topaz = new TopazEncoder({
      registerId: options.terminalNumber ?? 101,
      clock: options.clock,
    });
    this.bulloch = new BullochEncoder();
    this.registerType = options.registerType ?? 'radiant6-canada';
    this.taxRateBps = options.taxRateBps ?? 500;
    this.operatorId = options.operatorId ?? '12599';
    this.operatorName = options.operatorName ?? 'Timothy';
    this.tx = options.startTx ?? 1;
    this.basket = new Basket({ taxRateBps: this.taxRateBps });
  }

  /** Bulloch is pole-only (no virtual journal); Radiant6 Canada is VJ + pole. */
  private get isBulloch(): boolean {
    return this.registerType === 'bulloch';
  }

  /** Radiant6 US is VJ-only (no pole display) — 1005/1020 enabled, no rounding, en-US. */
  private get isUs(): boolean {
    return this.registerType === 'radiant6-us';
  }

  /** Verifone Topaz — plaintext VJ (authoritative) + non-authoritative pole, en-US. */
  private get isTopaz(): boolean {
    return this.registerType === 'verifone';
  }

  /** A Bulloch `[C110]` item-add line carrying the running basket totals. */
  private bullochItemMessage(code: string, description: string, quantity: number, priceCents: number): WireMessage {
    return {
      channel: 'pole',
      data: this.bulloch.itemAdd({
        barcode: code,
        description,
        quantity,
        priceCents,
        subtotalCents: this.basket.subtotalCents(),
        taxCents: this.basket.taxCents(),
        totalCents: this.basket.totalCents(),
      }),
    };
  }

  /** A Bulloch `[C120]` undo-item line carrying the running basket totals. */
  private bullochVoidMessage(description: string): WireMessage {
    return {
      channel: 'pole',
      data: this.bulloch.undoItem({
        description,
        subtotalCents: this.basket.subtotalCents(),
        taxCents: this.basket.taxCents(),
        totalCents: this.basket.totalCents(),
      }),
    };
  }

  setLocale(locale: PosLocale): void {
    // US families are monolingual en-US — never let fr leak onto the US wire.
    if (isUsRegisterType(this.registerType) && locale !== 'en') return;
    this.locale = locale;
  }

  /** Pole window reflecting the current running balance (incl. tax). */
  private balanceMessage(): WireMessage {
    return { channel: 'pole', data: this.encoder.poleBalance(this.basket.totalCents(), this.locale) };
  }

  /** Open the lane if not already open (idempotent). Returns any open messages. */
  private ensureStarted(): WireMessage[] {
    if (this.started) return [];
    this.started = true;
    if (this.isBulloch) {
      return [{ channel: 'pole', data: this.bulloch.newSale(this.locale) }];
    }
    if (this.isUs) {
      // No pole display in the US — the lane opens on the VJ alone.
      return [
        { channel: 'vj', data: this.us.registerOpen({ tx: this.tx, operatorId: this.operatorId, operatorName: this.operatorName }) },
        { channel: 'vj', data: this.us.basketStarted({ tx: this.tx }) },
      ];
    }
    if (this.isTopaz) {
      // Topaz has no explicit open/basket-start events; the cashier line is
      // the only lane-open signal the journal carries.
      return [{ channel: 'vj', data: this.topaz.cashier(this.operatorName) }];
    }
    return [
      { channel: 'vj', data: this.encoder.registerOpen({ tx: this.tx, operatorId: this.operatorId, operatorName: this.operatorName }) },
      { channel: 'vj', data: this.encoder.basketStarted({ tx: this.tx }) },
      this.balanceMessage(),
    ];
  }

  /**
   * Wrap a mutator's wire output with the lane-open preamble so the convention
   * is structural rather than remembered per-method. `build` is a thunk (not
   * pre-built messages) so the opening events are encoded — and the opening
   * pole balance captured — before the action mutates the basket or stamps
   * its own EventTime.
   */
  private emit(build: () => WireMessage[]): WireMessage[] {
    return [...this.ensureStarted(), ...build()];
  }

  open(): WireMessage[] {
    return this.ensureStarted();
  }

  addItem(input: AddItemInput): WireMessage[] {
    return this.emit(() => {
      const li = this.basket.addItem(input);
      if (this.isBulloch) {
        return [this.bullochItemMessage(li.code, li.description, li.quantity, li.unitPriceCents)];
      }
      if (this.isUs) {
        return [
          {
            channel: 'vj',
            data: this.us.itemAdd({
              tx: this.tx,
              lineNumber: li.lineNumber,
              barcode: li.code,
              description: li.description,
              priceCents: li.unitPriceCents,
              quantity: li.quantity,
            }),
          },
        ];
      }
      if (this.isTopaz) {
        return [
          { channel: 'vj', data: this.topaz.itemAdd({ description: li.description, quantity: li.quantity, extendedCents: li.extendedCents() }) },
          { channel: 'pole', data: this.topaz.poleItem(li.description, li.extendedCents()) },
        ];
      }
      return [
        {
          channel: 'vj',
          data: this.encoder.itemAdd({
            tx: this.tx,
            lineNumber: li.lineNumber,
            barcode: li.code,
            description: li.description,
            priceCents: li.unitPriceCents,
            quantity: li.quantity,
            locale: this.locale,
          }),
        },
        { channel: 'pole', data: this.encoder.poleItem(li.quantity, li.description, li.unitPriceCents, this.locale) },
        this.balanceMessage(),
      ];
    });
  }

  voidLine(lineNumber: number): WireMessage[] {
    return this.emit(() => {
      if (this.isBulloch) {
        const description = this.basket.find(lineNumber)?.description ?? '';
        this.basket.voidItem(lineNumber);
        return [this.bullochVoidMessage(description)];
      }
      if (this.isUs) {
        const barcode = this.basket.find(lineNumber)?.code ?? '';
        this.basket.voidItem(lineNumber);
        // US 1012 carries the voided line's Barcode (Canada omits it).
        return [{ channel: 'vj', data: this.us.itemVoid({ tx: this.tx, lineNumber, barcode }) }];
      }
      if (this.isTopaz) {
        const li = this.basket.find(lineNumber);
        this.basket.voidItem(lineNumber);
        return [
          {
            channel: 'vj',
            data: this.topaz.itemVoid({
              description: li?.description ?? '',
              quantity: li?.quantity ?? 1,
              extendedCents: li?.extendedCents() ?? 0,
            }),
          },
        ];
      }
      this.basket.voidItem(lineNumber);
      return [
        { channel: 'vj', data: this.encoder.itemVoid({ tx: this.tx, lineNumber }) },
        this.balanceMessage(),
      ];
    });
  }

  setQuantity(lineNumber: number, quantity: number): WireMessage[] {
    return this.emit(() => {
      const li = this.basket.find(lineNumber);
      const oldQuantity = li?.quantity ?? 1;
      const description = li?.description ?? '';
      const oldExtended = li?.extendedCents() ?? 0;
      this.basket.setQuantity(lineNumber, quantity);
      const updated = this.basket.find(lineNumber);
      if (this.isBulloch) {
        // Legacy Bulloch parity: a quantity change is a void of the old line
        // followed by a re-add at the new quantity (both on the pole).
        return [
          this.bullochVoidMessage(description),
          this.bullochItemMessage(updated?.code ?? '', description, updated?.quantity ?? quantity, updated?.unitPriceCents ?? 0),
        ];
      }
      const extended = updated?.extendedCents() ?? 0;
      if (this.isUs) {
        return [
          { channel: 'vj', data: this.us.qtyChange({ tx: this.tx, lineNumber, oldQuantity, newQuantity: quantity, extendedPriceCents: extended }) },
        ];
      }
      if (this.isTopaz) {
        // Topaz has no qty-change event — the journal shows a void + re-add.
        return [
          { channel: 'vj', data: this.topaz.itemVoid({ description, quantity: oldQuantity, extendedCents: oldExtended }) },
          { channel: 'vj', data: this.topaz.itemAdd({ description, quantity: updated?.quantity ?? quantity, extendedCents: extended }) },
        ];
      }
      return [
        { channel: 'vj', data: this.encoder.qtyChange({ tx: this.tx, lineNumber, oldQuantity, newQuantity: quantity, extendedPriceCents: extended, locale: this.locale }) },
        this.balanceMessage(),
      ];
    });
  }

  setPrice(lineNumber: number, priceCents: number): WireMessage[] {
    return this.emit(() => {
      const before = this.basket.find(lineNumber);
      const description = before?.description ?? '';
      const oldQuantity = before?.quantity ?? 1;
      const oldExtended = before?.extendedCents() ?? 0;
      this.basket.setPrice(lineNumber, priceCents);
      const updated = this.basket.find(lineNumber);
      if (this.isBulloch) {
        // Legacy Bulloch parity: a price change is a void + re-add at the new price.
        return [
          this.bullochVoidMessage(description),
          this.bullochItemMessage(updated?.code ?? '', description, updated?.quantity ?? 1, priceCents),
        ];
      }
      if (this.isUs) {
        return [
          { channel: 'vj', data: this.us.priceOverride({ tx: this.tx, lineNumber, newUnitPriceCents: priceCents }) },
        ];
      }
      if (this.isTopaz) {
        // Topaz has no price-override event — void + re-add at the new price.
        return [
          { channel: 'vj', data: this.topaz.itemVoid({ description, quantity: oldQuantity, extendedCents: oldExtended }) },
          { channel: 'vj', data: this.topaz.itemAdd({ description, quantity: updated?.quantity ?? 1, extendedCents: updated?.extendedCents() ?? 0 }) },
        ];
      }
      return [
        { channel: 'vj', data: this.encoder.priceOverride({ tx: this.tx, lineNumber, newUnitPriceCents: priceCents, locale: this.locale }) },
        this.balanceMessage(),
      ];
    });
  }

  /**
   * Void the whole ticket — EventId 1002 with TransactionCompletionType=Cancelled
   * (the parser decodes this as BASKET_VOIDED). Clears the pole and resets for
   * the next sale.
   */
  voidTicket(): WireMessage[] {
    return this.emit(() => {
      if (this.isBulloch) {
        const cleared: WireMessage[] = [{ channel: 'pole', data: this.bulloch.clearSale() }];
        this.basket = new Basket({ taxRateBps: this.taxRateBps });
        this.tx += 1;
        this.started = false;
        return cleared;
      }
      if (this.isUs) {
        const end: WireMessage = { channel: 'vj', data: this.us.basketEnd({ tx: this.tx, type: 'Sales', completion: 'Cancelled' }) };
        this.basket = new Basket({ taxRateBps: this.taxRateBps });
        this.tx += 1;
        this.started = false;
        return [end];
      }
      if (this.isTopaz) {
        const end: WireMessage = { channel: 'vj', data: this.topaz.voidTicket(this.tx) };
        this.basket = new Basket({ taxRateBps: this.taxRateBps });
        this.tx += 1;
        this.started = false;
        return [end];
      }
      const end: WireMessage = { channel: 'vj', data: this.encoder.basketEnd({ tx: this.tx, type: 'Sales', completion: 'Cancelled' }) };
      this.basket = new Basket({ taxRateBps: this.taxRateBps });
      const balance = this.balanceMessage(); // pole balance now 0
      this.tx += 1;
      this.started = false;
      return [end, balance];
    });
  }

  /**
   * EasyPay / loyalty scan (EventId 1024). cardNumber may be a loyalty id or a
   * 12-digit UPC. Bulloch has no virtual-journal loyalty path, so it's a no-op.
   */
  loyalty(cardNumber: string, cardId?: string): WireMessage[] {
    if (this.isBulloch) return [];
    if (this.isTopaz) {
      // Plaintext `LOYALTY <digits>` line — 10 digits routes as a mobile
      // sign-in on the player, anything else as a card swipe.
      return this.emit(() => [{ channel: 'vj', data: this.topaz.loyalty(cardNumber) }]);
    }
    return this.emit(() => [
      {
        channel: 'vj',
        data: this.isUs
          ? this.us.loyalty({ tx: this.tx, cardNumber, cardId })
          : this.encoder.loyalty({ tx: this.tx, cardNumber, cardId }),
      },
    ]);
  }

  /**
   * Tender and finish the sale. Canada emits Arrondir rounding (if the cash
   * total differs from the exact total), the tender (1007), the pole change
   * window, the change (1008) and basket end (1002). The US is cents-exact
   * (no rounding, no pole) and — being VJ-authoritative — reports subtotal
   * (1005) and tax (1020) before the tender, then closes with a 1002 carrying
   * SubtotalAmount/TaxAmount/TotalAmount. Resets for the next sale.
   */
  tender(kind: TenderKind, amountCents?: number): WireMessage[] {
    return this.emit(() => {
      const exactTotal = this.basket.totalCents();
      if (this.isUs) {
        let tendered: number;
        if (kind === 'cash-exact') tendered = exactTotal;
        else if (kind === 'next-dollar') tendered = this.basket.nextDollarCents();
        else tendered = amountCents ?? exactTotal;
        const usChange = Math.max(0, tendered - exactTotal);
        const subtotal = this.basket.subtotalCents();
        const tax = this.basket.taxCents();
        const sale: WireMessage[] = [
          { channel: 'vj', data: this.us.subtotal({ tx: this.tx, amountCents: subtotal }) },
          { channel: 'vj', data: this.us.tax({ tx: this.tx, amountCents: tax }) },
          { channel: 'vj', data: this.us.tender({ tx: this.tx, amountCents: tendered, mopDescription: 'Cash' }) },
          { channel: 'vj', data: this.us.change({ tx: this.tx, amountCents: usChange }) },
          {
            channel: 'vj',
            data: this.us.basketEnd({
              tx: this.tx,
              type: 'Sales',
              completion: 'Completed',
              subtotalCents: subtotal,
              taxCents: tax,
              totalCents: exactTotal,
            }),
          },
        ];
        this.basket = new Basket({ taxRateBps: this.taxRateBps });
        this.tx += 1;
        this.started = false;
        return sale;
      }
      if (this.isTopaz) {
        // Cents-exact like all US families. The Topaz journal prints
        // Sub Total → TAX → TOTAL → tender → ST#/TRAN# close; change exists
        // only on the pole display (the VJ cascade has no change branch).
        let tendered: number;
        if (kind === 'cash-exact') tendered = exactTotal;
        else if (kind === 'next-dollar') tendered = this.basket.nextDollarCents();
        else tendered = amountCents ?? exactTotal;
        const topazChange = Math.max(0, tendered - exactTotal);
        const sale: WireMessage[] = [
          { channel: 'vj', data: this.topaz.subTotal(this.basket.subtotalCents()) },
          { channel: 'vj', data: this.topaz.tax(this.basket.taxCents()) },
          { channel: 'vj', data: this.topaz.total(exactTotal) },
          { channel: 'pole', data: this.topaz.poleTotal(exactTotal) },
          { channel: 'vj', data: this.topaz.tender({ amountCents: tendered }) },
          { channel: 'pole', data: this.topaz.poleTender(tendered) },
          { channel: 'pole', data: this.topaz.poleChange(topazChange) },
          { channel: 'vj', data: this.topaz.basketEnd({ storeNumber: '1', tx: this.tx }) },
        ];
        this.basket = new Basket({ taxRateBps: this.taxRateBps });
        this.tx += 1;
        this.started = false;
        return sale;
      }
      const roundedTotal = this.basket.roundCashTotal();

      let tendered: number;
      if (kind === 'cash-exact') tendered = roundedTotal;
      else if (kind === 'next-dollar') tendered = this.basket.nextDollarCents();
      else tendered = amountCents ?? roundedTotal;

      const change = Math.max(0, tendered - roundedTotal);
      const roundingDelta = roundedTotal - exactTotal;

      if (this.isBulloch) {
        // Bulloch closes the sale with a single pole [C200] line (no VJ, no
        // Arrondir event). TOTAL is the exact basket total; CHNG is the change.
        const close: WireMessage[] = [{
          channel: 'pole',
          data: this.bulloch.saleClose({
            tx: this.tx,
            totalCents: exactTotal,
            changeCents: change,
            taxCents: this.basket.taxCents(),
          }),
        }];
        this.basket = new Basket({ taxRateBps: this.taxRateBps });
        this.tx += 1;
        this.started = false;
        return close;
      }

      const rounding: WireMessage[] = roundingDelta !== 0
        ? [{ channel: 'vj', data: this.encoder.rounding({ tx: this.tx, amountCents: roundingDelta, locale: this.locale }) }]
        : [];
      const sale: WireMessage[] = [
        ...rounding,
        { channel: 'vj', data: this.encoder.tender({ tx: this.tx, amountCents: tendered, mopDescription: 'Cash', locale: this.locale }) },
        { channel: 'pole', data: this.encoder.poleChange(change, this.locale) },
        { channel: 'vj', data: this.encoder.change({ tx: this.tx, amountCents: change, locale: this.locale }) },
        { channel: 'vj', data: this.encoder.basketEnd({ tx: this.tx, type: 'Sales', completion: 'Completed' }) },
      ];

      // Reset for the next sale.
      this.basket = new Basket({ taxRateBps: this.taxRateBps });
      this.tx += 1;
      this.started = false;
      return sale;
    });
  }

  snapshot(): SessionSnapshot {
    return {
      tx: this.tx,
      started: this.started,
      locale: this.locale,
      lines: this.basket.lineItems().map((li) => ({
        lineNumber: li.lineNumber,
        code: li.code,
        description: li.description,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        extendedCents: li.extendedCents(),
        voided: li.voided,
      })),
      subtotalCents: this.basket.subtotalCents(),
      taxCents: this.basket.taxCents(),
      totalCents: this.basket.totalCents(),
    };
  }
}
