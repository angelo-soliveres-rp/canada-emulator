/**
 * Scenario model — a replayable, assertable script of register actions.
 *
 * A scenario is what a manual bench session becomes when saved: each step
 * either performs a register action (`act`), waits for the player to inject a
 * completer (`wait`), or asserts on the accumulated wire tape / basket
 * (`assert`). Steps carry expected wire events (see scenarioEngine) so a run
 * grades PASS/FAIL per step, like the mockup's Scenario Runner.
 *
 * Pure / browser-safe; everything here is JSON-serializable so scenarios can
 * be persisted, exported and imported.
 */
import { REGISTER_TYPES, type Channel, type RegisterType } from './posTypes';
import type { PosLocale } from './currency';
import type { TenderKind } from './RegisterSession';

export const SCENARIO_VERSION = 1;

/** Default time an unqualified `wait` step waits for a player inject. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

/** A register action a scenario step can perform — mirrors the manual bench. */
export type ScenarioAction =
  | { kind: 'ring'; code: string; description?: string; priceCents?: number; quantity?: number }
  | { kind: 'scan'; code: string; description?: string }
  | { kind: 'loyalty'; card: string }
  | { kind: 'voidLine'; lineNumber: number }
  | { kind: 'setQuantity'; lineNumber: number; quantity: number }
  | { kind: 'setPrice'; lineNumber: number; priceCents: number }
  | { kind: 'tender'; tender: TenderKind; amountCents?: number }
  | { kind: 'voidTicket' };

/**
 * One expected wire event. `fields` matches a key=value subset of a comma
 * formatted VJ line; `includes` matches normalized substrings of any line
 * (plaintext Topaz / pole / Bulloch). Both must hold when both are present.
 */
export interface WireExpectation {
  channel?: Channel;
  includes?: string[];
  fields?: Record<string, string>;
}

/** Basket-state assertion, checked against a SessionSnapshot. */
export interface BasketAssertion {
  subtotalCents?: number;
  taxCents?: number;
  totalCents?: number;
  /** Count of non-voided lines. */
  lineCount?: number;
}

interface StepBase {
  id: string;
  label: string;
  /** Recorded gap before this step (ms); the runner scales it by speed. */
  delayMs?: number;
}

/** Perform a register action; PASS when every expectation matches its wire output. */
export interface ActStep extends StepBase {
  kind: 'act';
  action: ScenarioAction;
  expect?: WireExpectation[];
}

/** Wait for a player completer inject (optionally a specific barcode). */
export interface WaitStep extends StepBase {
  kind: 'wait';
  barcode?: string;
  timeoutMs?: number;
  /** Matched against the wire the auto-ring of the inject emits. */
  expect?: WireExpectation[];
}

/** No action — assert on the whole run tape and/or the basket snapshot. */
export interface AssertStep extends StepBase {
  kind: 'assert';
  expect?: WireExpectation[];
  basket?: BasketAssertion;
}

export type ScenarioStep = ActStep | WaitStep | AssertStep;

export interface Scenario {
  version: typeof SCENARIO_VERSION;
  id: string;
  name: string;
  registerType: RegisterType;
  locale?: PosLocale;
  steps: ScenarioStep[];
}

/** The chip vocabulary the step cards render (RING / TRIGGER / WAIT / …). */
export type StepDisplayKind = 'RING' | 'TRIGGER' | 'LOYALTY' | 'TENDER' | 'VOID' | 'EDIT' | 'WAIT' | 'ASSERT';

export function stepDisplayKind(step: ScenarioStep): StepDisplayKind {
  if (step.kind === 'wait') return 'WAIT';
  if (step.kind === 'assert') return 'ASSERT';
  switch (step.action.kind) {
    case 'ring':
      return 'RING';
    case 'scan':
      return 'TRIGGER';
    case 'loyalty':
      return 'LOYALTY';
    case 'tender':
      return 'TENDER';
    case 'voidLine':
    case 'voidTicket':
      return 'VOID';
    case 'setQuantity':
    case 'setPrice':
      return 'EDIT';
  }
}

export type ScenarioParseResult = { ok: true; scenario: Scenario } | { ok: false; error: string };

const REGISTER_TYPE_VALUES = new Set<string>(REGISTER_TYPES.map((r) => r.value));
const CHANNELS = new Set<string>(['vj', 'pole', 'scanner']);
const TENDER_KINDS = new Set<string>(['cash-exact', 'next-dollar', 'amount']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string';
}

