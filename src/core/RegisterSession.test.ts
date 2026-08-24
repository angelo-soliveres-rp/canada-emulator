import { describe, it, expect } from 'vitest';
import { RegisterSession, type WireMessage } from './RegisterSession';

function eventIds(messages: WireMessage[]): string[] {
  return messages
    .filter((m) => m.channel === 'vj')
    .map((m) => m.data.match(/EventId=(\d+)/)?.[1] ?? '')
    .filter(Boolean);
}

describe('RegisterSession', () => {
  it('opens the lane once: registerOpen + basketStarted + pole balance', () => {
    const s = new RegisterSession();
    const msgs = s.open();
    expect(eventIds(msgs)).toEqual(['1001', '1009']);
    expect(msgs.some((m) => m.channel === 'pole')).toBe(true);
    // Idempotent — opening again emits nothing.
    expect(s.open()).toEqual([]);
  });

  it('auto-opens on first addItem and emits item add + pole windows', () => {
    const s = new RegisterSession();
    const msgs = s.addItem({ code: '049000000443', description: 'Coke', priceCents: 169 });
    expect(eventIds(msgs)).toEqual(['1001', '1009', '1011']);
    const snap = s.snapshot();
    expect(snap.lines).toHaveLength(1);
    expect(snap.subtotalCents).toBe(169);
  });

  it('void / qty / price emit their VJ events and a refreshed balance', () => {
    const s = new RegisterSession();
    s.addItem({ code: 'a', description: 'A', priceCents: 100 });
    expect(eventIds(s.setQuantity(1, 3))).toContain('1014');
    expect(s.snapshot().subtotalCents).toBe(300);
    expect(eventIds(s.setPrice(1, 50))).toContain('1013');
    expect(s.snapshot().subtotalCents).toBe(150);
    expect(eventIds(s.voidLine(1))).toContain('1012');
    expect(s.snapshot().subtotalCents).toBe(0);
  });

  it('addItem with quantity encodes Quantity (drives nthItemScanned / basket ad triggers)', () => {
    const s = new RegisterSession();
    const msgs = s.addItem({ code: '628700001111', description: 'Combo', priceCents: 100, quantity: 2 });
    const itemAdd = msgs.find((m) => m.data.includes('EventId=1011'))!;
    expect(itemAdd.data).toContain('Barcode=628700001111');
    expect(itemAdd.data).toContain('Quantity=2.000');
    expect(s.snapshot().lines[0].quantity).toBe(2);
  });

  it('loyalty emits EventId 1024 with the card number', () => {
    const s = new RegisterSession();
    const msgs = s.loyalty('8018782603800034999992');
    expect(msgs.find((m) => m.data.includes('EventId=1024'))?.data).toContain('DiscountCardNumber=8018782603800034999992');
  });

  it('loyalty as the first action opens the lane first (1001 + 1009 precede 1024)', () => {
    const s = new RegisterSession();
    const msgs = s.loyalty('8018782603800034999992');
    const ids = msgs.filter((m) => m.channel === 'vj').map((m) => m.data.match(/EventId=(\d+)/)?.[1]);
    expect(ids).toEqual(['1001', '1009', '1024']);
    // The lane is now open: a following addItem must not re-emit registerOpen.
    const next = s.addItem({ code: 'a', description: 'A', priceCents: 100 });
    expect(next.some((m) => m.data.includes('EventId=1001'))).toBe(false);
  });

  it('setQuantity as the first action opens the lane first (1001 + 1009 precede 1014)', () => {
    const s = new RegisterSession();
    const msgs = s.setQuantity(1, 2);
    const ids = msgs.filter((m) => m.channel === 'vj').map((m) => m.data.match(/EventId=(\d+)/)?.[1]);
    expect(ids).toEqual(['1001', '1009', '1014']);
  });

  it('cash-exact tender emits Arrondir rounding, tender, change, basketEnd and resets', () => {
    const s = new RegisterSession({ taxRateBps: 500 });
    s.addItem({ code: 'a', description: 'A', priceCents: 169 }); // total 177 → rounds to 175
    const msgs = s.tender('cash-exact');
    expect(eventIds(msgs)).toEqual(expect.arrayContaining(['1022', '1007', '1008', '1002']));
    expect(msgs.find((m) => m.data.includes('EventId=1022'))?.data).toContain('Description=Arrondir');
    // Resets: tx advanced, basket cleared.
    const snap = s.snapshot();
    expect(snap.tx).toBe(2);
    expect(snap.lines).toHaveLength(0);
    expect(snap.started).toBe(false);
  });

  it('voidTicket emits a cancelled basketEnd (1002), clears pole and resets', () => {
    const s = new RegisterSession();
    s.addItem({ code: 'a', description: 'A', priceCents: 169 });
    const msgs = s.voidTicket();
    const end = msgs.find((m) => m.data.includes('EventId=1002'))!;
    expect(end.data).toContain('TransactionCompletionType=Cancelled');
    const snap = s.snapshot();
    expect(snap.tx).toBe(2);
    expect(snap.lines).toHaveLength(0);
    expect(snap.started).toBe(false);
  });

  it('no rounding event when the total is already a multiple of 5 cents', () => {
    const s = new RegisterSession({ taxRateBps: 0 });
    s.addItem({ code: 'a', description: 'A', priceCents: 200 });
    expect(eventIds(s.tender('cash-exact'))).not.toContain('1022');
  });

  it('fr locale produces fr pole windows', () => {
    const s = new RegisterSession();
    s.setLocale('fr');
    const msgs = s.addItem({ code: 'a', description: 'Cafe', priceCents: 194 });
    const poleBalance = msgs.filter((m) => m.channel === 'pole').pop()!;
    expect(poleBalance.data.replace(/�/g, ' ')).toMatch(/Solde d.:/);
  });
});

