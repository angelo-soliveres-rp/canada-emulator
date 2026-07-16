import { useState } from 'react';
import type { useEmulator } from '../useEmulator';
import { formatCurrency, type PosLocale } from '../../../core/currency';
import styles from './Transaction.module.css';

type Emu = ReturnType<typeof useEmulator>;

/**
 * US loyalty quick actions — one per branch of the player's EventId 1024
 * discriminator (route1024Event): a 22-digit 8018-prefix Circle K card signs
 * in, an exactly-12-digit number rings as a coupon UPC (LIFTBAU-565), and a
 * number inside the fuel-card BIN range is silently ignored by the player.
 */
const US_LOYALTY_ACTIONS: ReadonlyArray<{ label: string; hint: string; cardNumber: string }> = [
  { label: 'Loyalty Card', hint: 'sign-in', cardNumber: '8018782603800034999992' },
  { label: 'UPC Coupon', hint: '12-digit', cardNumber: '049000000443' },
  { label: 'Fuel Card', hint: 'ignored', cardNumber: '782603797000000001' },
];

export function Transaction({ e, locale }: { e: Emu; locale: PosLocale }): JSX.Element {
  const { snapshot } = e;
  // Tender/void only make sense with a live basket; disabled when empty.
  const hasItems = snapshot.lines.some((l) => !l.voided);
  const isUs = e.config.registerType === 'radiant6-us';
  const [manualCode, setManualCode] = useState('');

  const scanManual = (): void => {
    const code = manualCode.trim();
    if (!code) return;
    e.scan(code);
    setManualCode('');
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <h3 className={styles.title}>Transaction</h3>
        <span className={styles.tx}>#{snapshot.tx}</span>
      </div>

      <div className={styles.manual}>
        <input
          value={manualCode}
          placeholder="UPC / item code — Enter to scan"
          spellCheck={false}
          onChange={(ev) => setManualCode(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') scanManual();
          }}
          aria-label="Manual UPC entry"
        />
        <button onClick={scanManual} disabled={!manualCode.trim()}>
          Scan
        </button>
      </div>

      <div className={styles.tablewrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.cNum}>#</th>
              <th>Item</th>
              <th className={styles.cQty}>Qty</th>
              <th className={styles.cNumeric}>Price</th>
              <th className={styles.cNumeric}>Ext</th>
              <th className={styles.cAct} aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {snapshot.lines.length === 0 && (
              <tr>
                <td colSpan={6} className={styles.empty}>No items — tap a quick key, press 1–9, or scan a UPC</td>
              </tr>
            )}
            {snapshot.lines.map((li) => (
              <tr key={li.lineNumber} className={li.voided ? styles.voided : undefined}>
                <td className={styles.cNum}>{li.lineNumber}</td>
                <td className={styles.cItem}>{li.description}</td>
                <td className={styles.cQty}>{li.quantity}</td>
                <td className={styles.cNumeric}>{formatCurrency(li.unitPriceCents, locale)}</td>
                <td className={styles.cNumeric}>{formatCurrency(li.extendedCents, locale)}</td>
                <td className={styles.cAct}>
                  {!li.voided && (
                    <div className={styles.lineactions}>
                      <button onClick={() => e.setQuantity(li.lineNumber, li.quantity + 1)} title="Add one">+1</button>
                      <button onClick={() => e.setPrice(li.lineNumber, Math.max(0, li.unitPriceCents - 10))} title="Drop price 10¢">−10¢</button>
                      <button className={styles.void} onClick={() => e.voidLine(li.lineNumber)} title="Void line">void</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.totals}>
        <div className={styles.line}>
          <span>Subtotal</span>
          <b>{formatCurrency(snapshot.subtotalCents, locale)}</b>
        </div>
        <div className={styles.line}>
          <span>Tax</span>
          <b>{formatCurrency(snapshot.taxCents, locale)}</b>
        </div>
        <div className={styles.grand}>
          <span>Total</span>
          <b>{formatCurrency(snapshot.totalCents, locale)}</b>
        </div>
      </div>

      {isUs && (
        <div className={styles.loyalty}>
          {US_LOYALTY_ACTIONS.map((a) => (
            <button key={a.label} onClick={() => e.loyalty(a.cardNumber)} title={`EventId 1024 — ${a.cardNumber}`}>
              {a.label}<small>{a.hint}</small>
            </button>
          ))}
        </div>
      )}

      <div className={styles.tender}>
        <button className={styles.pay} disabled={!hasItems} onClick={() => e.tender('cash-exact')}>
          Cash<small>exact</small>
        </button>
        <button className={styles.pay} disabled={!hasItems} onClick={() => e.tender('next-dollar')}>
          Next $<small>round up</small>
        </button>
        <button className={styles.pay} disabled={!hasItems} onClick={() => e.tender('amount', snapshot.totalCents + 500)}>
          +$5<small>over</small>
        </button>
        <button className={styles.voidticket} disabled={!hasItems} onClick={() => e.voidTicket()}>
          Void Ticket
        </button>
      </div>
    </div>
  );
}
