import { useEffect, useMemo, useRef, useState } from 'react';
import type { useEmulator } from '../useEmulator';
import { isInteractiveTemplate } from '../../../core/adTriggers';
import type { AdItem, AdTriggersCompleters } from '../../../core/adTriggers';
import { useBenchRun, type BenchController } from '../hooks/bench';
import styles from './Bench.module.css';

type Emu = ReturnType<typeof useEmulator>;
type BenchFilter = 'all' | 'interactive' | 'completers';

interface BenchAd {
  id: string;
  name: string;
  detail: AdTriggersCompleters | null;
  interactive: boolean;
  hasCompleters: boolean;
}

function isTypingTarget(el: Element | null): boolean {
  return el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

function lastRunLabel(ts: number | undefined): string {
  if (!ts) return 'never run';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString()
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function Bench({ e }: { e: Emu }): JSX.Element {
  const bench = useBenchRun(e);
  const [filter, setFilter] = useState<BenchFilter>('all');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const ads = useMemo<BenchAd[]>(
    () =>
      e.adManifest.map((m) => {
        const detail = e.adDetails[m.id] ?? null;
        return {
          id: m.id,
          name: m.name,
          detail,
          interactive: detail ? isInteractiveTemplate(detail.template) : false,
          hasCompleters: (detail?.completers.length ?? 0) > 0,
        };
      }),
    [e.adManifest, e.adDetails],
  );

  const counts = useMemo(
    () => ({
      all: ads.length,
      interactive: ads.filter((a) => a.interactive).length,
      completers: ads.filter((a) => a.hasCompleters).length,
    }),
    [ads],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ads.filter((a) => {
      if (filter === 'interactive' && !a.interactive) return false;
      if (filter === 'completers' && !a.hasCompleters) return false;
      if (q && !a.name.toLowerCase().includes(q) && !(a.detail?.template ?? '').toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [ads, filter, query]);

  const safeSel = Math.min(sel, Math.max(0, visible.length - 1));

  // Bench keyboard: ↑↓ select ad, t fires the selected ad's first trigger,
  // ↵ fires the active ad's first completer. Ignored while typing in an input;
  // ↵ also defers to a focused button so it can't double-fire a chip.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isTypingTarget(document.activeElement)) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (visible.length === 0) return;
        ev.preventDefault();
        const next = Math.max(0, Math.min(visible.length - 1, safeSel + (ev.key === 'ArrowDown' ? 1 : -1)));
        setSel(next);
        listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (ev.key === 't') {
        const ad = visible[safeSel];
        const trigger = ad?.detail?.triggers[0];
        if (ad && trigger) {
          ev.preventDefault();
          bench.fireTrigger({ id: ad.id, code: trigger.code, description: trigger.description, hasCompleters: ad.hasCompleters });
        }
      } else if (ev.key === 'Enter') {
        if (document.activeElement?.tagName === 'BUTTON') return;
        const active = bench.run ? ads.find((a) => a.id === bench.run?.adId) : undefined;
        const completer = active?.detail?.completers[0];
        if (completer) {
          ev.preventDefault();
          bench.fireCompleter(completer.code, completer.description);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, safeSel, ads, bench]);

  const loadedCount = Object.keys(e.adDetails).length;

  return (
    <section className={styles.wrap}>
      <div className={styles.head}>
        <h3 className={styles.title}>Ad Test Bench</h3>
        <div className={styles.tabs} role="tablist" aria-label="Ad filter">
          {(
            [
              { key: 'all', label: 'All' },
              { key: 'interactive', label: 'Interactive' },
              { key: 'completers', label: 'Has completers' },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={filter === t.key}
              className={filter === t.key ? styles.tabOn : styles.tab}
              onClick={() => setFilter(t.key)}
            >
              {t.label} {counts[t.key]}
            </button>
          ))}
        </div>
        <span className={styles.spacer} />
        <input
          className={styles.find}
          value={query}
          placeholder="find ad…"
          spellCheck={false}
          aria-label="Find ad"
          onChange={(ev) => setQuery(ev.target.value)}
        />
        <button className={styles.reload} onClick={() => void e.loadAds()} disabled={e.adsStatus.loading}>
          {e.adsStatus.loading ? 'Loading…' : 'Reload'}
        </button>
      </div>

      {e.adsStatus.error ? (
        <div className={styles.err} title={e.adsStatus.error}>{e.adsStatus.error}</div>
      ) : ads.length > 0 && loadedCount < ads.length ? (
        <div className={styles.hintrow}>loading details… {loadedCount}/{ads.length}</div>
      ) : null}

      <div className={styles.list} ref={listRef}>
        {ads.length === 0 && !e.adsStatus.error && (
          <div className={styles.empty}>Register the player, then Reload to load its ads.</div>
        )}
        {ads.length > 0 && visible.length === 0 && <div className={styles.empty}>No ads match the filter.</div>}
        {visible.map((ad, i) => (
          <AdCard
            key={ad.id || ad.name}
            ad={ad}
            index={i}
            selected={i === safeSel}
            bench={bench}
            lastRunAt={bench.lastRun[ad.id]}
            onScan={(code, description) => e.scan(code, description)}
          />
        ))}
      </div>

      <div className={styles.keysrow}>
        <span><b>↑↓</b> select ad</span>
        <span><b>t</b> fire trigger</span>
        <span><b>↵</b> first completer</span>
        <span><b>⌘K</b> scan anything</span>
      </div>
    </section>
  );
}

function AdCard({
  ad,
  index,
  selected,
  bench,
  lastRunAt,
  onScan,
}: {
  ad: BenchAd;
  index: number;
  selected: boolean;
  bench: BenchController;
  lastRunAt: number | undefined;
  onScan: (code: string, description?: string) => void;
}): JSX.Element {
  const run = bench.run;
  const active = run?.adId === ad.id;
  const detail = ad.detail;
  const dot = detail === null ? styles.dotUnknown : ad.hasCompleters ? styles.dotHas : styles.dotNone;
  const dotTitle = detail === null ? 'Checking completers…' : ad.hasCompleters ? 'Has completers' : 'No completers';

  const fireTrigger = (t: AdItem, ev: React.MouseEvent<HTMLButtonElement>): void => {
    bench.fireTrigger({ id: ad.id, code: t.code, description: t.description, hasCompleters: ad.hasCompleters });
    ev.currentTarget.blur();
  };

  const fireCompleter = (c: AdItem, ev: React.MouseEvent<HTMLButtonElement>): void => {
    if (active) bench.fireCompleter(c.code, c.description);
    else onScan(c.code, c.description);
    ev.currentTarget.blur();
  };

  const triggerChips = (detail?.triggers ?? []).map((t) => {
    const fired = active && run !== null && run.firedCodes.has(t.code);
    return (
      <button
        key={t.code}
        className={`${styles.chip} ${fired ? styles.chipFired : ''}`}
        title={`Scan trigger ${t.code}`}
        onClick={(ev) => fireTrigger(t, ev)}
      >
        {fired ? '✓ ' : ''}{t.description || t.code}
      </button>
    );
  });

  const completerChips = (detail?.completers ?? []).map((c, i) => (
    <button
      key={c.code}
      className={active ? styles.chipCompleterActive : styles.chipCompleter}
      title={`Scan completer ${c.code}`}
      onClick={(ev) => fireCompleter(c, ev)}
    >
      {active && i === 0 ? '↵ ' : ''}{c.description || c.code}
    </button>
  ));

  return (
    <article
      data-index={index}
      className={`${styles.card} ${active ? styles.cardActive : ''} ${selected ? styles.cardSelected : ''}`}
    >
      <div className={styles.row}>
        <span className={`${styles.dot} ${dot}`} title={dotTitle} />
        <b className={styles.name} title={ad.name}>{ad.name}</b>
        {ad.interactive && <span className={styles.badge}>INTERACTIVE</span>}
        {detail?.template && <span className={styles.tmpl}>{detail.template}</span>}
        <span className={styles.spacer} />
        {active && run ? (
          run.phase === 'awaiting' ? (
            <span className={styles.awaiting}>AWAITING COMPLETER</span>
          ) : (
            <span className={styles.doneTag}>DONE</span>
          )
        ) : (
          <span className={styles.lastrun}>{lastRunLabel(lastRunAt)}</span>
        )}
      </div>

      {detail === null ? (
        <div className={styles.row}>
          <span className={styles.rowlabel}>Triggers</span>
          <span className={styles.loading}>loading…</span>
        </div>
      ) : active ? (
        <>
          <div className={styles.chiprow}>
            <span className={styles.rowlabel}>Triggers</span>
            {triggerChips.length > 0 ? triggerChips : <span className={styles.loading}>none</span>}
          </div>
          <div className={styles.chiprow}>
            <span className={styles.rowlabel}>Completers</span>
            {completerChips.length > 0 ? (
              completerChips
            ) : (
              <span className={styles.nocomp}>no completers — plain playback</span>
            )}
          </div>
        </>
      ) : (
        <div className={styles.chiprow}>
          <span className={styles.rowlabel}>Triggers</span>
          {triggerChips.length > 0 ? triggerChips : <span className={styles.loading}>none</span>}
          <span className={styles.arrow}>→</span>
          {ad.hasCompleters ? completerChips : <span className={styles.nocomp}>no completers — plain playback</span>}
        </div>
      )}

      {active && run && <Stepper run={run} hasCompleters={ad.hasCompleters} />}
    </article>
  );
}

function Stepper({ run, hasCompleters }: { run: NonNullable<BenchController['run']>; hasCompleters: boolean }): JSX.Element {
  const done = run.phase === 'done';
  return (
    <div className={styles.stepper}>
      <span className={styles.stepOk}>● trigger {run.firedAt}</span>
      <span className={styles.stepSep}>──</span>
      <span className={styles.stepOk}>● ad playing</span>
      {hasCompleters && (
        <>
          <span className={styles.stepSep}>──</span>
          <span className={done ? styles.stepOk : styles.stepWarn}>{done ? '● completer' : '◐ completer…'}</span>
        </>
      )}
      <span className={styles.stepSep}>──</span>
      <span className={done ? styles.stepOk : styles.stepIdle}>{done ? '● done' : '○ done'}</span>
    </div>
  );
}
