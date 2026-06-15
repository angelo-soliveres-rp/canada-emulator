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
