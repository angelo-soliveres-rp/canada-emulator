import { useState } from 'react';
import type { Scenario } from '../../../core/scenario';
import type { ScenarioResult } from '../hooks/scenarioStore';
import { CloseIcon } from '../icons';
import styles from './ScenarioPanel.module.css';

function resultLabel(result: ScenarioResult | undefined): { text: string; tone: 'ok' | 'fail' | 'faint' } {
  if (!result) return { text: 'never run', tone: 'faint' };
  const at = new Date(result.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return result.outcome === 'pass'
    ? { text: `PASS ${at}`, tone: 'ok' }
    : { text: `FAIL @${(result.failedStep ?? 0) + 1}`, tone: 'fail' };
}

export function ScenarioPanel({
  scenarios,
  results,
  selectedId,
  runningId,
  recordedCount,
  onSelect,
  onDelete,
  onSaveRecording,
  onImport,
}: {
  scenarios: Scenario[];
  results: Record<string, ScenarioResult>;
  selectedId: string | null;
  runningId: string | null;
  recordedCount: number;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onSaveRecording: (name: string) => boolean;
  onImport: () => Promise<string | null>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const save = (): void => {
    if (onSaveRecording(name)) {
      setName('');
      setNotice(null);
    } else {
      setNotice(recordedCount === 0 ? 'Nothing recorded yet — do something on the bench first.' : 'Name required.');
    }
  };

  const importFromClipboard = async (): Promise<void> => {
    setNotice((await onImport()) ?? null);
  };

  return (
    <aside className={styles.panel} aria-label="Scenario library">
      <div className={styles.head}>
        <span className={styles.title}>SCENARIOS</span>
        <span className={styles.count}>{scenarios.length}</span>
        <span className={styles.spacer} />
        <button className={styles.import} onClick={() => void importFromClipboard()} title="Import scenario JSON from clipboard">
          Import
        </button>
      </div>

      <div className={styles.list}>
        {scenarios.length === 0 ? (
          <div className={styles.empty}>No scenarios yet. Ring items on the bench, then save the recording below.</div>
        ) : (
          scenarios.map((s) => {
            const r = resultLabel(results[s.id]);
            const running = runningId === s.id;
            return (
              <div key={s.id} className={`${styles.row} ${selectedId === s.id ? styles.rowOn : ''}`}>
                <button className={styles.rowBtn} onClick={() => onSelect(s.id)}>
                  <span className={styles.name}>{s.name}</span>
                  <span className={styles.meta}>
                    {s.steps.length} steps
                    {' · '}
                    <span className={running ? styles.running : styles[r.tone]}>{running ? 'running' : r.text}</span>
                  </span>
                </button>
                <button
                  className={styles.del}
                  onClick={() => onDelete(s.id)}
                  title={`Delete "${s.name}"`}
                  aria-label={`Delete ${s.name}`}
                >
                  <CloseIcon size={11} />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className={styles.saveBox}>
        <div className={styles.hint}>
          Every manual session is recorded — <b>Save as scenario</b> turns what you just did into a replayable script.
        </div>
        <div className={styles.saveRow}>
          <input
            className={styles.nameInput}
            value={name}
            placeholder="scenario name…"
            spellCheck={false}
            onChange={(ev) => setName(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') save();
            }}
          />
          <button className={styles.saveBtn} onClick={save} disabled={recordedCount === 0 || !name.trim()}>
            Save ({recordedCount})
          </button>
        </div>
        {notice && <div className={styles.notice}>{notice}</div>}
      </div>
    </aside>
  );
}
