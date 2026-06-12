import { useEffect, useState } from 'react';
import type { useEmulator } from '../useEmulator';
import { isInteractiveTemplate, type AdItem } from '../../../core/adTriggers';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from '../icons';
import styles from './TriggersCompleters.module.css';

type Emu = ReturnType<typeof useEmulator>;
type Modal = { ad: { id: string; name: string }; kind: 'triggers' | 'completers'; items: AdItem[] };

export function TriggersCompleters({ e }: { e: Emu }): JSX.Element {
  const [page, setPage] = useState(0);
  const [modal, setModal] = useState<Modal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const perPage = 4;
  const ads = e.adManifest;
  const pageCount = Math.max(1, Math.ceil(ads.length / perPage));
  const safePage = Math.min(page, pageCount - 1);
  const current = ads.slice(safePage * perPage, safePage * perPage + perPage);
  const adDetails = e.adDetails;
  const loadedCount = Object.keys(adDetails).length;

  // Close the modal once CKP2 acts on the offer (completer inject) or the tx ends.
  const { tx } = e.snapshot;
  const injectSeq = e.injectSeq;
  useEffect(() => {
    setModal(null);
  }, [tx, injectSeq]);

  // Esc closes the modal.
  useEffect(() => {
    if (!modal) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  const completerState = (id: string): 'has' | 'none' | 'unknown' => {
    const d = adDetails[id];
    if (!d) return 'unknown';
    return d.completers.length > 0 ? 'has' : 'none';
  };

  const open = async (ad: { id: string; name: string }, kind: 'triggers' | 'completers'): Promise<void> => {
    setBusy(`${ad.id}:${kind}`);
    const detail = e.adDetails[ad.id] ?? (await e.loadAdDetail(ad.id));
    setBusy(null);
    const items = !detail ? [] : kind === 'triggers' ? detail.triggers : detail.completers;
    if (kind === 'completers' && items.length === 0) return;
    setModal({ ad, kind, items });
  };

  const onItemClick = (it: AdItem): void => {
    if (!modal) return;
    e.scan(it.code, it.description);
    if (modal.kind === 'triggers') {
      const completers = e.adDetails[modal.ad.id]?.completers ?? [];
      if (completers.length === 0) {
        setModal(null);
        return;
      }
      setModal({ ad: modal.ad, kind: 'completers', items: completers });
    } else {
      setModal(null);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <h3 className={styles.title}>Triggers &amp; Completers</h3>
        <span className={styles.spacer} />
        <button className={styles.load} onClick={() => void e.loadAds()} disabled={e.adsStatus.loading}>
          {e.adsStatus.loading ? 'Loading…' : 'Load ads'}
        </button>
      </div>

      <div className={styles.statusrow}>
        {e.adsStatus.error ? (
          <span className={styles.err} title={e.adsStatus.error}>{e.adsStatus.error}</span>
        ) : ads.length > 0 ? (
          loadedCount < ads.length ? (
            <span className={styles.hint}>loading details… {loadedCount}/{ads.length}</span>
          ) : (
            <span className={styles.legend}>
              {ads.length} ad(s) · <span className={`${styles.dot} ${styles.has}`} /> completers · <span className={styles.bar} /> interactive
            </span>
          )
        ) : (
          <span className={styles.hint}>Register the player, then Load ads</span>
        )}
      </div>

      {ads.length > 0 && (
        <>
          <div className={styles.list}>
            {current.map((ad) => {
              const cs = completerState(ad.id);
              const template = adDetails[ad.id]?.template ?? '';
              const interactive = isInteractiveTemplate(template);
              return (
                <div key={ad.id || ad.name} className={`${styles.row} ${interactive ? styles.interactive : ''}`}>
                  <span className={`${styles.dot} ${styles[cs]}`} title={cs === 'has' ? 'Has completers' : cs === 'none' ? 'No completers' : 'Checking…'} />
                  <div className={styles.namewrap}>
                    <span className={styles.name} title={ad.name}>{ad.name}</span>
                    {template && (
                      <span className={styles.tmpl} title={interactive ? 'Interactive microsite ad' : 'Plain image/video ad'}>{template}</span>
                    )}
                  </div>
                  <button className={styles.btn} disabled={busy !== null} onClick={() => void open(ad, 'triggers')}>
                    {busy === `${ad.id}:triggers` ? '…' : 'Triggers'}
                  </button>
                  <button className={styles.btn} disabled={busy !== null || cs === 'none'} title={cs === 'none' ? 'No completers' : undefined} onClick={() => void open(ad, 'completers')}>
                    {busy === `${ad.id}:completers` ? '…' : 'Completers'}
                  </button>
                </div>
              );
            })}
          </div>
          {pageCount > 1 && (
            <div className={styles.pager}>
              <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="Previous">
                <ChevronLeftIcon size={16} />
              </button>
              <span>
                {safePage + 1} / {pageCount}
              </span>
              <button disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)} aria-label="Next">
                <ChevronRightIcon size={16} />
              </button>
            </div>
          )}
        </>
      )}

      {modal && (
        <div className={styles.modal} onClick={() => setModal(null)}>
          <div className={styles.box} onClick={(ev) => ev.stopPropagation()} role="dialog" aria-modal="true">
            <div className={styles.boxhead}>
              <b>{modal.kind === 'triggers' ? 'Triggers' : 'Completers'} — {modal.ad.name}</b>
              <button onClick={() => setModal(null)} aria-label="Close">
                <CloseIcon size={16} />
              </button>
            </div>
            {modal.items.length === 0 ? (
              <span className={styles.hint}>{modal.kind === 'triggers' ? 'No triggers.' : 'No completers.'}</span>
            ) : (
              <div className={styles.items}>
                {modal.items.map((it) => (
                  <button
                    key={it.code}
                    className={styles.item}
                    title={modal.kind === 'triggers' ? 'Scan to fire this ad, then pick a completer' : 'Scan this completer into the basket'}
                    onClick={() => onItemClick(it)}
                  >
                    <span>{it.description || it.code}</span>
                    <small>{it.code}</small>
                  </button>
                ))}
              </div>
            )}
            <span className={styles.modalhint}>
              {modal.kind === 'triggers' ? 'Click a trigger to scan it — then its completers appear.' : 'Click a completer to scan it into the basket.'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
