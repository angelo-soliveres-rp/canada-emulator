import { stepDisplayKind, DEFAULT_WAIT_TIMEOUT_MS, type Scenario, type ScenarioStep } from '../../../core/scenario';
import type { StepStatus } from '../../../core/scenarioEngine';
import type { RunState, StepRun } from '../../../core/scenarioRunner';
import { REGISTER_TYPES } from '../../../core/posTypes';
import { CopyIcon } from '../icons';
import styles from './ScenarioSteps.module.css';

const STATUS_GLYPH: Record<StepStatus, string> = {
  pending: '·',
  running: '▶',
  pass: '✓',
  fail: '✗',
  skipped: '–',
};

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'PENDING',
  running: 'RUNNING',
  pass: 'PASS',
  fail: 'FAIL',
  skipped: 'SKIPPED',
};

function expectSummary(step: ScenarioStep): string {
  if (step.kind === 'wait') {
    const timeout = ((step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) / 1000).toFixed(0);
    return `player inject${step.barcode ? ` ${step.barcode}` : ''} · timeout ${timeout}s`;
  }
  const parts: string[] = [];
  if (step.expect && step.expect.length > 0) {
    const ids = step.expect.map((x) => x.fields?.EventId).filter(Boolean);
    parts.push(ids.length > 0 ? `expect ${ids.join(' + ')}` : `expect ${step.expect.length} line(s)`);
  }
  if (step.kind === 'assert' && step.basket) {
    const b = step.basket;
    const dollars = (v: number): string => (v / 100).toFixed(2);
    if (b.totalCents !== undefined) parts.push(`total ${dollars(b.totalCents)}`);
    if (b.subtotalCents !== undefined) parts.push(`subtotal ${dollars(b.subtotalCents)}`);
    if (b.taxCents !== undefined) parts.push(`tax ${dollars(b.taxCents)}`);
    if (b.lineCount !== undefined) parts.push(`${b.lineCount} line(s)`);
  }
  return parts.join(' · ');
}

export function ScenarioSteps({
  scenario,
  runState,
  onExport,
}: {
  scenario: Scenario | null;
  runState: RunState;
  onExport: (id: string) => void;
}): JSX.Element {
  if (!scenario) {
    return (
      <section className={styles.wrap} aria-label="Scenario steps">
        <div className={styles.emptyBig}>
          No scenario selected. Record a manual session and save it, or import one from the clipboard.
        </div>
      </section>
    );
  }

  const isActive = runState.scenarioId === scenario.id;
  const runs: (StepRun | null)[] = scenario.steps.map((_, i) => (isActive ? runState.steps[i] ?? null : null));
  const passCount = runs.filter((r) => r?.status === 'pass').length;
  const registerLabel = REGISTER_TYPES.find((r) => r.value === scenario.registerType)?.label ?? scenario.registerType;

  const summary = ((): { text: string; tone: string } | null => {
    if (!isActive || runState.phase === 'idle') return null;
    if (runState.outcome === 'fail') return { text: `FAIL @${(runState.failedStep ?? 0) + 1}`, tone: styles.fail };
    if (runState.outcome === 'aborted') return { text: 'STOPPED', tone: styles.faint };
    return { text: `${passCount}/${scenario.steps.length} PASS`, tone: runState.outcome === 'pass' ? styles.ok : styles.accent };
  })();

  return (
    <section className={styles.wrap} aria-label="Scenario steps">
      <div className={styles.head}>
        <span className={styles.name}>{scenario.name}</span>
        {summary && <span className={`${styles.summary} ${summary.tone}`}>{summary.text}</span>}
        <span className={styles.spacer} />
        <span className={styles.regchip}>{registerLabel}{scenario.locale ? ` · ${scenario.locale}` : ''}</span>
        <button
          className={styles.tool}
          onClick={() => onExport(scenario.id)}
          title="Copy scenario JSON to clipboard"
          aria-label="Copy scenario JSON"
        >
          <CopyIcon size={13} />
        </button>
      </div>

      <div className={styles.list}>
        {scenario.steps.map((step, i) => {
          const run = runs[i];
          const status: StepStatus = run?.status ?? 'pending';
          const kind = stepDisplayKind(step);
          const sub = run?.detail ?? expectSummary(step);
          return (
            <div key={step.id} className={`${styles.card} ${styles[`st_${status}`]}`}>
              <span className={`${styles.glyph} ${styles[`g_${status}`]}`} aria-hidden="true">
                {STATUS_GLYPH[status]}
              </span>
              <div className={styles.body}>
                <div className={styles.top}>
                  <span className={styles.kind} data-kind={kind}>
                    {kind}
                  </span>
                  <span className={styles.label}>{step.label}</span>
                  <span className={styles.spacer} />
                  <span className={`${styles.status} ${styles[`s_${status}`]}`}>
                    {STATUS_LABEL[status]}
                    {run?.durationMs != null && status !== 'running' ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                </div>
                {sub && <div className={run?.detail ? styles.detail : styles.sub}>{sub}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