function poleDatas(messages: WireMessage[]): string[] {
  return messages.filter((m) => m.channel === 'pole').map((m) => m.data);
}

describe('RegisterSession — Bulloch (pole-only)', () => {
  const bulloch = (): RegisterSession => new RegisterSession({ registerType: 'bulloch', taxRateBps: 0 });

  it('never emits virtual-journal messages', () => {
    const s = bulloch();
    const all = [...s.addItem({ code: '1', description: 'A', priceCents: 100 }), ...s.tender('cash-exact')];
    expect(all.some((m) => m.channel === 'vj')).toBe(false);
  });

  it('opens with [C000] NEWSALE LANG=EN and no VJ', () => {
    const s = bulloch();
    expect(poleDatas(s.open())).toEqual(['[C000] NEWSALE LANG=EN\n']);
  });

  it('uses LANG=FR when the locale is fr', () => {
    const s = bulloch();
    s.setLocale('fr');
    expect(poleDatas(s.open())[0]).toBe('[C000] NEWSALE LANG=FR\n');
  });

  it('auto-opens then emits a [C110] item line with embedded running totals', () => {
    const s = bulloch();
    const datas = poleDatas(s.addItem({ code: '0000000002125', description: 'FROSTER SWIRL 350M', priceCents: 219 }));
    expect(datas[0]).toBe('[C000] NEWSALE LANG=EN\n');
    expect(datas[1]).toBe(
      '[C110] 0000000002125 FROSTER SWIRL 350M QT=1 PR=2.19 AMT=2.19 STTL=2.19 DSC=0.00 TAX=0.00 TOTAL=2.19\n',
    );
  });

  it('voidLine emits [C120] Undo Item with the line description', () => {
    const s = bulloch();
    s.addItem({ code: '1', description: 'HD CHEESE STICKS H', priceCents: 169 });
    const datas = poleDatas(s.voidLine(1));
    expect(datas[0]).toBe('[C120] Undo Item  HD CHEESE STICKS H STTL=0.00 DSC=0.00 TAX=0.00 TOTAL=0.00\n');
  });

  it('setQuantity emits a void then a re-add (legacy void+re-add parity)', () => {
    const s = bulloch();
    s.addItem({ code: '1', description: 'A', priceCents: 100 });
    const datas = poleDatas(s.setQuantity(1, 3));
    expect(datas[0].startsWith('[C120] Undo Item  A ')).toBe(true);
    expect(datas[1]).toBe('[C110] 1 A QT=3 PR=1.00 AMT=3.00 STTL=3.00 DSC=0.00 TAX=0.00 TOTAL=3.00\n');
  });

  it('setPrice emits a void then a re-add at the new price', () => {
    const s = bulloch();
    s.addItem({ code: '1', description: 'A', priceCents: 100 });
    const datas = poleDatas(s.setPrice(1, 250));
    expect(datas[0].startsWith('[C120] Undo Item  A ')).toBe(true);
    expect(datas[1]).toBe('[C110] 1 A QT=1 PR=2.50 AMT=2.50 STTL=2.50 DSC=0.00 TAX=0.00 TOTAL=2.50\n');
  });

  it('loyalty is a no-op for Bulloch (no VJ 1024 path)', () => {
    const s = bulloch();
    expect(s.loyalty('8018782603800034999992')).toEqual([]);
  });

  it('voidTicket emits [C121] CLEAR SALE and resets', () => {
    const s = bulloch();
    s.addItem({ code: '1', description: 'A', priceCents: 100 });
    expect(poleDatas(s.voidTicket())).toContain('[C121] CLEAR SALE\n');
    const snap = s.snapshot();
    expect(snap.tx).toBe(2);
    expect(snap.lines).toHaveLength(0);
    expect(snap.started).toBe(false);
  });

  it('tender emits [C200] Sale with TRANS/TOTAL/CHNG/TAX and resets', () => {
    const s = bulloch();
    s.addItem({ code: '1', description: 'A', priceCents: 200 });
    const datas = poleDatas(s.tender('amount', 500));
    expect(datas).toContain('[C200] Sale TRANS=000001 TOTAL=2.00 CHNG=3.00 TAX=0.00\n');
    expect(s.snapshot().tx).toBe(2);
  });
});

