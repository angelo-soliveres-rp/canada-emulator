import { describe, it, expect } from 'vitest';
import { RegisterSession, type WireMessage } from './RegisterSession';
import {
  parseWireFields,
  normalizeWireText,
  matchesExpectation,
  evaluateExpectations,
  evaluateBasketAssertion,
  expectationForLine,
  type ObservedLine,
} from './scenarioEngine';

const toLines = (messages: WireMessage[]): ObservedLine[] =>
  messages.map((m) => ({ channel: m.channel, text: m.data }));

describe('parseWireFields', () => {
  it('parses comma-separated key=value lines', () => {
    const fields = parseWireFields('EventId=1011,Description=LRG POLAR POP,Amount=1.00\r\n');
    expect(fields.get('EventId')).toBe('1011');
    expect(fields.get('Description')).toBe('LRG POLAR POP');
    expect(fields.get('Amount')).toBe('1.00');
  });

  it('returns empty for plaintext lines', () => {
    expect(parseWireFields('  1 LRG POLAR POP        1.00').size).toBe(0);
  });
});

describe('normalizeWireText', () => {
  it('collapses whitespace runs', () => {
    expect(normalizeWireText('  1 LRG  POLAR POP     1.00 ')).toBe('1 LRG POLAR POP 1.00');
  });

  it('masks Topaz VJ header timestamps so two runs compare equal', () => {
    const a = normalizeWireText('07/17/26 14:02:11 101   1 LRG POLAR POP     1.00');
    const b = normalizeWireText('01/02/25 09:59:59 101   1 LRG POLAR POP     1.00');
    expect(a).toBe(b);
  });

  it('masks TRAN# counters in Topaz trailers', () => {
    const a = normalizeWireText('           ST# 1 TRAN# 12');
    const b = normalizeWireText('           ST# 1 TRAN# 99');
    expect(a).toBe(b);
  });
});

describe('matchesExpectation', () => {
  it('matches on a stable field subset of a real Radiant6 itemAdd line', () => {
    const s = new RegisterSession({ registerType: 'radiant6-canada' });
    const line = toLines(s.addItem({ code: '049000000443', description: 'Coke 20oz', priceCents: 229 })).find((l) =>
      l.text.includes('EventId=1011'),
    )!;
    expect(
      matchesExpectation({ channel: 'vj', fields: { EventId: '1011', Description: 'Coke 20oz' } }, line),
    ).toBe(true);
    expect(matchesExpectation({ channel: 'vj', fields: { EventId: '1012' } }, line)).toBe(false);
    expect(matchesExpectation({ channel: 'pole', fields: { EventId: '1011' } }, line)).toBe(false);
  });

  it('matches includes against normalized text', () => {
    const line: ObservedLine = { channel: 'vj', text: '07/17/26 14:02:11 101   1 LRG POLAR POP     1.00' };
    expect(matchesExpectation({ includes: ['1 LRG POLAR POP 1.00'] }, line)).toBe(true);
    expect(matchesExpectation({ includes: ['2ND POLAR POP'] }, line)).toBe(false);
  });
});

describe('evaluateExpectations', () => {
  const lines: ObservedLine[] = [
    { channel: 'vj', text: 'EventId=1011,Description=A,Amount=1.00' },
    { channel: 'vj', text: 'EventId=1005,Amount=1.00' },
    { channel: 'vj', text: 'EventId=1020,Amount=0.05' },
  ];

  it('passes when expectations match in order', () => {
    const res = evaluateExpectations(
      [{ fields: { EventId: '1011' } }, { fields: { EventId: '1020' } }],
      lines,
    );
    expect(res.pass).toBe(true);
    expect(res.failedAt).toBeNull();
  });

  it('fails at the first expectation that never matches, respecting order', () => {
    // 1020 consumed first pushes the cursor past 1011 — order matters.
    const res = evaluateExpectations(
      [{ fields: { EventId: '1020' } }, { fields: { EventId: '1011' } }],
      lines,
    );
    expect(res.pass).toBe(false);
    expect(res.failedAt).toBe(1);
  });

  it('passes trivially with no expectations', () => {
    expect(evaluateExpectations([], lines).pass).toBe(true);
    expect(evaluateExpectations(undefined, lines).pass).toBe(true);
  });
});

describe('evaluateBasketAssertion', () => {
  it('checks totals and non-voided line count against a snapshot', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us', taxRateBps: 0 });
    s.addItem({ code: 'a', description: 'A', priceCents: 100 });
    s.addItem({ code: 'b', description: 'B', priceCents: 199 });
    s.voidLine(1);
    const snap = s.snapshot();
    expect(evaluateBasketAssertion({ totalCents: 199, lineCount: 1 }, snap).pass).toBe(true);
    const fail = evaluateBasketAssertion({ totalCents: 299, taxCents: 5 }, snap);
    expect(fail.pass).toBe(false);
    expect(fail.failures.join(' ')).toContain('total');
    expect(fail.failures.join(' ')).toContain('tax');
  });
});

describe('expectationForLine (record → replay guarantee)', () => {
  it('recorded Radiant6 Canada expectations match a fresh session on a later day', () => {
    const recordedAt = new Date('2026-07-17T14:02:07');
    const replayedAt = new Date('2026-08-01T09:30:00');
    const record = new RegisterSession({ registerType: 'radiant6-canada', clock: () => recordedAt });
    const replay = new RegisterSession({ registerType: 'radiant6-canada', clock: () => replayedAt, startTx: 42 });

    const item = { code: '049000000443', description: 'Coke 20oz', priceCents: 229 };
    const expectations = toLines(record.addItem(item)).map(expectationForLine);
    const observed = toLines(replay.addItem(item));

    expect(evaluateExpectations(expectations, observed).pass).toBe(true);
  });

  it('recorded Topaz expectations survive new timestamps and transaction numbers', () => {
    const record = new RegisterSession({ registerType: 'verifone', clock: () => new Date('2026-07-17T14:02:07') });
    const replay = new RegisterSession({ registerType: 'verifone', clock: () => new Date('2026-09-09T23:59:59'), startTx: 7 });

    record.addItem({ code: 'a', description: 'LRG POLAR POP', priceCents: 100 });
    replay.addItem({ code: 'a', description: 'LRG POLAR POP', priceCents: 100 });
    const expectations = toLines(record.tender('next-dollar')).map(expectationForLine);
    const observed = toLines(replay.tender('next-dollar'));

    expect(evaluateExpectations(expectations, observed).pass).toBe(true);
  });

  it('field-based expectations drop volatile keys (EventTime, TransactionNumber, ItemNumber)', () => {
    const s = new RegisterSession({ registerType: 'radiant6-us' });
    const line = toLines(s.addItem({ code: 'a', description: 'A', priceCents: 100 })).find((l) =>
      l.text.includes('EventId=1011'),
    )!;
    const exp = expectationForLine(line);
    expect(exp.fields).toBeDefined();
    expect(Object.keys(exp.fields!)).not.toContain('EventTime');
    expect(Object.keys(exp.fields!)).not.toContain('TransactionNumber');
    expect(Object.keys(exp.fields!)).not.toContain('ItemNumber');
    expect(exp.fields!.EventId).toBe('1011');
  });
});
