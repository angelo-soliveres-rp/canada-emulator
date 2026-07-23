import { describe, it, expect } from 'vitest';
import { RegisterSession, type WireMessage } from './RegisterSession';
import type { RegisterType } from './posTypes';
import type { Scenario, ScenarioAction, ScenarioStep } from './scenario';
import type { ObservedLine } from './scenarioEngine';
import { ScenarioRunner, MAX_REPLAY_DELAY_MS, type RunnerPort, type RunState } from './scenarioRunner';

const toLines = (messages: WireMessage[]): ObservedLine[] => messages.map((m) => ({ channel: m.channel, text: m.data }));

function perform(session: RegisterSession, action: ScenarioAction): ObservedLine[] {
  switch (action.kind) {
    case 'ring':
    case 'scan':
      return toLines(
        session.addItem({
          code: action.code,
          description: (action.kind === 'ring' ? action.description : action.description) ?? `UPC ${action.code}`,
          priceCents: action.kind === 'ring' ? action.priceCents ?? 100 : 100,
          quantity: action.kind === 'ring' ? action.quantity : undefined,
        }),
      );
    case 'loyalty':
      return toLines(session.loyalty(action.card));
    case 'voidLine':
      return toLines(session.voidLine(action.lineNumber));
    case 'setQuantity':
      return toLines(session.setQuantity(action.lineNumber, action.quantity));
    case 'setPrice':
      return toLines(session.setPrice(action.lineNumber, action.priceCents));
    case 'tender':
      return toLines(session.tender(action.tender, action.amountCents));
    case 'voidTicket':
      return toLines(session.voidTicket());
  }
}

interface Harness {
  runner: ScenarioRunner;
  session: RegisterSession;
  updates: RunState[];
  sleeps: { ms: number; resolve: () => void }[];
  emitInject: (barcode: string, lines: ObservedLine[]) => void;
  setRegisterType: (t: RegisterType) => void;
  flush: () => Promise<void>;
}

function makeHarness(registerType: RegisterType = 'radiant6-us', taxRateBps = 0): Harness {
  const session = new RegisterSession({ registerType, taxRateBps, clock: () => new Date('2026-07-17T14:00:00') });
  let currentType = registerType;
  const injectSubs = new Set<(e: { barcode: string; quantity: number; lines: ObservedLine[] }) => void>();
  const sleeps: { ms: number; resolve: () => void }[] = [];
  const updates: RunState[] = [];
  let t = 0;
  const port: RunnerPort = {
    registerType: () => currentType,
    performAction: (a) => perform(session, a),
    getSnapshot: () => session.snapshot(),
    onInject: (cb) => {
      injectSubs.add(cb);
      return () => injectSubs.delete(cb);
    },
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        sleeps.push({ ms, resolve });
      }),
    now: () => (t += 10),
  };
  const runner = new ScenarioRunner(port, (s) => updates.push(s));
  return {
    runner,
    session,
    updates,
    sleeps,
    emitInject: (barcode, lines) => {
      for (const cb of [...injectSubs]) cb({ barcode, quantity: 1, lines });
    },
    setRegisterType: (next) => {
      currentType = next;
    },
    flush: () => new Promise((r) => setTimeout(r, 0)),
  };
}

function scenario(steps: ScenarioStep[], registerType: RegisterType = 'radiant6-us'): Scenario {
  return { version: 1, id: 'test', name: 'Test', registerType, steps };
}

const ringStep = (id: string, code: string, priceCents: number, description: string): ScenarioStep => ({
  kind: 'act',
  id,
  label: description,
  action: { kind: 'ring', code, description, priceCents },
  expect: [{ channel: 'vj', fields: { EventId: '1011', Description: description } }],
});

