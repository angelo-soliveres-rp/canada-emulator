/**
 * ScenarioRunner — executes a Scenario against a live emulator through an
 * injected port, grading each step with scenarioEngine.
 *
 * The port abstracts everything effectful (perform an action, subscribe to
 * player injects, sleep, clock) so the run loop is fully unit-testable; the
 * renderer hook adapts useEmulator to a RunnerPort. State updates flow out of
 * `onUpdate` as immutable snapshots.
 *
 * Semantics:
 *   - a dirty lane (open basket) is voided before the first step so replays
 *     always start from a fresh basket;
 *   - the run stops at the first failing step, the rest are marked skipped;
 *   - `wait` steps settle on a matching player inject or time out;
 *   - `assert` steps grade wire expectations against the WHOLE run tape, and
 *     basket assertions against the pre-tender snapshot once the sale closed;
 *   - recorded delays replay scaled by speed and capped at
 *     MAX_REPLAY_DELAY_MS (recorded gaps can be minutes of human idling);
 *   - step mode executes one step per step() call, with no replay delays.
 */
import type { RegisterType } from './posTypes';
import type { SessionSnapshot } from './RegisterSession';
import { DEFAULT_WAIT_TIMEOUT_MS, type Scenario, type ScenarioAction, type ScenarioStep, type WaitStep } from './scenario';
import {
  evaluateBasketAssertion,
  evaluateExpectations,
  type ObservedLine,
  type StepStatus,
} from './scenarioEngine';

/** Longest pause replayed between steps at 1× — recorded gaps can be minutes. */
export const MAX_REPLAY_DELAY_MS = 4000;

export interface InjectEvent {
  barcode: string;
  quantity: number;
  lines: ObservedLine[];
}

/** Everything effectful the runner needs, adapted from useEmulator (or faked in tests). */
export interface RunnerPort {
  registerType(): RegisterType;
  performAction(action: ScenarioAction): ObservedLine[];
  getSnapshot(): SessionSnapshot;
  onInject(cb: (e: InjectEvent) => void): () => void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface StepRun {
  status: StepStatus;
  detail: string | null;
  lines: ObservedLine[];
  durationMs: number | null;
}

export type RunPhase = 'idle' | 'running' | 'done';
export type RunOutcome = 'pass' | 'fail' | 'aborted';

export interface RunState {
  scenarioId: string | null;
  phase: RunPhase;
  /** Index of the step being executed (or about to execute). */
  stepIndex: number;
  steps: StepRun[];
  outcome: RunOutcome | null;
  failedStep: number | null;
  stepMode: boolean;
}

const IDLE_STATE: RunState = {
  scenarioId: null,
  phase: 'idle',
  stepIndex: 0,
  steps: [],
  outcome: null,
  failedStep: null,
  stepMode: false,
};

function freshSteps(scenario: Scenario): StepRun[] {
  return scenario.steps.map(() => ({ status: 'pending', detail: null, lines: [], durationMs: null }));
}

type WaitOutcome = { kind: 'inject'; event: InjectEvent } | { kind: 'timeout' } | { kind: 'aborted' };

export class ScenarioRunner {
  private state: RunState = IDLE_STATE;
  private runId = 0;
  private speed = 1;
  private aborted = false;
  private stepMode = false;
  private pendingStepSignals = 0;
  private stepWaiter: (() => void) | null = null;
  private abortSettlers: (() => void)[] = [];
  private lastSaleSnapshot: SessionSnapshot | null = null;
  private runTape: ObservedLine[] = [];
  private current: Promise<RunState> | null = null;

  constructor(
    private readonly port: RunnerPort,
    private readonly onUpdate: (state: RunState) => void,
  ) {}

  getState(): RunState {
    return this.state;
  }

  setSpeed(speed: number): void {
    this.speed = Math.min(1000, Math.max(0.25, speed));
  }

  getSpeed(): number {
    return this.speed;
  }

  /** Start (or restart) a full run. Resolves with the final state. */
  start(scenario: Scenario, options: { stepMode?: boolean } = {}): Promise<RunState> {
    const runId = ++this.runId;
    this.settleAbortWaiters();
    this.aborted = false;
    this.stepMode = options.stepMode ?? false;
    this.pendingStepSignals = 0;
    this.lastSaleSnapshot = null;
    this.runTape = [];
    this.setState({
      scenarioId: scenario.id,
      phase: 'running',
      stepIndex: 0,
      steps: freshSteps(scenario),
      outcome: null,
      failedStep: null,
      stepMode: this.stepMode,
    });
    this.current = this.execute(scenario, runId);
    return this.current;
  }

  /**
   * Execute one step: starts the scenario in step mode if idle, otherwise
   * releases the loop for exactly one more step.
   */
  step(scenario: Scenario): Promise<RunState> {
    if (this.state.phase === 'running' && this.state.scenarioId === scenario.id && this.current) {
      this.stepMode = true;
      this.setState({ ...this.state, stepMode: true });
      this.releaseStepSignal();
      return this.current;
    }
    const promise = this.start(scenario, { stepMode: true });
    this.releaseStepSignal();
    return promise;
  }

  /** Leave step mode and let the run continue on its own. */
  resume(): void {
    if (this.state.phase !== 'running') return;
    this.stepMode = false;
    this.setState({ ...this.state, stepMode: false });
    this.releaseStepSignal();
  }

  abort(): void {
    if (this.state.phase !== 'running') return;
    this.aborted = true;
    this.releaseStepSignal();
    this.settleAbortWaiters();
  }

  private setState(next: RunState): void {
    this.state = next;
    this.onUpdate(next);
  }

  private patchStep(index: number, patch: Partial<StepRun>): void {
    const steps = this.state.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    this.setState({ ...this.state, steps });
  }

