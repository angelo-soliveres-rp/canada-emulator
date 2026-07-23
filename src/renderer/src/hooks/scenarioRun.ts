import { useCallback, useEffect, useRef, useState } from 'react';
import { ScenarioRunner, type RunState, type RunnerPort } from '../../../core/scenarioRunner';
import { portsForRegisterType, isUsRegisterType, type RegisterType } from '../../../core/posTypes';
import type { Scenario } from '../../../core/scenario';
import type { useEmulator } from '../useEmulator';

type Emu = ReturnType<typeof useEmulator>;

export const SPEED_OPTIONS = [1, 2, 4, 8] as const;

export interface ScenarioRunController {
  state: RunState;
  speed: number;
  setSpeed: (speed: number) => void;
  run: (scenario: Scenario) => void;
  stepOnce: (scenario: Scenario) => void;
  resume: () => void;
  abort: () => void;
}

const IDLE: RunState = {
  scenarioId: null,
  phase: 'idle',
  stepIndex: 0,
  steps: [],
  outcome: null,
  failedStep: null,
  stepMode: false,
};

/**
 * Adapts useEmulator to the core ScenarioRunner. The port reads through a ref
 * so the async run loop always sees the current session (the emulator rebuilds
 * its session when the register type changes). Runs auto-switch the register
 * type/ports to the scenario's before starting.
 */
export function useScenarioRunner(
  e: Emu,
  onFinished?: (scenarioId: string, final: RunState) => void,
): ScenarioRunController {
  const eRef = useRef(e);
  eRef.current = e;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const [state, setState] = useState<RunState>(IDLE);
  const [speed, setSpeedState] = useState(1);

  const runnerRef = useRef<ScenarioRunner | null>(null);
  if (runnerRef.current === null) {
    const port: RunnerPort = {
      registerType: () => eRef.current.config.registerType,
      performAction: (action) => eRef.current.performAction(action),
      getSnapshot: () => eRef.current.getSnapshot(),
      onInject: (cb) => eRef.current.onInjectEvent(cb),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    };
    runnerRef.current = new ScenarioRunner(port, setState);
  }
  const runner = runnerRef.current;

  // Resolves the pending register-type switch once React has rebuilt the
  // session for the scenario's register type.
  const typeWaitRef = useRef<{ type: RegisterType; resolve: () => void } | null>(null);
  useEffect(() => {
    if (typeWaitRef.current && e.config.registerType === typeWaitRef.current.type) {
      typeWaitRef.current.resolve();
      typeWaitRef.current = null;
    }
  }, [e.config.registerType]);

  const ensureScenarioSetup = useCallback(async (scenario: Scenario): Promise<void> => {
    const current = eRef.current;
    if (current.config.registerType !== scenario.registerType) {
      current.setConfig({
        ...current.config,
        registerType: scenario.registerType,
        ...portsForRegisterType(scenario.registerType),
      });
      await new Promise<void>((resolve) => {
        typeWaitRef.current = { type: scenario.registerType, resolve };
      });
    }
    if (scenario.locale && !isUsRegisterType(scenario.registerType)) {
      eRef.current.setLocale(scenario.locale);
    }
  }, []);

  // Guards against attaching onFinished twice when step() returns the same
  // in-flight run promise.
  const currentPromiseRef = useRef<Promise<RunState> | null>(null);
  const track = useCallback((scenario: Scenario, promise: Promise<RunState>): void => {
    if (promise === currentPromiseRef.current) return;
    currentPromiseRef.current = promise;
    void promise.then((final) => {
      if (final.outcome) onFinishedRef.current?.(scenario.id, final);
    });
  }, []);

  const run = useCallback(
    (scenario: Scenario) => {
      void (async () => {
        await ensureScenarioSetup(scenario);
        track(scenario, runner.start(scenario));
      })();
    },
    [ensureScenarioSetup, runner, track],
  );

  const stepOnce = useCallback(
    (scenario: Scenario) => {
      void (async () => {
        await ensureScenarioSetup(scenario);
        track(scenario, runner.step(scenario));
      })();
    },
    [ensureScenarioSetup, runner, track],
  );

  const setSpeed = useCallback(
    (next: number) => {
      runner.setSpeed(next);
      setSpeedState(runner.getSpeed());
    },
    [runner],
  );

  return {
    state,
    speed,
    setSpeed,
    run,
    stepOnce,
    resume: useCallback(() => runner.resume(), [runner]),
    abort: useCallback(() => runner.abort(), [runner]),
  };
}
