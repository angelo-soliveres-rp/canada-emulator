import { useCallback, useMemo, useState } from 'react';
import type { LogEntry } from '../useEmulator';

export type UiMode = 'control' | 'split' | 'logs';
const MODE_KEY = 'r6ca.uiMode';

/** Layout mode (Control / Split / Logs), persisted across launches. */
export function useUiMode(): [UiMode, (m: UiMode) => void] {
  const [mode, setMode] = useState<UiMode>(() => {
    const v = (() => {
      try {
        return localStorage.getItem(MODE_KEY);
      } catch {
        return null;
      }
    })();
    return v === 'control' || v === 'split' || v === 'logs' ? v : 'control';
  });
  const set = useCallback((m: UiMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // ignore storage failures
    }
  }, []);
  return [mode, set];
}

export type ChannelFilter = 'all' | 'vj' | 'pole' | 'sys';

export interface LogView {
  filter: ChannelFilter;
  setFilter: (f: ChannelFilter) => void;
  query: string;
  setQuery: (q: string) => void;
  counts: Record<ChannelFilter, number>;
  /** Oldest -> newest (bottom-anchored, terminal-style). */
  visible: LogEntry[];
}

/** View-only filtering/search over the wire log; never mutates the source log. */
export function useLogView(log: LogEntry[]): LogView {
  const [filter, setFilter] = useState<ChannelFilter>('all');
  const [query, setQuery] = useState('');

  const counts = useMemo<Record<ChannelFilter, number>>(() => {
    const c: Record<ChannelFilter, number> = { all: log.length, vj: 0, pole: 0, sys: 0 };
    for (const l of log) c[l.channel] += 1;
    return c;
  }, [log]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: LogEntry[] = [];
    // log is newest-first; walk backwards to emit oldest-first for the view.
    for (let i = log.length - 1; i >= 0; i--) {
      const l = log[i];
      if (filter !== 'all' && l.channel !== filter) continue;
      if (q && !l.text.toLowerCase().includes(q)) continue;
      out.push(l);
    }
    return out;
  }, [log, filter, query]);

  return { filter, setFilter, query, setQuery, counts, visible };
}
