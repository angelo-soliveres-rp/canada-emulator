import { describe, it, expect } from 'vitest';
import { normalizeScenario, stepDisplayKind, SCENARIO_VERSION, type Scenario, type ScenarioStep } from './scenario';

const minimal = {
  name: 'Polar Pop happy path',
  registerType: 'radiant6-us',
  steps: [
    { kind: 'act', label: 'LRG POLAR POP', action: { kind: 'ring', code: '041594899038', priceCents: 100 } },
    { kind: 'wait', label: 'player offer accept' },
    { kind: 'act', label: 'Next $', action: { kind: 'tender', tender: 'next-dollar' } },
    { kind: 'assert', label: 'basket end totals', basket: { totalCents: 299 } },
  ],
};

describe('normalizeScenario', () => {
  it('accepts a minimal scenario, filling version, id and step ids', () => {
    const res = normalizeScenario(minimal);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scenario.version).toBe(SCENARIO_VERSION);
    expect(res.scenario.id).toBeTruthy();
    expect(res.scenario.steps).toHaveLength(4);
    const ids = res.scenario.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('round-trips through JSON unchanged', () => {
    const first = normalizeScenario(minimal);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = normalizeScenario(JSON.parse(JSON.stringify(first.scenario)));
    expect(second).toEqual(first);
  });

  it('round-trips a cashier step and rejects a blank operator', () => {
    const withCashier = {
      ...minimal,
      steps: [{ kind: 'act', label: 'Cashier Brianna', action: { kind: 'cashier', operatorId: '77', operatorName: 'Young, Brianna' } }],
    };
    const res = normalizeScenario(withCashier);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const step = res.scenario.steps[0];
    expect(step.kind).toBe('act');
    if (step.kind !== 'act') return;
    expect(step.action).toEqual({ kind: 'cashier', operatorId: '77', operatorName: 'Young, Brianna' });
    expect(normalizeScenario(JSON.parse(JSON.stringify(res.scenario)))).toEqual(res);

    for (const bad of [{ operatorId: '', operatorName: 'B' }, { operatorId: '77' }, { operatorName: 'B' }]) {
      expect(normalizeScenario({ ...minimal, steps: [{ kind: 'act', label: 'x', action: { kind: 'cashier', ...bad } }] }).ok).toBe(false);
    }
  });

  it('round-trips a loyalty step with an explicit cardId', () => {
    const withCardId = {
      ...minimal,
      steps: [{ kind: 'act', label: 'EasyPay', action: { kind: 'loyalty', card: '8018782603800034999992', cardId: '70000000009' } }],
    };
    const res = normalizeScenario(withCardId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const step = res.scenario.steps[0];
    if (step.kind !== 'act') return;
    expect(step.action).toEqual({ kind: 'loyalty', card: '8018782603800034999992', cardId: '70000000009' });
    // Absent cardId stays absent rather than becoming an empty string.
    const bare = normalizeScenario({ ...minimal, steps: [{ kind: 'act', label: 'x', action: { kind: 'loyalty', card: '123' } }] });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    const bareStep = bare.scenario.steps[0];
    if (bareStep.kind !== 'act') return;
    expect(bareStep.action).toEqual({ kind: 'loyalty', card: '123' });
  });

  it('round-trips suspend and resume steps', () => {
    const res = normalizeScenario({
      ...minimal,
      steps: [
        { kind: 'act', label: 'park', action: { kind: 'suspendBasket' } },
        { kind: 'act', label: 'recall', action: { kind: 'resumeBasket' } },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scenario.steps.map((st) => (st.kind === 'act' ? st.action.kind : st.kind))).toEqual([
      'suspendBasket',
      'resumeBasket',
    ]);
    expect(stepDisplayKind(res.scenario.steps[0])).toBe('SUSPEND');
    expect(stepDisplayKind(res.scenario.steps[1])).toBe('RESUME');
  });

  it('rejects non-objects and missing names', () => {
    expect(normalizeScenario(null).ok).toBe(false);
    expect(normalizeScenario('nope').ok).toBe(false);
    expect(normalizeScenario({ registerType: 'bulloch', steps: [] }).ok).toBe(false);
  });

  it('rejects unknown register types and step kinds', () => {
    expect(normalizeScenario({ ...minimal, registerType: 'ncr' }).ok).toBe(false);
    expect(normalizeScenario({ ...minimal, steps: [{ kind: 'jump', label: 'x' }] }).ok).toBe(false);
  });

  it('rejects act steps without a valid action', () => {
    expect(normalizeScenario({ ...minimal, steps: [{ kind: 'act', label: 'x' }] }).ok).toBe(false);
    expect(
      normalizeScenario({ ...minimal, steps: [{ kind: 'act', label: 'x', action: { kind: 'warp' } }] }).ok,
    ).toBe(false);
  });

  it('rejects malformed expectations and negative timeouts', () => {
    expect(
      normalizeScenario({ ...minimal, steps: [{ kind: 'wait', label: 'w', timeoutMs: -5 }] }).ok,
    ).toBe(false);
    expect(
      normalizeScenario({
        ...minimal,
        steps: [{ kind: 'act', label: 'x', action: { kind: 'voidTicket' }, expect: [{ channel: 'radio' }] }],
      }).ok,
    ).toBe(false);
  });
});

describe('stepDisplayKind', () => {
  const act = (action: object): ScenarioStep =>
    ({ kind: 'act', id: 's', label: 'l', action } as ScenarioStep);

  it('maps actions to the bench chip vocabulary', () => {
    expect(stepDisplayKind(act({ kind: 'ring', code: 'a', priceCents: 1 }))).toBe('RING');
    expect(stepDisplayKind(act({ kind: 'scan', code: 'a' }))).toBe('TRIGGER');
    expect(stepDisplayKind(act({ kind: 'loyalty', card: '1' }))).toBe('LOYALTY');
    expect(stepDisplayKind(act({ kind: 'cashier', operatorId: '1', operatorName: 'B' }))).toBe('CASHIER');
    expect(stepDisplayKind(act({ kind: 'tender', tender: 'cash-exact' }))).toBe('TENDER');
    expect(stepDisplayKind(act({ kind: 'voidLine', lineNumber: 1 }))).toBe('VOID');
    expect(stepDisplayKind(act({ kind: 'voidTicket' }))).toBe('VOID');
    expect(stepDisplayKind(act({ kind: 'setQuantity', lineNumber: 1, quantity: 2 }))).toBe('EDIT');
    expect(stepDisplayKind(act({ kind: 'setPrice', lineNumber: 1, priceCents: 99 }))).toBe('EDIT');
    expect(stepDisplayKind({ kind: 'wait', id: 's', label: 'l' } as ScenarioStep)).toBe('WAIT');
    expect(stepDisplayKind({ kind: 'assert', id: 's', label: 'l' } as ScenarioStep)).toBe('ASSERT');
  });
});

describe('Scenario type', () => {
  it('keeps steps serializable (no functions, no Dates)', () => {
    const res = normalizeScenario(minimal);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const scenario: Scenario = res.scenario;
    const json = JSON.stringify(scenario);
    expect(JSON.parse(json)).toEqual(scenario);
  });
});
