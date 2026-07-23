import { useCallback, useState } from 'react';
import { normalizeScenario, type Scenario } from '../../../core/scenario';

const SCENARIOS_KEY = 'r6ca.scenarios';
const RESULTS_KEY = 'r6ca.scenarioResults';

export interface ScenarioResult {
  outcome: 'pass' | 'fail';
  failedStep: number | null;
  at: number;
}

export interface ScenarioStoreController {
  scenarios: Scenario[];
  results: Record<string, ScenarioResult>;
  save: (scenario: Scenario) => void;
  remove: (id: string) => void;
  recordResult: (id: string, result: ScenarioResult) => void;
  /** Validate + add a scenario from pasted JSON. */
  importScenario: (json: string) => { ok: true; id: string } | { ok: false; error: string };
  exportScenario: (id: string) => string | null;
}

function readScenarios(): Scenario[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SCENARIOS_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    const out: Scenario[] = [];
    for (const raw of parsed) {
      const res = normalizeScenario(raw);
      if (res.ok) out.push(res.scenario);
    }
    return out;
  } catch {
    return [];
  }
}

function readResults(): Record<string, ScenarioResult> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RESULTS_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, ScenarioResult>;
    }
  } catch {
    // corrupt/absent → start fresh
  }
  return {};
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage failures (private mode etc.)
  }
}

/** Scenario library + per-scenario last run result, persisted in localStorage. */
export function useScenarioStore(): ScenarioStoreController {
  const [scenarios, setScenarios] = useState<Scenario[]>(readScenarios);
  const [results, setResults] = useState<Record<string, ScenarioResult>>(readResults);

  const save = useCallback((scenario: Scenario) => {
    setScenarios((prev) => {
      const next = prev.some((s) => s.id === scenario.id)
        ? prev.map((s) => (s.id === scenario.id ? scenario : s))
        : [...prev, scenario];
      persist(SCENARIOS_KEY, next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setScenarios((prev) => {
      const next = prev.filter((s) => s.id !== id);
      persist(SCENARIOS_KEY, next);
      return next;
    });
    setResults((prev) => {
      const { [id]: _removed, ...rest } = prev;
      persist(RESULTS_KEY, rest);
      return rest;
    });
  }, []);

  const recordResult = useCallback((id: string, result: ScenarioResult) => {
    setResults((prev) => {
      const next = { ...prev, [id]: result };
      persist(RESULTS_KEY, next);
      return next;
    });
  }, []);

  const importScenario = useCallback(
    (json: string): { ok: true; id: string } | { ok: false; error: string } => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return { ok: false, error: 'not valid JSON' };
      }
      const res = normalizeScenario(parsed);
      if (!res.ok) return { ok: false, error: res.error };
      save(res.scenario);
      return { ok: true, id: res.scenario.id };
    },
    [save],
  );

  const exportScenario = useCallback(
    (id: string): string | null => {
      const scenario = scenarios.find((s) => s.id === id);
      return scenario ? JSON.stringify(scenario, null, 2) : null;
    },
    [scenarios],
  );

  return { scenarios, results, save, remove, recordResult, importScenario, exportScenario };
}
