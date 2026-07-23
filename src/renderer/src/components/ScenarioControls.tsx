import { SPEED_OPTIONS } from '../hooks/scenarioRun';
import { PlayIcon } from '../icons';
import styles from './ScenarioControls.module.css';

/** Run / Step / Stop / speed — the header controls in scenarios mode. */
export function ScenarioControls({
  canRun,
  running,
  stepMode,
  speed,
  onRun,
  onStep,
  onResume,
  onStop,
  onSetSpeed,
}: {
  canRun: boolean;
  running: boolean;
  stepMode: boolean;
  speed: number;
  onRun: () => void;
  onStep: () => void;
  onResume: () => void;
  onStop: () => void;
  onSetSpeed: (speed: number) => void;
}): JSX.Element {
  return (
    <div className={styles.controls}>
      <button
        className={styles.run}
        disabled={!canRun && !(running && stepMode)}
        onClick={running && stepMode ? onResume : onRun}
        title={running && stepMode ? 'Resume free-running' : 'Run the selected scenario'}
      >
        <PlayIcon size={12} />
        Run
      </button>
      <button
        className={styles.step}
        disabled={!canRun && !running}
        onClick={onStep}
        title="Execute the next step only"
      >
        Step
      </button>
      {running && (
        <button className={styles.stop} onClick={onStop} title="Stop the run">
          Stop
        </button>
      )}
      <select
        className={styles.speed}
        value={speed}
        title="Replay speed — scales the recorded pauses between steps"
        aria-label="Replay speed"
        onChange={(ev) => onSetSpeed(Number(ev.target.value))}
      >
        {SPEED_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {s}× speed
          </option>
        ))}
      </select>
    </div>
  );
}