describe('RegisterSession — radiant6-us (VJ-only, cents-exact, VJ-authoritative totals)', () => {
  const us = (): RegisterSession => new RegisterSession({ registerType: 'radiant6-us' });

  it('opens the lane on the VJ alone — no pole messages ever', () => {
    const s = us();
    const msgs = s.open();
    expect(eventIds(msgs)).toEqual(['1001', '1009']);
    expect(msgs.every((m) => m.channel === 'vj')).toBe(true);
  });

  it('addItem emits 1011 + running 1005/1020 (VJ-authoritative cadence), no pole windows', () => {
    const s = us();
    const msgs = s.addItem({ code: '049000000443', description: 'Coke', priceCents: 229 });
    expect(msgs.every((m) => m.channel === 'vj')).toBe(true);
    expect(eventIds(msgs)).toEqual(['1001', '1009', '1011', '1005', '1020']);
    expect(msgs[2].data).toContain('Barcode=049000000443');
    expect(msgs[3].data).toContain('Amount=2.29'); // running subtotal
    expect(msgs[4].data).toContain('Amount=0.11'); // running tax (5%)
  });

  it('voidLine emits 1012 (with the US-only Barcode) then the refreshed 1005/1020', () => {
    const s = us();
    s.addItem({ code: '049000000443', description: 'Coke', priceCents: 229 });
    const msgs = s.voidLine(1);
    expect(eventIds(msgs)).toEqual(['1012', '1005', '1020']);
    expect(msgs[0].data).toContain('Barcode=049000000443');
    expect(msgs[1].data).toContain('Amount=0.00'); // subtotal back to zero
    expect(msgs[2].data).toContain('Amount=0.00');
  });

  it('qty and price changes also refresh the running 1005/1020', () => {
    const s = us();
    s.addItem({ code: 'a', description: 'Gum', priceCents: 99 });
    const qty = s.setQuantity(1, 3); // subtotal 2.97, tax 0.15
    expect(eventIds(qty)).toEqual(['1014', '1005', '1020']);
    expect(qty[1].data).toContain('Amount=2.97');
    expect(qty[2].data).toContain('Amount=0.15');
    const price = s.setPrice(1, 100); // subtotal 3.00, tax 0.15
    expect(eventIds(price)).toEqual(['1013', '1005', '1020']);
    expect(price[1].data).toContain('Amount=3.00');
  });

  it('tender is cents-exact: 1005 subtotal → 1020 tax → 1007 → 1008 → 1002, never 1022 rounding', () => {
    const s = us();
    // 3 × $0.99 = $2.97 subtotal, 5% tax = $0.15, total $3.12 — a total that
    // Canada would round to $3.10 and stamp with an Arrondir 1022.
    s.addItem({ code: 'a', description: 'Gum', priceCents: 99, quantity: 3 });
    const msgs = s.tender('cash-exact');
    expect(eventIds(msgs)).toEqual(['1005', '1020', '1007', '1008', '1002']);
    expect(msgs.every((m) => m.channel === 'vj')).toBe(true);
    expect(msgs[0].data).toContain('Amount=2.97'); // 1005 subtotal
    expect(msgs[1].data).toContain('Amount=0.15'); // 1020 tax
    expect(msgs[2].data).toContain('Amount=3.12'); // 1007 exact tender — no 5¢ rounding
    expect(msgs[3].data).toContain('Amount=0.00'); // 1008 change
    expect(msgs[4].data).toContain('SubtotalAmount=2.97');
    expect(msgs[4].data).toContain('TaxAmount=0.15');
    expect(msgs[4].data).toContain('TotalAmount=3.12');
  });

  it('next-dollar tender computes change from the exact (unrounded) total', () => {
    const s = us();
    s.addItem({ code: 'a', description: 'Gum', priceCents: 99, quantity: 3 }); // total 312
    const msgs = s.tender('next-dollar'); // tendered 400
    expect(msgs.find((m) => m.data.includes('EventId=1008'))!.data).toContain('Amount=0.88');
  });

  it('voidTicket emits a Cancelled 1002 with no pole and no amount fields', () => {
    const s = us();
    s.addItem({ code: 'a', description: 'Gum', priceCents: 99 });
    const msgs = s.voidTicket();
    expect(eventIds(msgs)).toEqual(['1002']);
    expect(msgs[0].data).toContain('TransactionCompletionType=Cancelled');
    expect(msgs[0].data).not.toContain('SubtotalAmount');
  });

  it('loyalty routes through the US encoder (1024)', () => {
    const s = us();
    const msgs = s.loyalty('8018782603800034999992');
    expect(msgs.at(-1)!.data).toContain('EventId=1024');
    expect(msgs.at(-1)!.data).toContain('DiscountCardNumber=8018782603800034999992');
  });

  it('setLocale(fr) is a no-op — the US wire is monolingual en-US', () => {
    const s = us();
    s.setLocale('fr');
    expect(s.locale).toBe('en');
  });

  it('never emits an Arrondir/Rounding 1022 across a full sale', () => {
    const s = us();
    s.addItem({ code: 'a', description: 'Gum', priceCents: 99, quantity: 3 });
    const all = [...s.tender('cash-exact')].map((m) => m.data).join('');
    expect(all).not.toMatch(/EventId=1022|Arrondir|Rounding/);
  });
});

