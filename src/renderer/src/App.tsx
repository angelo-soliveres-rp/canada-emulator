import { useState } from 'react';
import { useEmulator } from './useEmulator';
import { useUiMode } from './hooks/ui';
import { CommandBar } from './components/CommandBar';
import { SetupDrawer } from './components/SetupDrawer';
import { QuickKeys } from './components/QuickKeys';
import { TriggersCompleters } from './components/TriggersCompleters';
import { Transaction } from './components/Transaction';
import { WireLog } from './components/WireLog';
import './tokens.css';
import styles from './App.module.css';

function App(): JSX.Element {
  const e = useEmulator();
  const [mode, setMode] = useUiMode();
  const [setupOpen, setSetupOpen] = useState(false);
  const locale = e.snapshot.locale;

  return (
    <div className={styles.app} data-mode={mode}>
      <CommandBar e={e} mode={mode} setMode={setMode} onOpenSetup={() => setSetupOpen(true)} />

      <div className={styles.body}>
        <section className={`${styles.panel} ${styles.keys}`}>
          <QuickKeys e={e} locale={locale} />
        </section>
        <section className={`${styles.panel} ${styles.trig}`}>
          <TriggersCompleters e={e} />
        </section>
        <section className={`${styles.panel} ${styles.txn}`}>
          <Transaction e={e} locale={locale} />
        </section>
        <section className={`${styles.panel} ${styles.log}`}>
          <WireLog e={e} peek={mode === 'control'} onExpand={() => setMode('logs')} />
        </section>
      </div>

      <SetupDrawer e={e} open={setupOpen} onClose={() => setSetupOpen(false)} />
    </div>
  );
}

export default App;
