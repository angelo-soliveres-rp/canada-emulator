import { useEffect, useMemo, useRef, useState } from 'react';
import type { useEmulator } from '../useEmulator';
import type { RegisterType } from '../../../core/posTypes';
import { formatCurrency, type PosLocale } from '../../../core/currency';
import type { QuickKeyEntry } from '../../../core/quickkeys';
import styles from './RightRail.module.css';

type Emu = ReturnType<typeof useEmulator>;

const CHIP_COUNT = 6;

interface LoyaltyAction {
  label: string;
  hint: string;
  cardNumber: string;
}

/**
 * Loyalty quick actions per US register family — one per branch of the
 * player's discriminator.
 *
 * Radiant6 US (EventId 1024 route1024Event): a 22-digit 8018-prefix Circle K
 * card signs in, an exactly-12-digit number rings as a coupon UPC
 * (LIFTBAU-565), and a number inside the fuel-card BIN range is silently
 * ignored. Verifone Topaz (`LOYALTY <digits>` line): exactly 10 digits is a
 * mobile sign-in, anything else a card swipe.
 */
const LOYALTY_ACTIONS: Partial<Record<RegisterType, ReadonlyArray<LoyaltyAction>>> = {
  'radiant6-us': [
    { label: 'Loyalty Card', hint: 'sign-in', cardNumber: '8018782603800034999992' },
    { label: 'UPC Coupon', hint: '12-digit', cardNumber: '049000000443' },
    { label: 'Fuel Card', hint: 'ignored', cardNumber: '782603797000000001' },
  ],
  verifone: [
    { label: 'Loyalty Card', hint: 'swipe', cardNumber: '8018782603800034999992' },
    { label: 'Mobile #', hint: '10-digit', cardNumber: '5551234567' },
  ],
};

/**
 * Cashier presets. Names follow the legacy fixture shape `Last, First`
 * (`OperatorName=Young,, Brianna` on the wire once the encoder escapes the
 * comma) so the escape path gets exercised by hand, not only by tests.
 */
const CASHIER_PRESETS: ReadonlyArray<{ operatorId: string; operatorName: string }> = [
  { operatorId: '12599', operatorName: 'Timothy' },
  { operatorId: '10000000003', operatorName: 'Young, Brianna' },
  { operatorId: '10000000002', operatorName: 'Manager, The' },
];

interface ScanCandidate {
  code: string;
  description: string;
  priceCents?: number;
  isTrigger: boolean;
}

