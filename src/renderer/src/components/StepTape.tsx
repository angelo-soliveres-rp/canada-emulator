import type { Scenario } from '../../../core/scenario';
import type { RunState } from '../../../core/scenarioRunner';
import styles from './StepTape.module.css';

function exportJsonl(scenario: Scenario, runState: RunState): void {
  const rows: string[] = [];
  runState.steps.forEach((step, i) => {
    for (const line of step.lines) {
      rows.push(
        JSON.stringify({ step: i + 1, label: scenario.steps[i]?.label ?? '', status: step.status, channel: line.channel, text: line.text }),
      );
    }
  });
  const blob = new Blob([rows.join('\n') + '\n'], { type: 'application/jsonl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${scenario.id}-tape.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
}

const GLYPH: Record<string, string> = { pass: '✓', fail: '✗', running: '▶' };

/** Wire tape grouped per step — what each step actually put on the wire. */
export function StepTape({ scenario, runState }: { scenario: Scenario | null; runState: RunState }): JSX.Element {
  const isActive = scenario !== null && runState.scenarioId === scenario.id && runState.phase !== 'idle';
  const hasLines = isActive && runState.steps.some((s) => s.lines.length > 0);

  return (
    <aside className={styles.wrap} aria-label="Step wire tape">
      <div className={styles.head}>
        <span className={styles.title}>WIRE TAPE</span>
        <span className={styles.subtitle}>grouped per step</span>
        <span className={styles.spacer} />
        {hasLines && scenario && (
          <button className={styles.export} onClick={() => exportJsonl(scenario, runState)}>
            export .jsonl
          </button>
        )}
      </div>
      <div className={styles.groups}>
        {!hasLines ? (
          <div className={styles.empty}>
            {scenario ? 'Run the scenario to capture its tape.' : 'Select a scenario to see its tape.'}
          </div>
        ) : (
          runState.steps.map((step, i) => {
            if (step.lines.length === 0 && step.status !== 'running') return null;
            return (
              <div key={i} className={styles.group}>
                <div className={`${styles.groupHead} ${styles[`h_${step.status}`] ?? ''}`}>
                  STEP {i + 1} {GLYPH[step.status] ?? ''}
                  <span className={styles.groupLabel}>{scenario?.steps[i]?.label}</span>
                </div>
                {step.lines.map((line, j) => (
                  <div key={j} className={styles.row}>
                    <span className={`${styles.tag} ${styles[line.channel]}`}>{line.channel.toUpperCase()}</span>
                    <code className={styles.text}>{line.text.replace(/\r\n$/, '')}</code>
                  </div>
                ))}
                {step.status === 'running' && step.lines.length === 0 && (
                  <div className={styles.waiting}>— awaiting player…</div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
