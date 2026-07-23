import { useEffect, useRef, useState } from 'react';
import type { useEmulator } from '../useEmulator';
import { useLogView, type ChannelFilter } from '../hooks/ui';
import { CopyIcon, PauseIcon, PlayIcon, SearchIcon, TrashIcon } from '../icons';
import styles from './LogDock.module.css';

type Emu = ReturnType<typeof useEmulator>;

const DOCK_KEY = 'r6ca.logDockOpen';
const TAIL_LINES = 4;

const FILTERS: ReadonlyArray<{ key: ChannelFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'vj', label: 'VJ' },
  { key: 'pole', label: 'Pole' },
  { key: 'scanner', label: 'Scan' },
  { key: 'sys', label: 'Sys' },
];

function readOpen(): boolean {
  try {
    return localStorage.getItem(DOCK_KEY) === '1';
  } catch {
    return false;
  }
}

export function LogDock({ e }: { e: Emu }): JSX.Element {
  const view = useLogView(e.log);
  const [open, setOpen] = useState(readOpen);
  const [autoscroll, setAutoscroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const toggle = (): void => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(DOCK_KEY, next ? '1' : '0');
      } catch {
        // ignore storage failures
      }
      return next;
    });
  };

  // Keep pinned to the newest line while expanded with autoscroll on.
  useEffect(() => {
    if (open && autoscroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [view.visible, open, autoscroll]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== autoscroll) setAutoscroll(atBottom);
  };

  const copyAll = (): void => {
    const text = view.visible.map((l) => `${l.at} ${l.channel.toUpperCase()} ${l.text}`).join('\n');
    void navigator.clipboard?.writeText(text);
  };

  const tail = view.visible.slice(-TAIL_LINES);

  return (
    <section className={`${styles.dock} ${open ? styles.open : ''}`} aria-label="Wire log">
      <div className={styles.bar}>
        <span className={styles.label}>WIRE LOG</span>
        <div className={styles.filters} role="tablist" aria-label="Channel filter">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={view.filter === f.key}
              className={view.filter === f.key ? styles.filterOn : styles.filter}
              onClick={() => view.setFilter(f.key)}
            >
              {f.label}
              {open && <span className={styles.count}>{view.counts[f.key]}</span>}
            </button>
          ))}
        </div>
        {open && (
          <>
            <label className={styles.search}>
              <SearchIcon size={13} />
              <input
                value={view.query}
                placeholder="filter…"
                spellCheck={false}
                aria-label="Filter log"
                onChange={(ev) => view.setQuery(ev.target.value)}
              />
            </label>
            <button
              className={autoscroll ? styles.toolOn : styles.tool}
              onClick={() => setAutoscroll((v) => !v)}
              title={autoscroll ? 'Autoscroll on — click to pause' : 'Autoscroll off — click to resume'}
              aria-label="Toggle autoscroll"
            >
              {autoscroll ? <PauseIcon size={13} /> : <PlayIcon size={13} />}
            </button>
            <button className={styles.tool} onClick={copyAll} title="Copy visible lines" aria-label="Copy log">
              <CopyIcon size={13} />
            </button>
            <button className={styles.tool} onClick={e.clearLog} title="Clear log" aria-label="Clear log">
              <TrashIcon size={13} />
            </button>
          </>
        )}
        <span className={styles.spacer} />
        <span className={styles.events}>{e.log.length} events</span>
        <button className={styles.expand} onClick={toggle}>
          {open ? 'collapse ▾' : 'expand ▴'}
        </button>
      </div>

      {open ? (
        <div className={styles.lines} ref={scrollRef} onScroll={onScroll}>
          {view.visible.length === 0 ? (
            <div className={styles.emptyBig}>
              {e.log.length === 0 ? 'Nothing sent yet — connect and ring up an item.' : 'No lines match the filter.'}
            </div>
          ) : (
            view.visible.map((l) => (
              <div key={l.id} className={styles.row}>
                <span className={styles.time}>{l.at}</span>
                <span className={`${styles.tag} ${styles[l.channel]}`}>{l.channel.toUpperCase()}</span>
                <code className={styles.textFull}>{l.text}</code>
              </div>
            ))
          )}
        </div>
      ) : (
        <button className={styles.tail} onClick={toggle} title="Expand the wire log">
          {tail.length === 0 ? (
            <span className={styles.empty}>Nothing sent yet — connect and ring up an item.</span>
          ) : (
            tail.map((l) => (
              <span key={l.id} className={styles.row}>
                <span className={styles.time}>{l.at}</span>
                <span className={`${styles.tag} ${styles[l.channel]}`}>{l.channel.toUpperCase()}</span>
                <code className={styles.text}>{l.text}</code>
              </span>
            ))
          )}
        </button>
      )}
    </section>
  );
}
