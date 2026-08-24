/**
 * NGRP order-document encoder — the LOA-mode wire format.
 *
 * In LOA mode the emulator drives a real player (loa-player / CK Player 2.0)
 * embedded as a cross-origin iframe, over `window.postMessage`, exactly as a
 * Mashgin kiosk does. Instead of the incremental POS-wire events the Radiant6/
 * Bulloch/Topaz encoders emit, the player consumes a **full NGRP order document**
 * re-sent on every basket change (declarative state sync).
 *
 * This module is the pure serializer: a `SessionSnapshot` (integer cents) → an
 * NGRP document (dollars). It is browser-safe (no Node/Electron, no clock, no
 * randomness) so it stays unit-testable — the caller supplies the order `uuid`,
 * `storeId` and `status`. The envelope (`{name,ts,details}`) is added by the
 * renderer transport, not here.
 *
 * Shapes verified against loa-player's `register.component.ts` (`addItem()`,
 * line-item fields) and the reference emulator's `data.service.ts` (order uuid
 * in base62; `source=EMULATOR` so completer rules trust basket contents).
 */
import type { SessionSnapshot } from './RegisterSession';

/** MashginPayloadSource.EMULATOR — the player trusts basket contents (no discountLines needed). */
export const SOURCE_EMULATOR = 1;

/** Lifecycle status carried on the order document. */
export type NgrpStatus = 'OPEN' | 'TENDERED' | 'CANCELED';

/** Loyalty customer block (real 4-field shape, register.component.ts:157-162). */
export interface NgrpCustomer {
  brierleyId: string;
  mobileNumber: string;
  oktaId: string;
  loyaltyCard: string;
}

/** One order line — money in dollars, matching the real order document. */
export interface NgrpLineItem {
  id: string;
  itemId: string;
  amount: number;
  quantity: number;
  code: string;
  posCode: string;
  voided: boolean;
  description: string;
  lineSeq: number;
}

export interface NgrpOrder {
  itemLines: NgrpLineItem[];
  storeId: string;
  uuid: string;
  registerId: string;
  status: NgrpStatus;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  customer?: NgrpCustomer;
}

/** The full document sent as the `details` of an `rp-ngrp-doc` message. */
export interface NgrpDocument {
  store: { id: string };
  storeId: string;
  menu: Record<string, unknown>;
  reportLocation: string;
  changed: boolean;
  source: number;
  order: NgrpOrder;
}

export interface BuildOrderDocOptions {
  /** Order uuid (base62 — see RegisterSession.newOrderUuid). */
  uuid: string;
  /** Store id stamped on the document + report location. */
  storeId: string;
  status: NgrpStatus;
  /** POS register id column (default '0501', matching the reference emulator). */
  registerId?: string;
  /** Attached when a loyalty customer is signed in. */
  customer?: NgrpCustomer;
}

/** Integer cents → dollars with 2-decimal precision (the on-wire money unit). */
export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/** Build the NGRP order document for the current basket snapshot. */
export function buildOrderDoc(snapshot: SessionSnapshot, opts: BuildOrderDocOptions): NgrpDocument {
  const itemLines: NgrpLineItem[] = snapshot.lines.map((li) => {
    const key = li.code || String(li.lineNumber);
    return {
      id: `line-${li.lineNumber}`,
      itemId: `item-${key}`,
      amount: centsToDollars(li.unitPriceCents),
      quantity: li.quantity,
      code: `${key}-0`,
      posCode: key,
      voided: li.voided,
      description: li.description,
      lineSeq: li.lineNumber,
    };
  });

  const order: NgrpOrder = {
    itemLines,
    storeId: opts.storeId,
    uuid: opts.uuid,
    registerId: opts.registerId ?? '0501',
    status: opts.status,
    subtotal: centsToDollars(snapshot.subtotalCents),
    discountTotal: 0,
    taxTotal: centsToDollars(snapshot.taxCents),
    total: centsToDollars(snapshot.totalCents),
  };
  if (opts.customer) order.customer = opts.customer;

  return {
    store: { id: opts.storeId },
    storeId: opts.storeId,
    menu: {},
    reportLocation: opts.storeId,
    changed: true,
    source: SOURCE_EMULATOR,
    order,
  };
}