function optionalNonNegative(v: unknown): v is number | undefined {
  return v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

function parseAction(v: unknown): ScenarioAction | null {
  if (!isRecord(v) || typeof v.kind !== 'string') return null;
  switch (v.kind) {
    case 'ring':
      if (typeof v.code !== 'string' || !v.code) return null;
      if (!optionalString(v.description) || !optionalNonNegative(v.priceCents) || !optionalNonNegative(v.quantity)) return null;
      return { kind: 'ring', code: v.code, description: v.description, priceCents: v.priceCents, quantity: v.quantity };
    case 'scan':
      if (typeof v.code !== 'string' || !v.code || !optionalString(v.description)) return null;
      return { kind: 'scan', code: v.code, description: v.description };
    case 'loyalty':
      if (typeof v.card !== 'string' || !v.card) return null;
      return { kind: 'loyalty', card: v.card };
    case 'voidLine':
      if (!optionalNonNegative(v.lineNumber) || v.lineNumber === undefined) return null;
      return { kind: 'voidLine', lineNumber: v.lineNumber };
    case 'setQuantity':
      if (!optionalNonNegative(v.lineNumber) || v.lineNumber === undefined) return null;
      if (!optionalNonNegative(v.quantity) || v.quantity === undefined) return null;
      return { kind: 'setQuantity', lineNumber: v.lineNumber, quantity: v.quantity };
    case 'setPrice':
      if (!optionalNonNegative(v.lineNumber) || v.lineNumber === undefined) return null;
      if (!optionalNonNegative(v.priceCents) || v.priceCents === undefined) return null;
      return { kind: 'setPrice', lineNumber: v.lineNumber, priceCents: v.priceCents };
    case 'tender':
      if (typeof v.tender !== 'string' || !TENDER_KINDS.has(v.tender)) return null;
      if (!optionalNonNegative(v.amountCents)) return null;
      return { kind: 'tender', tender: v.tender as TenderKind, amountCents: v.amountCents };
    case 'voidTicket':
      return { kind: 'voidTicket' };
    default:
      return null;
  }
}

function parseExpectations(v: unknown): WireExpectation[] | undefined | null {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return null;
  const out: WireExpectation[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) return null;
    const exp: WireExpectation = {};
    if (raw.channel !== undefined) {
      if (typeof raw.channel !== 'string' || !CHANNELS.has(raw.channel)) return null;
      exp.channel = raw.channel as Channel;
    }
    if (raw.includes !== undefined) {
      if (!Array.isArray(raw.includes) || raw.includes.some((s) => typeof s !== 'string')) return null;
      exp.includes = raw.includes as string[];
    }
    if (raw.fields !== undefined) {
      if (!isRecord(raw.fields) || Object.values(raw.fields).some((s) => typeof s !== 'string')) return null;
      exp.fields = raw.fields as Record<string, string>;
    }
    out.push(exp);
  }
  return out;
}

function parseBasketAssertion(v: unknown): BasketAssertion | undefined | null {
  if (v === undefined) return undefined;
  if (!isRecord(v)) return null;
  const keys: (keyof BasketAssertion)[] = ['subtotalCents', 'taxCents', 'totalCents', 'lineCount'];
  const out: BasketAssertion = {};
  for (const key of keys) {
    const raw = v[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    out[key] = raw;
  }
  return out;
}

function parseStep(raw: unknown, index: number): ScenarioStep | string {
  if (!isRecord(raw)) return `step ${index + 1}: not an object`;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `step-${index + 1}`;
  const label = typeof raw.label === 'string' && raw.label ? raw.label : `Step ${index + 1}`;
  if (!optionalNonNegative(raw.delayMs)) return `step ${index + 1}: invalid delayMs`;
  const delayMs = raw.delayMs;
  const expect = parseExpectations(raw.expect);
  if (expect === null) return `step ${index + 1}: invalid expect`;

  switch (raw.kind) {
    case 'act': {
      const action = parseAction(raw.action);
      if (!action) return `step ${index + 1}: invalid action`;
      return { kind: 'act', id, label, action, ...(expect ? { expect } : {}), ...(delayMs !== undefined ? { delayMs } : {}) };
    }
    case 'wait': {
      if (!optionalString(raw.barcode)) return `step ${index + 1}: invalid barcode`;
      if (!optionalNonNegative(raw.timeoutMs)) return `step ${index + 1}: invalid timeoutMs`;
      return {
        kind: 'wait',
        id,
        label,
        ...(raw.barcode ? { barcode: raw.barcode } : {}),
        ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
        ...(expect ? { expect } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
      };
    }
    case 'assert': {
      const basket = parseBasketAssertion(raw.basket);
      if (basket === null) return `step ${index + 1}: invalid basket assertion`;
      return {
        kind: 'assert',
        id,
        label,
        ...(expect ? { expect } : {}),
        ...(basket ? { basket } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
      };
    }
    default:
      return `step ${index + 1}: unknown kind "${String(raw.kind)}"`;
  }
}

/** Slug used when a scenario arrives without an id (e.g. hand-authored JSON). */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scenario';
}

/**
 * Validate + fill defaults on untrusted scenario JSON (imports, storage).
 * Never trusts external data; returns a typed error instead of throwing.
 */
export function normalizeScenario(input: unknown): ScenarioParseResult {
  if (!isRecord(input)) return { ok: false, error: 'scenario must be an object' };
  if (input.version !== undefined && input.version !== SCENARIO_VERSION) {
    return { ok: false, error: `unsupported scenario version ${String(input.version)}` };
  }
  if (typeof input.name !== 'string' || !input.name.trim()) return { ok: false, error: 'scenario needs a name' };
  if (typeof input.registerType !== 'string' || !REGISTER_TYPE_VALUES.has(input.registerType)) {
    return { ok: false, error: `unknown registerType "${String(input.registerType)}"` };
  }
  if (input.locale !== undefined && input.locale !== 'en' && input.locale !== 'fr') {
    return { ok: false, error: `unknown locale "${String(input.locale)}"` };
  }
  if (!Array.isArray(input.steps)) return { ok: false, error: 'scenario needs a steps array' };

  const steps: ScenarioStep[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    const parsed = parseStep(input.steps[i], i);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    steps.push(parsed);
  }

  const name = input.name.trim();
  return {
    ok: true,
    scenario: {
      version: SCENARIO_VERSION,
      id: typeof input.id === 'string' && input.id ? input.id : slugify(name),
      name,
      registerType: input.registerType as RegisterType,
      ...(input.locale ? { locale: input.locale as PosLocale } : {}),
      steps,
    },
  };
}
