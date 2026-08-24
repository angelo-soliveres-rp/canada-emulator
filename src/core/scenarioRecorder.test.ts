import { describe, it, expect } from 'vitest';
import { RegisterSession, type WireMessage } from './RegisterSession';
import { normalizeScenario } from './scenario';
import { evaluateExpectations } from './scenarioEngine';
import { foldRecording, type RecordedEvent } from './scenarioRecorder';

const wire = (messages: WireMessage[]): { channel: WireMessage['channel']; text: string }[] =>
  messages.map((m) => ({ channel: m.channel, text: m.data }));

describe('foldRecording', () => {
  it('folds actions and injects into act/wait steps with recorded gaps', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    const ringWire = wire(s.addItem({ code: '041594899038', description: 'LRG POLAR POP', priceCents: 100 }));
    const injectWire = wire(s.addItem({ code: '041594899038', description: '2ND POLAR POP', priceCents: 99 }));
    const tenderWire = wire(s.tender('next-dollar'));

    const events: RecordedEvent[] = [
      { type: 'action', at: 1000, action: { kind: 'ring', code: '041594899038', description: 'LRG POLAR POP', priceCents: 100 }, wire: ringWire },
      { type: 'inject', at: 4200, barcode: '041594899038', quantity: 1, wire: injectWire },
      { type: 'action', at: 6000, action: { kind: 'tender', tender: 'next-dollar' }, wire: tenderWire },
    ];

    const scenario = foldRecording(events, { name: 'Polar Pop happy path', registerType: 'radiant6-us' });

    expect(scenario.steps).toHaveLength(3);
    expect(scenario.steps[0].kind).toBe('act');
    expect(scenario.steps[1].kind).toBe('wait');
    expect(scenario.steps[2].kind).toBe('act');
    expect(scenario.steps[0].delayMs).toBe(0);
    expect(scenario.steps[1].delayMs).toBe(3200);
    expect(scenario.steps[2].delayMs).toBe(1800);
    if (scenario.steps[1].kind === 'wait') {
      expect(scenario.steps[1].barcode).toBe('041594899038');
    }
  });

  // The 2010 sign-on is NOT lane-open noise: its operator fields are the whole
  // point of the step, so they must survive into the expectation and re-match
  // on replay — including through the `,,` comma escape.
  it('records a cashier sign-on whose expectation replays against the same wire', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    const action = { kind: 'cashier', operatorId: '10000000003', operatorName: 'Young, Brianna' } as const;
    const cashierWire = wire(s.cashierChange(action));

    const scenario = foldRecording([{ type: 'action', at: 0, action, wire: cashierWire }], {
      name: 'shift change',
      registerType: 'radiant6-us',
    });

    const step = scenario.steps[0];
    expect(step.kind).toBe('act');
    if (step.kind !== 'act') return;
    expect(step.label).toBe('Cashier Young, Brianna');
    expect(step.expect).toEqual([
      { channel: 'vj', fields: { EventId: '2010', OperatorId: '10000000003', OperatorName: 'Young, Brianna' } },
    ]);

    // Replaying the identical action must satisfy the recorded expectation.
    const replay = wire(new RegisterSession({ registerType: 'radiant6-us' }).cashierChange(action));
    expect(evaluateExpectations(step.expect, replay).pass).toBe(true);

    // And it survives an export/import cycle unchanged.
    const reparsed = normalizeScenario(JSON.parse(JSON.stringify(scenario)));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(evaluateExpectations((reparsed.scenario.steps[0] as typeof step).expect, replay).pass).toBe(true);
  });

  it('skips running-total and lane-open noise (1001/1009/1005/1020) in expectations', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    const ringWire = wire(s.addItem({ code: 'a', description: 'A', priceCents: 100 }));
    const events: RecordedEvent[] = [
      { type: 'action', at: 0, action: { kind: 'ring', code: 'a', description: 'A', priceCents: 100 }, wire: ringWire },
    ];
    const scenario = foldRecording(events, { name: 'x', registerType: 'radiant6-us' });
    const step = scenario.steps[0];
    expect(step.kind).toBe('act');
    if (step.kind !== 'act') return;
    const ids = (step.expect ?? []).map((e) => e.fields?.EventId ?? '(text)');
    expect(ids).toEqual(['1011']);
  });

  it('keeps pole expectations for Bulloch (pole is the only channel)', () => {
    const s = new RegisterSession({ registerType: 'bulloch' });
    const ringWire = wire(s.addItem({ code: 'a', description: 'A', priceCents: 100 }));
    const events: RecordedEvent[] = [
      { type: 'action', at: 0, action: { kind: 'ring', code: 'a', description: 'A', priceCents: 100 }, wire: ringWire },
    ];
    const scenario = foldRecording(events, { name: 'x', registerType: 'bulloch' });
    const step = scenario.steps[0];
    if (step.kind !== 'act') throw new Error('expected act step');
    expect((step.expect ?? []).length).toBeGreaterThan(0);
    expect((step.expect ?? []).every((e) => e.channel === 'pole')).toBe(true);
  });

  it('produces a scenario that normalizes cleanly and replays against a fresh session', () => {
    const record = new RegisterSession({ registerType: 'radiant6-canada', clock: () => new Date('2026-07-17T14:00:00') });
    const item = { code: '049000000443', description: 'Coke 20oz', priceCents: 229 };
    const events: RecordedEvent[] = [
      { type: 'action', at: 0, action: { kind: 'ring', ...item }, wire: wire(record.addItem(item)) },
      { type: 'action', at: 900, action: { kind: 'tender', tender: 'cash-exact' }, wire: wire(record.tender('cash-exact')) },
    ];
    const scenario = foldRecording(events, { name: 'CA smoke', registerType: 'radiant6-canada' });
    expect(normalizeScenario(scenario).ok).toBe(true);

    const replay = new RegisterSession({ registerType: 'radiant6-canada', clock: () => new Date('2027-01-01T08:00:00'), startTx: 9 });
    const first = scenario.steps[0];
    const second = scenario.steps[1];
    if (first.kind !== 'act' || second.kind !== 'act') throw new Error('expected act steps');
    expect(evaluateExpectations(first.expect, wire(replay.addItem(item))).pass).toBe(true);
    expect(evaluateExpectations(second.expect, wire(replay.tender('cash-exact'))).pass).toBe(true);
  });

  it('labels steps from the action when no label is supplied', () => {
    const events: RecordedEvent[] = [
      { type: 'action', at: 0, action: { kind: 'loyalty', card: '8018000011112222' }, wire: [] },
      { type: 'action', at: 100, action: { kind: 'voidTicket' }, wire: [] },
    ];
    const scenario = foldRecording(events, { name: 'x', registerType: 'radiant6-canada' });
    expect(scenario.steps[0].label.toLowerCase()).toContain('loyalty');
    expect(scenario.steps[1].label.toLowerCase()).toContain('void');
  });
});
