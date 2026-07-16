import { useEffect, useRef, useState } from 'react';
import type { useEmulator } from '../useEmulator';
import { useLogView, type ChannelFilter } from '../hooks/ui';
import { ChevronUpIcon, CopyIcon, PauseIcon, PlayIcon, SearchIcon, TrashIcon } from '../icons';
import styles from './WireLog.module.css';

type Emu = ReturnType<typeof useEmulator>;

const FILTERS: ReadonlyArray<{ key: ChannelFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'vj', label: 'VJ' },
  { key: 'pole', label: 'Pole' },
  { key: 'scanner', label: 'Scan' },
  { key: 'sys', label: 'Sys' },
];

export function WireLog({ e, peek, onExpand }: { e: Emu; peek: boolean; onExpand: () => void }): JSX.Element {
  const view = useLogView(e.log);
  const [autoscroll, setAutoscroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep pinned to the newest line while autoscroll is on.
  useEffect(() => {
    if (autoscroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [view.visible, autoscroll]);

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

  if (peek) {
    const latest = e.log[0];
    return (
      <button className={styles.peek} onClick={onExpand} title="Open the wire log (switch to Logs mode)">
        <ChevronUpIcon size={14} />
        {latest ? (
          <>
            <span className={`${styles.peekTag} ${styles[latest.channel]}`}>{latest.channel.toUpperCase()}</span>
            <code className={styles.peekText}>{latest.text}</code>
          </>
        ) : (
          <span className={styles.peekIdle}>Wire log — nothing sent yet</span>
        )}
        <span className={styles.peekCount}>{e.log.length} events</span>
      </button>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <h3 className={styles.title}>Wire Log</h3>
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
              <span className={styles.count}>{view.counts[f.key]}</span>
            </button>
          ))}
        </div>
        <span className={styles.spacer} />
        <label className={styles.search}>
          <SearchIcon size={14} />
          <input value={view.query} placeholder="filter…" spellCheck={false} onChange={(ev) => view.setQuery(ev.target.value)} aria-label="Filter log" />
        </label>
        <button
          className={autoscroll ? styles.toolOn : styles.tool}
          onClick={() => setAutoscroll((v) => !v)}
          title={autoscroll ? 'Autoscroll on — click to pause' : 'Autoscroll off — click to resume'}
          aria-label="Toggle autoscroll"
        >
          {autoscroll ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
        </button>
        <button className={styles.tool} onClick={copyAll} title="Copy visible lines" aria-label="Copy log">
          <CopyIcon size={14} />
        </button>
        <button className={styles.tool} onClick={e.clearLog} title="Clear log" aria-label="Clear log">
          <TrashIcon size={14} />
        </button>
      </div>

      <div className={styles.lines} ref={scrollRef} onScroll={onScroll}>
        {view.visible.length === 0 ? (
          <div className={styles.empty}>{e.log.length === 0 ? 'Nothing sent yet — connect and ring up an item.' : 'No lines match the filter.'}</div>
        ) : (
          view.visible.map((l) => (
            <div key={l.id} className={styles.row}>
              <span className={styles.time}>{l.at}</span>
              <span className={`${styles.tag} ${styles[l.channel]}`}>{l.channel.toUpperCase()}</span>
              <code className={styles.text}>{l.text}</code>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