describe('RegisterSession — basket suspend / resume (1003/1004)', () => {
  it('suspend ends the transaction with a bare 1003 and no 1002', () => {
    // Real fixture (liftck_player dev/playbackFiles/replay.log.bak): 1001/1009
    // /1005/1003 on tx 505, then a fresh 1001/1009 on tx 507 — the suspend is
    // the terminator, there is no basket-end.
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    s.addItem({ code: 'x', description: 'X', priceCents: 500 });
    const msgs = s.suspendBasket();
    expect(eventIds(msgs)).toEqual(['1003']);
    expect(msgs[0].data).toContain('TransactionNumber=1');
    expect(msgs.some((m) => m.data.includes('EventId=1002'))).toBe(false);
  });

  it('suspend clears the basket and advances to the next transaction', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    s.addItem({ code: 'x', description: 'X', priceCents: 500 });
    s.suspendBasket();
    const snap = s.snapshot();
    expect(snap.lines).toEqual([]);
    expect(snap.totalCents).toBe(0);
    expect(snap.tx).toBe(2);
    // Lane is closed again, so the next sale opens normally.
    expect(eventIds(s.open())).toEqual(['1001', '1009']);
  });

  it('suspend with nothing open emits nothing', () => {
    expect(new RegisterSession({ registerType: 'radiant6-us' }).suspendBasket()).toEqual([]);
  });

  it('resume recalls the suspended tx: 1001 then 1004, never a 1009', () => {
    // The player treats 1004 itself as the basket start (Register.ts
    // handleBasketResume -> handleBasketStart), so emitting 1009 too would
    // open two baskets for one recall.
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    s.addItem({ code: 'x', description: 'X', priceCents: 500 });
    s.suspendBasket();
    const msgs = s.resumeBasket();
    expect(eventIds(msgs)).toEqual(['1001', '1004']);
    const resume = msgs.find((m) => m.data.includes('EventId=1004'))!;
    expect(resume.data).toContain('TransactionNumber=2');
    expect(resume.data).toContain('StoredTransactionNumber=1');
  });

  it('resume opens a fresh basket, matching the player (items are not restored)', () => {
    const s = new RegisterSession({ registerType: 'radiant6-canada' });
    s.addItem({ code: 'x', description: 'X', priceCents: 500 });
    s.suspendBasket();
    s.resumeBasket();
    expect(s.snapshot().lines).toEqual([]);
    // Lane is already open — a following item does not re-emit 1001/1009.
    expect(eventIds(s.addItem({ code: 'y', description: 'Y', priceCents: 100 }))).toEqual(['1011']);
  });

  it('resume with no suspended transaction omits StoredTransactionNumber', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    const msgs = s.resumeBasket();
    expect(eventIds(msgs)).toEqual(['1001', '1004']);
    expect(msgs.every((m) => !m.data.includes('StoredTransactionNumber'))).toBe(true);
  });

  it('a second resume does not reuse the already-recalled transaction', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    s.addItem({ code: 'x', description: 'X', priceCents: 500 });
    s.suspendBasket();
    s.resumeBasket();
    s.voidTicket();
    const again = s.resumeBasket();
    expect(again.every((m) => !m.data.includes('StoredTransactionNumber'))).toBe(true);
  });

  it('Topaz and Bulloch have no suspend/resume on the wire', () => {
    for (const registerType of ['verifone', 'bulloch'] as const) {
      const s = new RegisterSession({ registerType });
      s.addItem({ code: 'x', description: 'X', priceCents: 500 });
      expect(s.suspendBasket()).toEqual([]);
      expect(s.resumeBasket()).toEqual([]);
    }
  });
});

