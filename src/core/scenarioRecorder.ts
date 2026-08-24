/**
 * Scenario recorder — folds a recorded manual session into a Scenario.
 *
 * The renderer captures every bench action (with the wire it emitted) and
 * every player inject while recording; this module turns that event list into
 * steps with generated expectations, so "Save as scenario" produces a script
 * that replays green (see scenarioEngine for the matching tolerances).
 *
 * Expectation noise rules: lane-open preamble (1001/1009) and the US
 * running-totals cadence (1005/1020) re-fire at positions that depend on
 * session state, so they never become expectations. Pole windows are realism
 * only on every family except Bulloch — where the pole IS the journal — so
 * pole lines are kept only for Bulloch.
 *
 * Pure / browser-safe: timestamps arrive as data, never from a clock.
 */
import type { RegisterType } from './posTypes';
import type { PosLocale } from './currency';
import {
  SCENARIO_VERSION,
  type Scenario,
  type ScenarioAction,
  type ScenarioStep,
  type WireExpectation,
} from './scenario';
import { expectationForLine, parseWireFields, type ObservedLine } from './scenarioEngine';

export type RecordedWire = ObservedLine;

export type RecordedEvent =
  | { type: 'action'; at: number; action: ScenarioAction; wire: RecordedWire[] }
  | { type: 'inject'; at: number; barcode: string; quantity: number; wire: RecordedWire[] };

export interface RecordingMeta {
  name: string;
  registerType: RegisterType;
  locale?: PosLocale;
  id?: string;
}

/** VJ events whose position depends on session state, never on the step. */
const NOISE_EVENT_IDS = new Set(['1001', '1009', '1005', '1020']);

function expectationsFor(wire: RecordedWire[], registerType: RegisterType): WireExpectation[] {
  const out: WireExpectation[] = [];
  for (const line of wire) {
    if (line.channel === 'scanner') continue;
    if (line.channel === 'pole' && registerType !== 'bulloch') continue;
    const eventId = parseWireFields(line.text).get('EventId');
    if (eventId && NOISE_EVENT_IDS.has(eventId)) continue;
    out.push(expectationForLine(line));
  }
  return out;
}

function labelForAction(action: ScenarioAction): string {
  switch (action.kind) {
    case 'ring':
      return action.description?.trim() || `Ring ${action.code}`;
    case 'scan':
      return action.description?.trim() || `Scan ${action.code}`;
    case 'loyalty':
      return `Loyalty ${action.card}`;
    case 'cashier':
      return `Cashier ${action.operatorName}`;
    case 'suspendBasket':
      return 'Suspend basket';
    case 'resumeBasket':
      return 'Resume basket';
    case 'voidLine':
      return `Void line ${action.lineNumber}`;
    case 'setQuantity':
      return `Qty line ${action.lineNumber} to ${action.quantity}`;
    case 'setPrice':
      return `Price line ${action.lineNumber} to ${(action.priceCents / 100).toFixed(2)}`;
    case 'tender':
      return `Tender ${action.tender}`;
    case 'voidTicket':
      return 'Void ticket';
  }
}

/** Fold a recorded event stream into a replayable scenario. */
export function foldRecording(events: RecordedEvent[], meta: RecordingMeta): Scenario {
  const steps: ScenarioStep[] = [];
  let prevAt: number | null = null;
  for (const event of events) {
    const delayMs = prevAt === null ? 0 : Math.max(0, event.at - prevAt);
    prevAt = event.at;
    const id = `step-${steps.length + 1}`;
    const expect = expectationsFor(event.wire, meta.registerType);
    if (event.type === 'action') {
      steps.push({
        kind: 'act',
        id,
        label: labelForAction(event.action),
        action: event.action,
        ...(expect.length > 0 ? { expect } : {}),
        delayMs,
      });
    } else {
      steps.push({
        kind: 'wait',
        id,
        label: `Player inject ${event.barcode}`,
        barcode: event.barcode,
        ...(expect.length > 0 ? { expect } : {}),
        delayMs,
      });
    }
  }

  return {
    version: SCENARIO_VERSION,
    id: meta.id ?? meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    name: meta.name,
    registerType: meta.registerType,
    ...(meta.locale ? { locale: meta.locale } : {}),
    steps,
  };
}