  private releaseStepSignal(): void {
    if (this.stepWaiter) {
      const release = this.stepWaiter;
      this.stepWaiter = null;
      release();
    } else {
      this.pendingStepSignals += 1;
    }
  }

  private awaitStepSignal(): Promise<void> {
    if (this.pendingStepSignals > 0) {
      this.pendingStepSignals -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.stepWaiter = resolve;
    });
  }

  private settleAbortWaiters(): void {
    const settlers = this.abortSettlers;
    this.abortSettlers = [];
    for (const settle of settlers) settle();
  }

  /** Sleep that also wakes on abort; returns whether the run should continue. */
  private async sleepUnlessAborted(ms: number): Promise<boolean> {
    if (this.aborted) return false;
    if (ms <= 0) return true;
    await new Promise<void>((resolve) => {
      this.abortSettlers.push(resolve);
      void this.port.sleep(ms).then(resolve);
    });
    return !this.aborted;
  }

  private waitForInject(step: WaitStep): Promise<WaitOutcome> {
    const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    return new Promise<WaitOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: WaitOutcome): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve(outcome);
      };
      const unsubscribe = this.port.onInject((event) => {
        if (step.barcode && event.barcode !== step.barcode) return;
        settle({ kind: 'inject', event });
      });
      this.abortSettlers.push(() => settle({ kind: 'aborted' }));
      void this.port.sleep(timeoutMs).then(() => settle({ kind: 'timeout' }));
    });
  }

  private finish(scenario: Scenario, outcome: RunOutcome, failedStep: number | null, runId: number): RunState {
    const steps = this.state.steps.map((s) =>
      s.status === 'pending' || s.status === 'running' ? { ...s, status: 'skipped' as StepStatus } : s,
    );
    const final: RunState = { ...this.state, steps, phase: 'done', outcome, failedStep, scenarioId: scenario.id };
    // A restarted run owns the live state now — a stale loop resolves its own
    // promise with its outcome but must not stamp over the new run's state.
    if (runId === this.runId) this.setState(final);
    return final;
  }

  /** The basket snapshot an assert step grades: pre-tender once the sale closed. */
  private snapshotForAssert(): SessionSnapshot {
    const live = this.port.getSnapshot();
    if (!live.started && this.lastSaleSnapshot) return this.lastSaleSnapshot;
    return live;
  }

  private async execute(scenario: Scenario, runId: number): Promise<RunState> {
    // A half-rung basket from manual use would shift every line number and
    // total in the replay — clear it first.
    if (this.port.getSnapshot().started) this.port.performAction({ kind: 'voidTicket' });

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      if (this.stepMode) {
        await this.awaitStepSignal();
      } else {
        const delay = Math.min(step.delayMs ?? 0, MAX_REPLAY_DELAY_MS) / this.speed;
        await this.sleepUnlessAborted(delay);
      }
      if (this.aborted || runId !== this.runId) return this.finish(scenario, 'aborted', null, runId);

      this.setState({ ...this.state, stepIndex: i });
      this.patchStep(i, { status: 'running' });
      const startedAt = this.port.now();

      if (this.port.registerType() !== scenario.registerType) {
        this.patchStep(i, {
          status: 'fail',
          detail: `register type changed — scenario needs ${scenario.registerType}`,
          durationMs: this.port.now() - startedAt,
        });
        return this.finish(scenario, 'fail', i, runId);
      }

      const result = await this.executeStep(step);
      if (this.aborted || runId !== this.runId) return this.finish(scenario, 'aborted', null, runId);

      this.runTape = [...this.runTape, ...result.lines];
      this.patchStep(i, {
        status: result.pass ? 'pass' : 'fail',
        detail: result.detail,
        lines: result.lines,
        durationMs: this.port.now() - startedAt,
      });
      if (!result.pass) return this.finish(scenario, 'fail', i, runId);
    }
    return this.finish(scenario, 'pass', null, runId);
  }

  private async executeStep(step: ScenarioStep): Promise<{ pass: boolean; detail: string | null; lines: ObservedLine[] }> {
    switch (step.kind) {
      case 'act': {
        if (step.action.kind === 'tender' || step.action.kind === 'voidTicket') {
          this.lastSaleSnapshot = this.port.getSnapshot();
        }
        const lines = this.port.performAction(step.action);
        const evaluation = evaluateExpectations(step.expect, lines);
        return {
          pass: evaluation.pass,
          detail: evaluation.pass ? null : `expectation ${(evaluation.failedAt ?? 0) + 1} not matched`,
          lines,
        };
      }
      case 'wait': {
        const outcome = await this.waitForInject(step);
        if (outcome.kind === 'aborted') return { pass: false, detail: 'aborted', lines: [] };
        if (outcome.kind === 'timeout') {
          const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
          return { pass: false, detail: `timeout — no player inject within ${timeoutMs}ms`, lines: [] };
        }
        const evaluation = evaluateExpectations(step.expect, outcome.event.lines);
        return {
          pass: evaluation.pass,
          detail: evaluation.pass ? null : `inject received but expectation ${(evaluation.failedAt ?? 0) + 1} not matched`,
          lines: outcome.event.lines,
        };
      }
      case 'assert': {
        const failures: string[] = [];
        const wireEval = evaluateExpectations(step.expect, this.runTape);
        if (!wireEval.pass) failures.push(`wire expectation ${(wireEval.failedAt ?? 0) + 1} not found in run tape`);
        if (step.basket) {
          const basketEval = evaluateBasketAssertion(step.basket, this.snapshotForAssert());
          failures.push(...basketEval.failures);
        }
        return { pass: failures.length === 0, detail: failures.length > 0 ? failures.join('; ') : null, lines: [] };
      }
    }
  }
}