describe('RegisterSession — cashier sign-on', () => {
  // Real captures put the 2010 sign-on BEFORE the first 1001, so a sign-on
  // must not drag the lane open the way loyalty() does.
  it('emits a standalone 2010 without opening the lane (radiant6 families)', () => {
    for (const registerType of ['radiant6-us', 'radiant6-canada'] as const) {
      const s = new RegisterSession({ registerType });
      const msgs = s.cashierChange({ operatorId: '77', operatorName: 'Brianna' });
      expect(eventIds(msgs)).toEqual(['2010']);
      expect(msgs[0].data).toContain('OperatorId=77');
      expect(msgs[0].data).toContain('OperatorName=Brianna');
      expect(msgs[0].data).not.toContain('TransactionNumber');
      // Lane still closed — the next action emits the full open preamble.
      expect(eventIds(s.open())).toEqual(['1001', '1009']);
    }
  });

  it('carries the new cashier onto the subsequent 1001', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    s.cashierChange({ operatorId: '77', operatorName: 'Brianna' });
    const open = s.open().find((m) => m.data.includes('EventId=1001'));
    expect(open!.data).toContain('OperatorId=77');
    expect(open!.data).toContain('OperatorName=Brianna');
    expect(open!.data).not.toContain('Timothy');
  });

  it('emits a CSH: line on Topaz and nothing on Bulloch', () => {
    const topaz = new RegisterSession({ registerType: 'verifone' }).cashierChange({
      operatorId: '77',
      operatorName: 'BRIANNA',
    });
    expect(topaz).toHaveLength(1);
    expect(topaz[0].channel).toBe('vj');
    expect(topaz[0].data).toContain('CSH: BRIANNA');

    expect(new RegisterSession({ registerType: 'bulloch' }).cashierChange({ operatorId: '77', operatorName: 'B' })).toEqual([]);
  });

  it('switches cashier mid-basket without disturbing lines or totals', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    s.addItem({ code: '049000000443', description: 'Coke', priceCents: 200 });
    const before = s.snapshot();
    const msgs = s.cashierChange({ operatorId: '77', operatorName: 'Brianna' });
    expect(eventIds(msgs)).toEqual(['2010']);
    const after = s.snapshot();
    expect(after.lines).toEqual(before.lines);
    expect(after.totalCents).toBe(before.totalCents);
    expect(after.tx).toBe(before.tx);
  });

  it('honours the constructor operator defaults', () => {
    const open = new RegisterSession({ registerType: 'radiant6-us', operatorId: '900', operatorName: 'Casey' })
      .open()
      .find((m) => m.data.includes('EventId=1001'));
    expect(open!.data).toContain('OperatorId=900,OperatorName=Casey');
  });
});

