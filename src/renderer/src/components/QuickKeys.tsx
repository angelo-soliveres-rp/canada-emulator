import { useEffect, useMemo, useState } from 'react';
import type { useEmulator } from '../useEmulator';
import { formatCurrency, type PosLocale } from '../../../core/currency';
import { paginate } from '../../../core/quickkeys';
import { ChevronLeftIcon, ChevronRightIcon, ReloadIcon } from '../icons';
import styles from './QuickKeys.module.css';

type Emu = ReturnType<typeof useEmulator>;
const QK_PER_PAGE = 9; // 3 × 3

export function QuickKeys({ e, locale }: { e: Emu; locale: PosLocale }): JSX.Element {
  const [tab, setTab] = useState(0);
  const [page, setPage] = useState(0);
  const files = e.quickKeyFiles;
  const active = files[Math.min(tab, Math.max(0, files.length - 1))];
  const pages = useMemo(() => paginate(active?.entries ?? [], QK_PER_PAGE), [active]);
  const safePage = Math.min(page, pages.length - 1);
  const current = pages[safePage] ?? [];

  useEffect(() => setPage(0), [tab]);

  // Keyboard quick-fire: number keys 1..9 fire the visible keys (ignored while typing).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      const n = Number(ev.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const entry = current[n - 1];
      if (entry) {
        e.fireQuickKey(entry);
        ev.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, e]);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <h3 className={styles.title}>Quick Keys</h3>
        {files.length > 1 && (
          <div className={styles.tabs}>
            {files.map((f, i) => (
              <button key={f.file} className={i === tab ? styles.tabOn : styles.tab} onClick={() => setTab(i)}>
                {f.file.replace(/\.qk$/i, '')}
              </button>
            ))}
          </div>
        )}
        <span className={styles.spacer} />
        <button className={styles.reload} onClick={() => void e.reloadQuickKeys()} title="Reload quick keys from the .qk files" aria-label="Reload quick keys">
          <ReloadIcon size={14} />
        </button>
      </div>

      <div className={styles.grid}>
        {current.map((entry, i) => {
          const color = e.quickKeyColorFor(entry.upc);
          const isAd = color === 'green';
          return (
            <button
              key={`${entry.upc}-${i}`}
              className={`${styles.key} ${color === 'grey' ? styles.grey : ''} ${isAd ? styles.ad : ''}`}
              title={entry.upc}
              onClick={() => e.fireQuickKey(entry)}
            >
              <span className={styles.idx}>{i + 1}</span>
              {isAd && <span className={styles.adtag}>AD</span>}
              <span className={styles.desc}>{entry.description}</span>
              <small className={styles.price}>{formatCurrency(entry.priceCents, locale)}</small>
            </button>
          );
        })}
      </div>

      <div className={styles.foot}>
        {pages.length > 1 ? (
          <div className={styles.pager}>
            <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="Previous page">
              <ChevronLeftIcon size={16} />
            </button>
            <span>
              {safePage + 1} / {pages.length}
            </span>
            <button disabled={safePage >= pages.length - 1} onClick={() => setPage(safePage + 1)} aria-label="Next page">
              <ChevronRightIcon size={16} />
            </button>
          </div>
        ) : (
          <span />
        )}
        <span className={styles.legend}>
          <span className={styles.legtag}>AD</span> ad trigger · keys 1–9
        </span>
      </div>
    </div>
  );
}