describe('ScenarioRunner', () => {
  it('runs act steps green and attributes wire lines per step', async () => {
    const h = makeHarness();
    const final = await h.runner.start(scenario([ringStep('s1', 'a', 100, 'A'), ringStep('s2', 'b', 199, 'B')]));
    expect(final.outcome).toBe('pass');
    expect(final.phase).toBe('done');
    expect(final.steps.map((s) => s.status)).toEqual(['pass', 'pass']);
    expect(final.steps[0].lines.some((l) => l.text.includes('Description=A'))).toBe(true);
    expect(final.steps[1].lines.some((l) => l.text.includes('Description=B'))).toBe(true);
  });

  it('fails the step whose expectations never match and skips the rest', async () => {
    const h = makeHarness();
    const bad: ScenarioStep = {
      kind: 'act',
      id: 's2',
      label: 'wrong',
      action: { kind: 'ring', code: 'b', description: 'B', priceCents: 100 },
      expect: [{ channel: 'vj', fields: { EventId: '1024' } }],
    };
    const final = await h.runner.start(scenario([ringStep('s1', 'a', 100, 'A'), bad, ringStep('s3', 'c', 100, 'C')]));
    expect(final.outcome).toBe('fail');
    expect(final.failedStep).toBe(1);
    expect(final.steps.map((s) => s.status)).toEqual(['pass', 'fail', 'skipped']);
  });

  it('wait step passes when a matching inject arrives and grades its wire', async () => {
    const h = makeHarness();
    const wait: ScenarioStep = {
      kind: 'wait',
      id: 's2',
      label: 'player accept',
      barcode: '041594899038',
      expect: [{ channel: 'vj', fields: { EventId: '1011', Description: '2ND POLAR POP' } }],
    };
    const run = h.runner.start(scenario([ringStep('s1', '041594899038', 100, 'LRG POLAR POP'), wait]));
    await h.flush();
    // A non-matching barcode must not settle the wait.
    h.emitInject('999', []);
    const injectLines = perform(h.session, { kind: 'ring', code: '041594899038', description: '2ND POLAR POP', priceCents: 99 });
    h.emitInject('041594899038', injectLines);
    const final = await run;
    expect(final.outcome).toBe('pass');
    expect(final.steps[1].status).toBe('pass');
    expect(final.steps[1].lines).toEqual(injectLines);
  });

  it('wait step fails on timeout', async () => {
    const h = makeHarness();
    const wait: ScenarioStep = { kind: 'wait', id: 's1', label: 'never', timeoutMs: 5000 };
    const run = h.runner.start(scenario([wait]));
    await h.flush();
    expect(h.sleeps.some((s) => s.ms === 5000)).toBe(true);
    for (const s of h.sleeps) s.resolve();
    const final = await run;
    expect(final.outcome).toBe('fail');
    expect(final.steps[0].status).toBe('fail');
    expect(final.steps[0].detail).toContain('timeout');
  });

  it('voids a dirty lane before starting so replays begin from a fresh basket', async () => {
    const h = makeHarness();
    h.session.addItem({ code: 'stale', description: 'Stale', priceCents: 500 });
    const steps: ScenarioStep[] = [
      ringStep('s1', 'a', 100, 'A'),
      { kind: 'assert', id: 's2', label: 'one line', basket: { lineCount: 1, totalCents: 100 } },
    ];
    const final = await h.runner.start(scenario(steps));
    expect(final.outcome).toBe('pass');
  });

  it('assert basket after tender grades against the pre-tender snapshot', async () => {
    const h = makeHarness();
    const steps: ScenarioStep[] = [
      ringStep('s1', 'a', 299, 'A'),
      { kind: 'act', id: 's2', label: 'tender', action: { kind: 'tender', tender: 'next-dollar' } },
      { kind: 'assert', id: 's3', label: 'totals', basket: { totalCents: 299 }, expect: [{ fields: { EventId: '1002' } }] },
    ];
    const final = await h.runner.start(scenario(steps));
    expect(final.outcome).toBe('pass');
  });

  it('assert wire expectations see the whole run tape', async () => {
    const h = makeHarness();
    const steps: ScenarioStep[] = [
      ringStep('s1', 'a', 100, 'A'),
      { kind: 'assert', id: 's2', label: 'saw the running subtotal', expect: [{ fields: { EventId: '1005' } }] },
    ];
    const final = await h.runner.start(scenario(steps));
    expect(final.outcome).toBe('pass');
  });

  it('fails when the register type changes mid-run', async () => {
    const h = makeHarness();
    const steps: ScenarioStep[] = [ringStep('s1', 'a', 100, 'A'), ringStep('s2', 'b', 100, 'B')];
    const run = h.runner.start(
      scenario([
        steps[0],
        { kind: 'wait', id: 'w', label: 'pause', timeoutMs: 1000 },
        steps[1],
      ]),
    );
    await h.flush();
    h.setRegisterType('bulloch');
    h.emitInject('x', []);
    const final = await run;
    expect(final.outcome).toBe('fail');
    expect(final.steps[2].status).toBe('fail');
    expect(final.steps[2].detail).toContain('register type');
  });

  it('abort settles a pending wait and marks remaining steps skipped', async () => {
    const h = makeHarness();
    const run = h.runner.start(scenario([{ kind: 'wait', id: 's1', label: 'w' }, ringStep('s2', 'a', 100, 'A')]));
    await h.flush();
    h.runner.abort();
    const final = await run;
    expect(final.outcome).toBe('aborted');
    expect(final.steps.map((s) => s.status)).toEqual(['skipped', 'skipped']);
  });

  it('step mode executes exactly one step per step() call', async () => {
    const h = makeHarness();
    const sc = scenario([ringStep('s1', 'a', 100, 'A'), ringStep('s2', 'b', 100, 'B')]);
    const run = h.runner.step(sc);
    await h.flush();
    const mid = h.updates[h.updates.length - 1];
    expect(mid.steps[0].status).toBe('pass');
    expect(mid.steps[1].status).toBe('pending');
    h.runner.step(sc);
    const final = await run;
    expect(final.outcome).toBe('pass');
  });

  it('scales recorded delays by speed and caps them', async () => {
    const h = makeHarness();
    h.runner.setSpeed(2);
    const step: ScenarioStep = { ...ringStep('s1', 'a', 100, 'A'), delayMs: 60_000 };
    const run = h.runner.start(scenario([step]));
    await h.flush();
    expect(h.sleeps).toHaveLength(1);
    expect(h.sleeps[0].ms).toBe(MAX_REPLAY_DELAY_MS / 2);
    h.sleeps[0].resolve();
    const final = await run;
    expect(final.outcome).toBe('pass');
  });

  it('restarting mid-run: the stale loop must not clobber the new run state', async () => {
    const h = makeHarness();
    // Run A parks on a wait step that never settles.
    const scA = { ...scenario([{ kind: 'wait', id: 'w', label: 'never' }]), id: 'run-a' };
    const runA = h.runner.start(scA);
    await h.flush();
    // Run B starts over the top of A and parks on its own wait step.
    const scB = {
      ...scenario([
        ringStep('s1', 'a', 100, 'A'),
        { kind: 'wait', id: 'w2', label: 'player', barcode: 'x' } as ScenarioStep,
      ]),
      id: 'run-b',
    };
    const runB = h.runner.start(scB);
    const finalA = await runA;
    await h.flush();
    // A's stale loop must not have stamped B's live state as done/aborted.
    expect(finalA.outcome).toBe('aborted');
    expect(h.runner.getState().scenarioId).toBe('run-b');
    expect(h.runner.getState().phase).toBe('running');
    expect(h.runner.getState().steps[0].status).toBe('pass');
    h.emitInject('x', []);
    const finalB = await runB;
    expect(finalB.outcome).toBe('pass');
    expect(h.runner.getState().outcome).toBe('pass');
  });

  it('emits immutable state updates', async () => {
    const h = makeHarness();
    await h.runner.start(scenario([ringStep('s1', 'a', 100, 'A')]));
    expect(h.updates.length).toBeGreaterThan(1);
    for (let i = 1; i < h.updates.length; i++) {
      expect(h.updates[i]).not.toBe(h.updates[i - 1]);
    }
  });
});
