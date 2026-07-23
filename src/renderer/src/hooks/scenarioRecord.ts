import { useCallback, useEffect, useRef, useState } from 'react';
import type { Scenario } from '../../../core/scenario';
import { foldRecording, type RecordedEvent } from '../../../core/scenarioRecorder';
import type { useEmulator } from '../useEmulator';

type Emu = ReturnType<typeof useEmulator>;

/** Rolling capture cap — a manual session, not an archive. */
const MAX_RECORDED_EVENTS = 200;

export interface ScenarioRecordingController {
  /** Captured events since the last clear/save. */
  count: number;
  clear: () => void;
  /** Fold the captured session into a scenario (does not store it). */
  saveAs: (name: string) => Scenario | null;
}

/**
 * Always-on manual session recorder: every bench action and player inject is
 * captured (except those performed by a scenario run), so "Save as scenario"
 * can turn what the user just did into a replayable script.
 */
export function useScenarioRecording(e: Emu, isRunnerActive: boolean): ScenarioRecordingController {
  const eventsRef = useRef<RecordedEvent[]>([]);
  const [count, setCount] = useState(0);

  const runnerActiveRef = useRef(isRunnerActive);
  runnerActiveRef.current = isRunnerActive;

  const push = useCallback((event: RecordedEvent) => {
    eventsRef.current = [...eventsRef.current, event].slice(-MAX_RECORDED_EVENTS);
    setCount(eventsRef.current.length);
  }, []);

  useEffect(() => {
    const offAction = e.onAction((ev) => {
      if (runnerActiveRef.current) return;
      push({ type: 'action', at: ev.at, action: ev.action, wire: ev.lines });
    });
    const offInject = e.onInjectEvent((ev) => {
      if (runnerActiveRef.current) return;
      push({ type: 'inject', at: ev.at, barcode: ev.barcode, quantity: ev.quantity, wire: ev.lines });
    });
    return () => {
      offAction();
      offInject();
    };
  }, [e.onAction, e.onInjectEvent, push]);

  const clear = useCallback(() => {
    eventsRef.current = [];
    setCount(0);
  }, []);

  const eRef = useRef(e);
  eRef.current = e;
  const saveAs = useCallback(
    (name: string): Scenario | null => {
      if (eventsRef.current.length === 0 || !name.trim()) return null;
      const current = eRef.current;
      const scenario = foldRecording(eventsRef.current, {
        name: name.trim(),
        registerType: current.config.registerType,
        locale: current.snapshot.locale,
      });
      eventsRef.current = [];
      setCount(0);
      return scenario;
    },
    [],
  );

  return { count, clear, saveAs };
}
