import type { useEmulator } from '../useEmulator';
import {
  REGISTER_TYPES,
  portsForRegisterType,
  channelsForRegisterType,
  isLoaRegisterType,
  isUsRegisterType,
  type Channel,
  type ConnState,
  type RegisterType,
  type Status,
} from '../../../core/posTypes';
import { GearIcon } from '../icons';
import styles from './Header.module.css';

type Emu = ReturnType<typeof useEmulator>;

const CHANNEL_INFO: Record<Channel, { label: string; title: string; port: (c: Emu['config']) => number }> = {
  vj: { label: 'VJ', title: 'Virtual Journal', port: (c) => c.vjPort },
  pole: { label: 'POLE', title: 'Pole display', port: (c) => c.polePort },
  scanner: { label: 'SCAN', title: 'Scanner (player injects)', port: (c) => c.scannerPort },
};

type Overall = 'live' | 'connecting' | 'partial' | 'offline';

function overallState(states: ConnState[]): Overall {
  if (states.every((s) => s === 'connected')) return 'live';
  if (states.some((s) => s === 'connecting')) return 'connecting';
  if (states.some((s) => s === 'connected')) return 'partial';
  return 'offline';
}

const OVERALL_LABEL: Record<Overall, string> = {
  live: 'LIVE',
  connecting: 'CONNECTING',
  partial: 'PARTIAL',
  offline: 'OFFLINE',
};

function StatusPill({
  status,
  config,
  loaConnected,
}: {
  status: Status;
  config: Emu['config'];
  loaConnected: boolean;
}): JSX.Element {
  const channels = channelsForRegisterType(config.registerType);
  // LOA opens no sockets, so its channel list is empty — and overallState([])
  // would read LIVE forever. The iframe being mounted is the real signal.
  const overall = isLoaRegisterType(config.registerType)
    ? loaConnected
      ? 'live'
      : 'offline'
    : overallState(channels.map((ch) => status[ch]));
  return (
    <span className={`${styles.pill} ${styles[overall]}`}>
      <span className={styles.pulsedot} />
      {OVERALL_LABEL[overall]}
    </span>
  );
}

/** Port chips collapsed into one mono string; per-channel detail lives in the title. */
function PortSummary({ status, config }: { status: Status; config: Emu['config'] }): JSX.Element {
  const channels = channelsForRegisterType(config.registerType);
  if (isLoaRegisterType(config.registerType)) return <span className={styles.ports}>postMessage — no sockets</span>;
  const text = channels.map((ch) => `${CHANNEL_INFO[ch].label} :${CHANNEL_INFO[ch].port(config)}`).join(' · ');
  const title = channels
    .map((ch) => `${CHANNEL_INFO[ch].title} :${CHANNEL_INFO[ch].port(config)} — ${status[ch]}`)
    .join('\n');
  return (
    <span className={styles.ports} title={title}>
      {text}
    </span>
  );
}

export type UiMode = 'manual' | 'scenarios';

export function Header({
  e,
  onOpenSetup,
  mode,
  onSetMode,
  scenarioControls,
}: {
  e: Emu;
  onOpenSetup: () => void;
  mode: UiMode;
  onSetMode: (mode: UiMode) => void;
  scenarioControls?: JSX.Element;
}): JSX.Element {
  const locale = e.snapshot.locale;
  return (
    <header className={styles.bar}>
      <span className={styles.mark} aria-hidden="true" />
      <b className={styles.word}>EMULATOR</b>

      <StatusPill status={e.status} config={e.config} loaConnected={e.loaConnected} />
      <PortSummary status={e.status} config={e.config} />

      <div className={styles.mode} role="radiogroup" aria-label="Mode">
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'manual'}
          className={mode === 'manual' ? styles.modeOn : styles.modeBtn}
          onClick={() => onSetMode('manual')}
        >
          Manual
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'scenarios'}
          className={mode === 'scenarios' ? styles.modeOn : styles.modeBtn}
          onClick={() => onSetMode('scenarios')}
        >
          Scenarios
        </button>
      </div>

      <span className={styles.spacer} />

      {mode === 'scenarios' && scenarioControls}

      <select
        className={styles.regtype}
        value={e.config.registerType}
        title="Register type — sets the VJ / pole / scanner ports"
        onChange={(ev) => {
          const registerType = ev.target.value as RegisterType;
          // A manual register-type change leaves the LoL preset behind — drop
          // the flag so the setup drawer doesn't claim a preset that no longer
          // matches the config.
          if (e.lol.enabled) e.setLolPreset({ ...e.lol, enabled: false });
          e.setConfig({ ...e.config, registerType, ...portsForRegisterType(registerType) });
        }}
      >
        {REGISTER_TYPES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>

      {!isUsRegisterType(e.config.registerType) && (
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