function isTypingTarget(el: Element | null): boolean {
  return el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

/** Rank a candidate against the query: lower is better, null is no match. */
function matchScore(c: ScanCandidate, q: string): number | null {
  const desc = c.description.toLowerCase();
  if (desc.startsWith(q)) return 0;
  if (desc.includes(q)) return 1;
  if (c.code.startsWith(q)) return 2;
  if (c.code.includes(q)) return 3;
  return null;
}

export function RightRail({ e, locale }: { e: Emu; locale: PosLocale }): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [allOpen, setAllOpen] = useState(false);

  const allEntries = useMemo(() => e.quickKeyFiles.flatMap((f) => f.entries), [e.quickKeyFiles]);

  const triggerCodes = useMemo(
    () => new Set(Object.values(e.adDetails).flatMap((d) => d.triggers.map((t) => t.code))),
    [e.adDetails],
  );

  // Everything the scan-anything input can resolve: quick keys, pricebook
  // items, and ad triggers — deduped by code, quick keys winning.
  const candidates = useMemo<ScanCandidate[]>(() => {
    const byCode = new Map<string, ScanCandidate>();
    const add = (c: ScanCandidate): void => {
      if (!byCode.has(c.code)) byCode.set(c.code, c);
    };
    for (const entry of allEntries) {
      add({ code: entry.upc, description: entry.description || entry.upc, priceCents: entry.priceCents, isTrigger: false });
    }
    if (e.pricebookStatus?.ok) {
      for (const entry of e.pricebookStatus.entries) {
        add({ code: entry.barcodes[0] ?? entry.plu, description: entry.description, priceCents: entry.priceCents, isTrigger: false });
      }
    }
    for (const detail of Object.values(e.adDetails)) {
      for (const t of detail.triggers) {
        add({ code: t.code, description: t.description || `${detail.name} trigger`, isTrigger: true });
      }
    }
    return [...byCode.values()].map((c) => (triggerCodes.has(c.code) ? { ...c, isTrigger: true } : c));
  }, [allEntries, e.pricebookStatus, e.adDetails, triggerCodes]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || /^\d+$/.test(q)) return [];
    return candidates
      .map((c) => ({ c, score: matchScore(c, q) }))
      .filter((m): m is { c: ScanCandidate; score: number } => m.score !== null)
      .sort((a, b) => a.score - b.score || a.c.description.length - b.c.description.length)
      .slice(0, 6)
      .map((m) => m.c);
  }, [candidates, query]);

  const scanCandidate = (c: ScanCandidate): void => {
    e.scan(c.code, c.description);
    setQuery('');
    setHighlight(0);
  };

  const commit = (): void => {
    const q = query.trim();
    if (!q) return;
    if (/^\d+$/.test(q)) {
      e.scan(q);
      setQuery('');
      setHighlight(0);
      return;
    }
    const best = matches[Math.min(highlight, matches.length - 1)];
    if (best) scanCandidate(best);
  };

  // ⌘K / Ctrl-K focuses the scan input from anywhere.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Number keys 1–9 quick-fire the first nine quick-key items (ignored while typing).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isTypingTarget(document.activeElement)) return;
      const n = Number(ev.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const entry = allEntries[n - 1];
      if (entry) {
        e.fireQuickKey(entry);
        ev.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allEntries, e]);

  const { snapshot } = e;
  const hasItems = snapshot.lines.some((l) => !l.voided);
  const loyaltyActions = LOYALTY_ACTIONS[e.config.registerType];

  return (
    <section className={styles.wrap}>
      <div className={styles.scanwrap}>
        <input
          ref={inputRef}
          className={styles.scan}
          value={query}
          placeholder="⌘K — scan anything: item, UPC, trigger…"
          spellCheck={false}
          aria-label="Scan anything"
          onChange={(ev) => {
            setQuery(ev.target.value);
            setHighlight(0);
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              commit();
            } else if (ev.key === 'ArrowDown') {
              ev.preventDefault();
              setHighlight((h) => Math.min(h + 1, Math.max(0, matches.length - 1)));
            } else if (ev.key === 'ArrowUp') {
              ev.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            } else if (ev.key === 'Escape') {
              setQuery('');
              setHighlight(0);
              ev.currentTarget.blur();
            }
          }}
        />
        {matches.length > 0 && (
          <div className={styles.suggest} role="listbox">
            {matches.map((m, i) => (
              <button
                key={m.code}
                role="option"
                aria-selected={i === highlight}
                className={`${styles.suggestRow} ${i === highlight ? styles.suggestOn : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => scanCandidate(m)}
              >
                <span className={styles.suggestDesc}>{m.description}</span>
                {m.isTrigger && <span className={styles.suggestTag}>TRIGGER</span>}
                <span className={styles.suggestCode}>{m.code}</span>
                {m.priceCents !== undefined && <span className={styles.suggestPrice}>{formatCurrency(m.priceCents, locale)}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={styles.chips}>
        {allEntries.slice(0, CHIP_COUNT).map((entry, i) => (
          <ItemChip key={`${entry.upc}-${i}`} entry={entry} e={e} locale={locale} />
        ))}
        {allEntries.length > 0 && (
          <button className={styles.moreChip} onClick={() => setAllOpen(true)}>
            all items…
          </button>
        )}
      </div>

      {allOpen && <AllItemsPopover entries={allEntries} e={e} locale={locale} onClose={() => setAllOpen(false)} />}

      <div className={styles.basket}>
        <div className={styles.lines}>
          {snapshot.lines.length === 0 ? (
            <div className={styles.empty}>No items — tap a chip, press 1–9, or ⌘K to scan</div>
          ) : (
            snapshot.lines.map((li) => (
              <div key={li.lineNumber} className={`${styles.line} ${li.voided ? styles.voided : ''}`}>
                <span className={styles.num}>{li.lineNumber}</span>
                <span className={styles.desc} title={li.description}>{li.description}</span>
                <span className={styles.qty}>×{li.quantity}</span>
                <span className={styles.ext}>{formatCurrency(li.extendedCents, locale)}</span>
                {!li.voided && (
                  <span className={styles.lineactions}>
                    <button onClick={() => e.setQuantity(li.lineNumber, li.quantity + 1)} title="Add one">+1</button>
                    <button
                      disabled={li.quantity <= 1}
                      onClick={() => e.setQuantity(li.lineNumber, li.quantity - 1)}
                      title={li.quantity <= 1 ? 'Void the line instead' : 'Remove one'}
                    >
                      −1
                    </button>
                    <button onClick={() => e.setPrice(li.lineNumber, Math.max(0, li.unitPriceCents - 10))} title="Drop price 10¢">−10¢</button>
                    <button className={styles.voidBtn} onClick={() => e.voidLine(li.lineNumber)} title="Void line">void</button>
                  </span>
                )}
              </div>
            ))
          )}
        </div>
        <div className={styles.totals}>
          <div className={styles.trow}>
            <span>Subtotal</span>
            <span className={styles.tval}>{formatCurrency(snapshot.subtotalCents, locale)}</span>
          </div>
          <div className={styles.trow}>
            <span>Tax</span>
            <span className={styles.tval}>{formatCurrency(snapshot.taxCents, locale)}</span>
          </div>
          <div className={styles.grand}>
            <span>TOTAL</span>
            <b className={styles.gval}>{formatCurrency(snapshot.totalCents, locale)}</b>
          </div>
        </div>
      </div>

      {e.config.registerType !== 'bulloch' && <CashierBar e={e} />}

      {e.config.registerType === 'verifone' && (
        <div className={styles.parkrow}>
          <button onClick={() => e.ageVerify(true)} title="CUSTOMER ID VERIFIED — the player must discard this line">
            ID verified
          </button>
          <button onClick={() => e.ageVerify(false)} title="ID CHECK SKIPPED — the player must discard this line">
            ID skipped
          </button>
        </div>
      )}

      {(e.config.registerType === 'radiant6-us' || e.config.registerType === 'radiant6-canada') && (
        <div className={styles.parkrow}>
          <button disabled={!snapshot.started} onClick={() => e.suspendBasket()} title="Park this basket (EventId 1003)">
            Suspend
          </button>
          <button onClick={() => e.resumeBasket()} title="Recall the parked basket (EventId 1004)">
            Resume
          </button>
        </div>
      )}

      {loyaltyActions && <LoyaltyBar e={e} />}

      {loyaltyActions && (
        <div className={styles.loyalty}>
          {loyaltyActions.map((a) => (
            <button key={a.label} onClick={() => e.loyalty(a.cardNumber)} title={`Loyalty — ${a.cardNumber}`}>
              {a.label}<small>{a.hint}</small>
            </button>
          ))}
        </div>
      )}

      <div className={styles.tender}>
        <button className={styles.pay} disabled={!hasItems} onClick={() => e.tender('cash-exact')} title="Cash — exact">
          Cash
        </button>
        <button className={styles.pay} disabled={!hasItems} onClick={() => e.tender('next-dollar')} title="Round up to the next dollar">
          Next $
        </button>
        <button className={styles.pay} disabled={!hasItems} onClick={() => e.tender('amount', snapshot.totalCents + 500)} title="Overtender by $5">
          +$5
        </button>
        <button className={styles.voidTicket} disabled={!hasItems} onClick={() => e.voidTicket()} title="Void the whole ticket">
          Void
        </button>
      </div>
    </section>
  );
}

/**
 * Cashier sign-on: who is on the lane now, preset cashiers, and free-text
 * id + name for an arbitrary operator. Hidden for Bulloch, which is pole-only
 * and carries no cashier identity.
 */
function CashierBar({ e }: { e: Emu }): JSX.Element {
  const [id, setId] = useState('');
  const [name, setName] = useState('');

  const trimmedId = id.trim();
  const trimmedName = name.trim();
  const canSignIn = trimmedId !== '' && trimmedName !== '';

  const signIn = (): void => {
    if (!canSignIn) return;
    e.cashier(trimmedId, trimmedName);
    setId('');
    setName('');
  };

  return (
    <div className={styles.cashier}>
      <div className={styles.cashierNow}>
        <span className={styles.cashierLabel}>CASHIER</span>
        <span className={styles.cashierWho}>
          {e.snapshot.operatorId} · {e.snapshot.operatorName}
        </span>
      </div>

      <div className={styles.cashierPresets}>
        {CASHIER_PRESETS.map((c) => (
          <button
            key={c.operatorId}
            onClick={() => e.cashier(c.operatorId, c.operatorName)}
            title={`Sign in ${c.operatorName} (${c.operatorId})`}
          >
            {c.operatorName}
          </button>
        ))}
      </div>

      <div className={styles.cashierForm}>
        <input
          className={styles.cashierId}
          value={id}
          placeholder="id"
          spellCheck={false}
          aria-label="Cashier id"
          onChange={(ev) => setId(ev.target.value)}
          onKeyDown={(ev) => ev.key === 'Enter' && signIn()}
        />
        <input
          className={styles.cashierName}
          value={name}
          placeholder="name"
          spellCheck={false}
          aria-label="Cashier name"
          onChange={(ev) => setName(ev.target.value)}
          onKeyDown={(ev) => ev.key === 'Enter' && signIn()}
        />
        <button className={styles.cashierGo} disabled={!canSignIn} onClick={signIn}>
          Sign in
        </button>
      </div>
    </div>
  );
}

/**
 * Loyalty / EasyPay card entry. The preset chips below cover the player's
 * discriminator branches; this is for an arbitrary card — and it is the only
 * way to set DiscountCardId, which both Radiant6 parsers read
 * (Radiant6MessageParser.ts:559) but no preset exercises.
 *
 * No success indicator on purpose: the wire carries no loyalty result, so
 * anything green here would be invented. The wire log shows the actual 1024.
 */
function LoyaltyBar({ e }: { e: Emu }): JSX.Element {
  const [card, setCard] = useState('');
  const [cardId, setCardId] = useState('');

  const trimmedCard = card.trim();
  const send = (): void => {
    if (!trimmedCard) return;
    e.loyalty(trimmedCard, cardId.trim() || undefined);
  };

  return (
    <div className={styles.loyaltyForm}>
      <span className={styles.loyaltyLabel}>LOYALTY</span>
      <input
        className={styles.loyaltyCard}
        value={card}
        placeholder="card number"
        spellCheck={false}
        aria-label="Loyalty card number"
        onChange={(ev) => setCard(ev.target.value)}
        onKeyDown={(ev) => ev.key === 'Enter' && send()}
      />
      <input
        className={styles.loyaltyCardId}
        value={cardId}
        placeholder="card id"
        spellCheck={false}
        aria-label="Loyalty card id (DiscountCardId)"
        onChange={(ev) => setCardId(ev.target.value)}
        onKeyDown={(ev) => ev.key === 'Enter' && send()}
      />
      <button className={styles.loyaltyGo} disabled={!trimmedCard} onClick={send} title="Send an EasyPay / loyalty sign-in (1024)">
        Send
      </button>
    </div>
  );
}

function ItemChip({ entry, e, locale }: { entry: QuickKeyEntry; e: Emu; locale: PosLocale }): JSX.Element {
  const color = e.quickKeyColorFor(entry.upc);
  return (
    <button
      className={`${styles.itemChip} ${color === 'green' ? styles.chipAd : ''} ${color === 'grey' ? styles.chipGrey : ''}`}
      title={entry.upc}
      onClick={() => e.fireQuickKey(entry)}
    >
      <span className={styles.chipDesc}>{entry.description}</span>
      <small className={styles.chipPrice}>{formatCurrency(entry.priceCents, locale)}</small>
    </button>
  );
}

function AllItemsPopover({
  entries,
  e,
  locale,
  onClose,
}: {
  entries: QuickKeyEntry[];
  e: Emu;
  locale: PosLocale;
  onClose: () => void;
}): JSX.Element {
  const [itemQuery, setItemQuery] = useState('');

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = itemQuery.trim().toLowerCase();
  const filtered = q
    ? entries.filter((en) => en.description.toLowerCase().includes(q) || en.upc.includes(q))
    : entries;

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.popover} role="dialog" aria-label="All quick-key items">
        <input
          autoFocus
          className={styles.popSearch}
          value={itemQuery}
          placeholder="search items…"
          spellCheck={false}
          aria-label="Search items"
          onChange={(ev) => setItemQuery(ev.target.value)}
        />
        <div className={styles.popList}>
          {filtered.length === 0 && <div className={styles.empty}>No items match.</div>}
          {filtered.map((entry, i) => (
            <button
              key={`${entry.upc}-${i}`}
              className={`${styles.popRow} ${e.quickKeyColorFor(entry.upc) === 'green' ? styles.popAd : ''}`}
              onClick={() => {
                e.fireQuickKey(entry);
                onClose();
              }}
            >
              <span className={styles.popDesc}>{entry.description}</span>
              <span className={styles.popCode}>{entry.upc}</span>
              <span className={styles.popPrice}>{formatCurrency(entry.priceCents, locale)}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
