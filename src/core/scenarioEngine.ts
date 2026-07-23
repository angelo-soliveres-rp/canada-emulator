/**
 * Scenario engine — pure matching and grading logic for scenario runs.
 *
 * The runner feeds it what it observed (wire lines per step, injects, basket
 * snapshots); this module decides PASS/FAIL. Matching is deliberately tolerant
 * of the volatile parts of real wire traffic — timestamps, transaction
 * counters, line numbers — so a scenario recorded today replays green
 * tomorrow on a different transaction number:
 *
 *   - comma-format VJ lines match on a `fields` subset (EventId, Description,
 *     Amount, …), never full-line equality;
 *   - plaintext lines (Topaz VJ frames, pole windows) match on `includes`
 *     substrings after normalization that collapses whitespace and masks the
 *     Topaz `MM/dd/yy HH:mm:ss` header and `TRAN# n` counters.
 *
 * Pure / browser-safe.
 */
import type { Channel } from './posTypes';
import type { SessionSnapshot } from './RegisterSession';
import type { BasketAssertion, WireExpectation } from './scenario';

export interface ObservedLine {
  channel: Channel;
  text: string;
}

export type StepStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skipped';

/** Parse a comma-separated `key=value` VJ line into its fields (empty for plaintext). */
export function parseWireFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const piece of text.replace(/\r?\n$/, '').split(',')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    fields.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  return fields;
}

const TOPAZ_HEADER = /^\s*\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+/;
const TRAN_COUNTER = /TRAN#\s*\d+/g;

/**
 * Normalize a wire line for substring matching: strip the volatile Topaz
 * header timestamp and TRAN# counters, then collapse whitespace runs (Topaz
 * pads plaintext into columns; the padding width is not meaningful).
 */
export function normalizeWireText(text: string): string {
  return text
    .replace(/\r?\n$/, '')
    .replace(TOPAZ_HEADER, '')
    .replace(TRAN_COUNTER, 'TRAN#')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does one observed line satisfy one expectation? */
export function matchesExpectation(exp: WireExpectation, line: ObservedLine): boolean {
  if (exp.channel && exp.channel !== line.channel) return false;
  if (exp.fields) {
    const fields = parseWireFields(line.text);
    for (const [key, value] of Object.entries(exp.fields)) {
      if (fields.get(key) !== value) return false;
    }
  }
  if (exp.includes) {
    const haystack = normalizeWireText(line.text);
    for (const needle of exp.includes) {
      if (!haystack.includes(normalizeWireText(needle))) return false;
    }
  }
  return true;
}

export interface ExpectationEvaluation {
  pass: boolean;
  /** Index into `lines` each expectation matched (parallel to expectations). */
  matched: number[];
  /** Index of the first expectation that never matched, or null when passing. */
  failedAt: number | null;
}

/**
 * Match expectations against observed lines in order: each expectation must
 * match some line at or after the previous match (sequential consume, so the
 * recorded event order is part of the contract).
 */
export function evaluateExpectations(
  expectations: WireExpectation[] | undefined,
  lines: ObservedLine[],
): ExpectationEvaluation {
  const matched: number[] = [];
  if (!expectations || expectations.length === 0) return { pass: true, matched, failedAt: null };
  let cursor = 0;
  for (let i = 0; i < expectations.length; i++) {
    let hit = -1;
    for (let j = cursor; j < lines.length; j++) {
      if (matchesExpectation(expectations[i], lines[j])) {
        hit = j;
        break;
      }
    }
    if (hit === -1) return { pass: false, matched, failedAt: i };
    matched.push(hit);
    cursor = hit + 1;
  }
  return { pass: true, matched, failedAt: null };
}

export interface BasketEvaluation {
  pass: boolean;
  failures: string[];
}

/** Check a basket assertion against a snapshot; failures name each mismatch. */
export function evaluateBasketAssertion(assertion: BasketAssertion, snapshot: SessionSnapshot): BasketEvaluation {
  const failures: string[] = [];
  const check = (label: string, expected: number | undefined, actual: number): void => {
    if (expected !== undefined && expected !== actual) {
      failures.push(`${label}: expected ${expected}, got ${actual}`);
    }
  };
  check('subtotal', assertion.subtotalCents, snapshot.subtotalCents);
  check('tax', assertion.taxCents, snapshot.taxCents);
  check('total', assertion.totalCents, snapshot.totalCents);
  check('lineCount', assertion.lineCount, snapshot.lines.filter((l) => !l.voided).length);
  return { pass: failures.length === 0, failures };
}

/**
 * Field keys that stay stable across replays. Everything else on a comma
 * format line (EventTime, TransactionNumber, ItemNumber, TerminalNumber…) is
 * volatile and must not end up in a recorded expectation.
 */
const STABLE_FIELDS = [
  'EventId',
  'Description',
  'Amount',
  'Barcode',
  'Quantity',
  'NewQuantity',
  'NewPrice',
  'DiscountCardNumber',
  'SubtotalAmount',
  'TaxAmount',
  'TotalAmount',
  'TransactionType',
  'TransactionCompletionType',
] as const;

/**
 * Turn one observed line into the expectation that will re-match it on a
 * future run: a stable field subset for comma-format VJ lines, a normalized
 * full-text `includes` for plaintext lines.
 */
export function expectationForLine(line: ObservedLine): WireExpectation {
  const fields = parseWireFields(line.text);
  if (fields.has('EventId')) {
    const stable: Record<string, string> = {};
    for (const key of STABLE_FIELDS) {
      const value = fields.get(key);
      if (value !== undefined) stable[key] = value;
    }
    return { channel: line.channel, fields: stable };
  }
  return { channel: line.channel, includes: [normalizeWireText(line.text)] };
}
