import type { useEmulator } from '../useEmulator';
import type { UiMode } from '../hooks/ui';
import {
  REGISTER_TYPES,
  portsForRegisterType,
  channelsForRegisterType,
  type Channel,
  type ConnState,
  type RegisterType,
  type Status,
} from '../../../core/posTypes';
import { GearIcon } from '../icons';
import styles from './CommandBar.module.css';

type Emu = ReturnType<typeof useEmulator>;

const MODES: ReadonlyArray<{ value: UiMode; label: string }> = [
  { value: 'control', label: 'Control' },
  { value: 'split', label: 'Split' },
  { value: 'logs', label: 'Logs' },
];

function dotClass(s: ConnState): string {
  return s === 'connected' ? styles.on : s === 'connecting' ? styles.connecting : styles.off;
}

const CHANNEL_CHIPS: Record<Channel, { label: string; title: string; port: (c: Emu['config']) => number }> = {
  vj: { label: 'VJ', title: 'Virtual Journal', port: (c) => c.vjPort },
  pole: { label: 'POLE', title: 'Pole display', port: (c) => c.polePort },
  scanner: { label: 'SCAN', title: 'Scanner (player injects)', port: (c) => c.scannerPort },
};

function StatusCluster({ status, config }: { status: Status; config: Emu['config'] }): JSX.Element {
  const channels = channelsForRegisterType(config.registerType);
  const states: ConnState[] = channels.map((ch) => status[ch]);
  const overall = states.every((s) => s === 'connected')
    ? 'live'
    : states.some((s) => s === 'connecting')
      ? 'connecting'
      : states.some((s) => s === 'connected')
        ? 'partial'
        : 'offline';
  const label =
    overall === 'live' ? 'LIVE' : overall === 'connecting' ? 'CONNECTING' : overall === 'partial' ? 'PARTIAL' : 'OFFLINE';
  return (
    <div className={styles.status}>
      <span className={`${styles.pill} ${styles[overall]}`}>
        <span className={styles.pulsedot} />
        {label}
      </span>
      <span className={styles.chips}>
        {channels.map((ch) => {
          const chip = CHANNEL_CHIPS[ch];
          return (
            <span key={ch} className={styles.chip} title={`${chip.title} — ${status[ch]}`}>
              <span className={`${styles.dot} ${dotClass(status[ch])}`} />
              {chip.label}
              <small>:{chip.port(config)}</small>
            </span>
          );
        })}
      </span>
    </div>
  );
}

export function CommandBar({
  e,
  mode,
  setMode,
  onOpenSetup,
}: {
  e: Emu;
  mode: UiMode;
  setMode: (m: UiMode) => void;
  onOpenSetup: () => void;
}): JSX.Element {
  const locale = e.snapshot.locale;
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.mark}>CA</span>
        <span className={styles.word}>
          <b>CANADA</b>
          <span>EMULATOR</span>
        </span>
      </div>

      <StatusCluster status={e.status} config={e.config} />

      <select
        className={styles.regtype}
        value={e.config.registerType}
        title="Register type — sets the VJ / pole / scanner ports"
        onChange={(ev) => {
          const registerType = ev.target.value as RegisterType;
          e.setConfig({ ...e.config, registerType, ...portsForRegisterType(registerType) });
        }}
      >
        {REGISTER_TYPES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>

      <span className={styles.spacer} />

      <div className={styles.modes} role="radiogroup" aria-label="Layout mode">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={mode === m.value}
            className={mode === m.value ? styles.modeOn : styles.mode}
            onClick={() => setMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {e.config.registerType !== 'radiant6-us' && (
        <div className={styles.locale} role="radiogroup" aria-label="Locale">
          <button
            type="button"
            role="radio"
            aria-checked={locale === 'en'}
            className={locale === 'en' ? styles.locOn : styles.loc}
            onClick={() => e.setLocale('en')}
          >
            EN
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={locale === 'fr'}
            className={locale === 'fr' ? styles.locOn : styles.loc}
            onClick={() => e.setLocale('fr')}
          >
            FR
          </button>
        </div>
      )}

      <button className={styles.setup} onClick={onOpenSetup} title="Connection setup" aria-label="Connection setup">
        <GearIcon size={16} />
        <span className={styles.setupLabel}>Setup</span>
      </button>
    </header>
  );
}