describe('RegisterSession — verifone (Topaz plaintext VJ + non-authoritative pole)', () => {
  const topaz = (): RegisterSession => new RegisterSession({ registerType: 'verifone' });

  it('opens the lane with only a CSH: cashier line on the VJ', () => {
    const msgs = topaz().open();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channel).toBe('vj');
    expect(msgs[0].data).toContain('CSH: ');
  });

  it('addItem emits a plaintext VJ item line plus pole item echo and running TOTAL', () => {
    const msgs = topaz().addItem({ code: '049000000443', description: 'COKE 20OZ', priceCents: 229 });
    const vj = msgs.filter((m) => m.channel === 'vj');
    const pole = msgs.filter((m) => m.channel === 'pole');
    expect(vj.at(-1)!.data).toContain('COKE 20OZ');
    expect(vj.at(-1)!.data).toContain('2.29');
    // Legacy parity: item window + running TOTAL window (the player's only
    // mid-basket Balance Due signal in Topaz mode). 229 + 5% tax = 240.
    expect(pole).toHaveLength(2);
    expect(pole[1].data).toContain('TOTAL           2.40');
  });

  it('voidLine emits an explicit V line with the negative extended amount + pole refresh', () => {
    const s = topaz();
    s.addItem({ code: 'a', description: 'COKE 20OZ', priceCents: 229, quantity: 2 });
    const msgs = s.voidLine(1);
    const vj = msgs.filter((m) => m.channel === 'vj');
    expect(vj).toHaveLength(1);
    expect(vj[0].data).toContain('V COKE 20OZ');
    expect(vj[0].data).toContain('-4.58');
    const pole = msgs.filter((m) => m.channel === 'pole');
    expect(pole.at(-1)!.data).toContain('TOTAL           0.00');
  });

  it('qty and price changes become void + re-add pairs (Topaz has no override events)', () => {
    const s = topaz();
    s.addItem({ code: 'a', description: 'COKE 20OZ', priceCents: 229 });
    const qtyMsgs = s.setQuantity(1, 3);
    const qtyVj = qtyMsgs.filter((m) => m.channel === 'vj');
    expect(qtyVj).toHaveLength(2);
    expect(qtyVj[0].data).toContain('-2.29');
    expect(qtyVj[1].data).toContain('6.87');
    // Running pole TOTAL follows the mutation: 687 + 5% tax = 721.
    expect(qtyMsgs.filter((m) => m.channel === 'pole').at(-1)!.data).toContain('TOTAL           7.21');
    const priceMsgs = s.setPrice(1, 100);
    const priceVj = priceMsgs.filter((m) => m.channel === 'vj');
    expect(priceVj[0].data).toContain('-6.87');
    expect(priceVj[1].data).toContain('3.00');
    expect(priceMsgs.filter((m) => m.channel === 'pole').at(-1)!.data).toContain('TOTAL           3.15');
  });

  it('tender is cents-exact: Sub Total, TAX, TOTAL, CASH, ST#/TRAN# with pole windows', () => {
    const s = topaz();
    s.addItem({ code: 'a', description: 'GUM PACK', priceCents: 99, quantity: 3 }); // 297 + 15 tax = 312
    const msgs = s.tender('next-dollar'); // tendered 400, change 88
    const vjText = msgs.filter((m) => m.channel === 'vj').map((m) => m.data).join('');
    expect(vjText).toContain('Sub Total          2.97');
    expect(vjText).toContain('TAX          0.15');
    expect(vjText).toContain('TOTAL          3.12'); // exact — never rounded to 3.10
    expect(vjText).toContain('CASH          4.00');
    expect(vjText).toMatch(/ST# \d+ DR# \d+ TRAN# \d+/);
    const poleText = msgs.filter((m) => m.channel === 'pole').map((m) => m.data).join('');
    expect(poleText).toContain('TOTAL           3.12');
    expect(poleText).toContain('CHANGE          0.88');
  });

  it('voidTicket emits VOID TICKET then the ST#/TRAN# trailer (BASKET_VOIDED → BASKET_END)', () => {
    const s = topaz();
    s.addItem({ code: 'a', description: 'GUM PACK', priceCents: 99 });
    const msgs = s.voidTicket();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].data).toContain('VOID TICKET 1');
    expect(msgs[1].data).toMatch(/ST# \d+ DR# \d+ TRAN# 1/);
  });

  it('loyalty emits a plaintext LOYALTY line', () => {
    const msgs = topaz().loyalty('8018782603800034999992');
    expect(msgs.at(-1)!.data).toContain('LOYALTY 8018782603800034999992');
  });

  it('setLocale(fr) is a no-op — Verifone is a US family', () => {
    const s = topaz();
    s.setLocale('fr');
    expect(s.locale).toBe('en');
  });
});
