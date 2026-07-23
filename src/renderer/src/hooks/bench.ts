import { useCallback, useEffect, useRef, useState } from 'react';
import type { useEmulator } from '../useEmulator';

type Emu = ReturnType<typeof useEmulator>;

const LAST_RUN_KEY = 'r6ca.adLastRun';

export type BenchPhase = 'awaiting' | 'done';

/** The live trigger→completer run on the bench — at most one, the last-fired ad. */
export interface BenchRun {
  adId: string;
  /** Trigger codes fired during this run (their chips show the ✓ state). */
  firedCodes: ReadonlySet<string>;
  /** Wall-clock time the trigger fired, shown in the lifecycle stepper. */
  firedAt: string;
  phase: BenchPhase;
}

export interface BenchController {
  run: BenchRun | null;
  /** Last trigger-fire time per ad id (epoch ms), persisted across launches. */
  lastRun: Record<string, number>;
  fireTrigger: (ad: { id: string; code: string; description?: string; hasCompleters: boolean }) => void;
  fireCompleter: (code: string, description?: string) => void;
}

function readLastRun(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAST_RUN_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    // corrupt/absent → start fresh
  }
  return {};
}

/**
 * Bench run lifecycle: a trigger scan starts a run on that ad (replacing any
 * prior run); the run completes when the player injects a completer, when a
 * completer chip is clicked, or resets entirely when the transaction ends.
 */
export function useBenchRun(e: Emu): BenchController {
  const [run, setRun] = useState<BenchRun | null>(null);
  const [lastRun, setLastRun] = useState<Record<string, number>>(readLastRun);

  const fireTrigger = useCallback(
    (ad: { id: string; code: string; description?: string; hasCompleters: boolean }) => {
      e.scan(ad.code, ad.description);
      const firedAt = new Date().toLocaleTimeString();
      setRun((prev) => ({
        adId: ad.id,
        firedCodes: prev?.adId === ad.id ? new Set([...prev.firedCodes, ad.code]) : new Set([ad.code]),
        firedAt,
        phase: ad.hasCompleters ? 'awaiting' : 'done',
      }));
      setLastRun((prev) => {
        const next = { ...prev, [ad.id]: Date.now() };
        try {
          localStorage.setItem(LAST_RUN_KEY, JSON.stringify(next));
        } catch {
          // ignore storage failures
        }
        return next;
      });
    },
    [e],
  );

  const fireCompleter = useCallback(
    (code: string, description?: string) => {
      e.scan(code, description);
      setRun((prev) => (prev ? { ...prev, phase: 'done' } : prev));
    },
    [e],
  );

  // The player acted on the offer (completer inject) → the run is complete.
  const prevInject = useRef(e.injectSeq);
  useEffect(() => {
    if (e.injectSeq === prevInject.current) return;
    prevInject.current = e.injectSeq;
    setRun((prev) => (prev && prev.phase === 'awaiting' ? { ...prev, phase: 'done' } : prev));
  }, [e.injectSeq]);

  // Transaction ended (tender / void ticket bumps tx) → reset the bench run.
  const tx = e.snapshot.tx;
  const prevTx = useRef(tx);
  useEffect(() => {
    if (tx === prevTx.current) return;
    prevTx.current = tx;
    setRun(null);
  }, [tx]);

  return { run, lastRun, fireTrigger, fireCompleter };
}
