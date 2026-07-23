import { useCallback, useState } from 'react';
import { useEmulator } from './useEmulator';
import { Header, type UiMode } from './components/Header';
import { SetupDrawer } from './components/SetupDrawer';
import { Bench } from './components/Bench';
import { RightRail } from './components/RightRail';
import { LogDock } from './components/LogDock';
import { ScenarioPanel } from './components/ScenarioPanel';
import { ScenarioSteps } from './components/ScenarioSteps';
import { StepTape } from './components/StepTape';
import { ScenarioControls } from './components/ScenarioControls';
import { useScenarioStore } from './hooks/scenarioStore';
import { useScenarioRunner } from './hooks/scenarioRun';
import { useScenarioRecording } from './hooks/scenarioRecord';
import type { RunState } from '../../core/scenarioRunner';
import './tokens.css';
import styles from './App.module.css';

const MODE_KEY = 'r6ca.uiMode';

function readMode(): UiMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'scenarios' ? 'scenarios' : 'manual';
  } catch {
    return 'manual';
  }
}

function App(): JSX.Element {
  const e = useEmulator();
  const [setupOpen, setSetupOpen] = useState(false);
  const [mode, setModeState] = useState<UiMode>(readMode);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const store = useScenarioStore();
  const onFinished = useCallback(
    (scenarioId: string, final: RunState) => {
      if (final.outcome === 'pass' || final.outcome === 'fail') {
        store.recordResult(scenarioId, { outcome: final.outcome, failedStep: final.failedStep, at: Date.now() });
      }
    },
    [store],
  );
  const runner = useScenarioRunner(e, onFinished);
  const recording = useScenarioRecording(e, runner.state.phase === 'running');

  const setMode = (next: UiMode): void => {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // ignore storage failures
    }
  };

  const selected = store.scenarios.find((s) => s.id === selectedId) ?? store.scenarios[0] ?? null;
  const running = runner.state.phase === 'running';

  const saveRecording = (name: string): boolean => {
    const scenario = recording.saveAs(name);
    if (!scenario) return false;
    store.save(scenario);
    setSelectedId(scenario.id);
    setModeState('scenarios');
    return true;
  };

  const importFromClipboard = async (): Promise<string | null> => {
    try {
      const res = store.importScenario(await navigator.clipboard.readText());
      if (res.ok) {
        setSelectedId(res.id);
        return null;
      }
      return `Import failed: ${res.error}`;
    } catch (err) {
      return `Import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  const exportToClipboard = (id: string): void => {
    const json = store.exportScenario(id);
    if (json) void navigator.clipboard?.writeText(json);
  };

  return (
    <div className={styles.app}>
      <Header
        e={e}
        onOpenSetup={() => setSetupOpen(true)}
        mode={mode}
        onSetMode={setMode}
        scenarioControls={
          <ScenarioControls
            canRun={selected !== null && selected.steps.length > 0 && !running}
            running={running}
            stepMode={runner.state.stepMode}
            speed={runner.speed}
            onRun={() => selected && runner.run(selected)}
            onStep={() => selected && runner.stepOnce(selected)}
            onResume={runner.resume}
            onStop={runner.abort}
            onSetSpeed={runner.setSpeed}
          />
        }
      />

      {mode === 'manual' ? (
        <div className={styles.body}>
          <Bench e={e} />
          <RightRail e={e} locale={e.snapshot.locale} />
        </div>
      ) : (
        <div className={styles.scenarioBody}>
          <ScenarioPanel
            scenarios={store.scenarios}
            results={store.results}
            selectedId={selected?.id ?? null}
            runningId={running ? runner.state.scenarioId : null}
            recordedCount={recording.count}
            onSelect={setSelectedId}
            onDelete={store.remove}
            onSaveRecording={saveRecording}
            onImport={importFromClipboard}
          />
          <ScenarioSteps scenario={selected} runState={runner.state} onExport={exportToClipboard} />
          <StepTape scenario={selected} runState={runner.state} />
        </div>
      )}

      <LogDock e={e} />

      <SetupDrawer e={e} open={setupOpen} onClose={() => setSetupOpen(false)} />
    </div>
  );
}

export default App;
