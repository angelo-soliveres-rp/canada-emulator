import { useEffect, useState } from 'react';
import type { useEmulator } from '../useEmulator';
import { useProfiles } from '../hooks/profiles';
import { CloseIcon } from '../icons';
import styles from './SetupDrawer.module.css';

type Emu = ReturnType<typeof useEmulator>;
type RegPhase = 'idle' | 'busy' | 'done';

export function SetupDrawer({ e, open, onClose }: { e: Emu; open: boolean; onClose: () => void }): JSX.Element | null {
  const [showRaw, setShowRaw] = useState(false);
  const { profiles, save, remove } = useProfiles();
  const [profileName, setProfileName] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');
  // Register feedback: 'busy' while in flight; once 'done', the success/fail
  // banner derives from globalInit / globalInitError (updated by the hook).
  const [regPhase, setRegPhase] = useState<RegPhase>('idle');

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const gi = e.globalInit;

  const doRegister = async (): Promise<void> => {
    setRegPhase('busy');
    await e.registerPlayer();
    setRegPhase('done');
  };

  const applyProfile = (name: string): void => {
    setSelectedProfile(name);
    const p = profiles.find((x) => x.name === name);
    if (p) {
      e.setPlayerConfig({ ...e.playerConfig, playerKey: p.playerKey });
      setProfileName(p.name);
      setRegPhase('idle');
    }
  };

  return (
    <div className={styles.scrim} onClick={onClose}>
      <aside className={styles.drawer} onClick={(ev) => ev.stopPropagation()} role="dialog" aria-modal="true" aria-label="Connection setup">
        <header className={styles.head}>
          <h2>Connection Setup</h2>
          <button className={styles.close} onClick={onClose} aria-label="Close setup">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className={styles.scroll}>
          <section className={styles.group}>
            <span className={styles.glabel}>Player</span>

            {profiles.length > 0 && (
              <label className={styles.field}>
                <span>saved profiles</span>
                <div className={styles.profilerow}>
                  <select value={selectedProfile} onChange={(ev) => applyProfile(ev.target.value)}>
                    <option value="">— choose a profile —</option>
                    {profiles.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {selectedProfile && (
                    <button
                      className={styles.danger}
                      title={`Delete profile "${selectedProfile}"`}
                      onClick={() => {
                        remove(selectedProfile);
                        setSelectedProfile('');
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </label>
            )}

            <label className={styles.field}>
              <span>player.key</span>
              <input
                value={e.playerConfig.playerKey}
                placeholder="paste player.key…"
                spellCheck={false}
                onChange={(ev) => {
                  e.setPlayerConfig({ ...e.playerConfig, playerKey: ev.target.value });
                  setRegPhase('idle');
                }}
              />
            </label>

            <label className={styles.field}>
              <span>save as profile</span>
              <div className={styles.profilerow}>
                <input
                  value={profileName}
                  placeholder="profile name (e.g. CA e2e lane 1)"
                  spellCheck={false}
                  onChange={(ev) => setProfileName(ev.target.value)}
                />
                <button
                  className={styles.ghost}
                  disabled={!profileName.trim() || !e.playerConfig.playerKey.trim()}
                  onClick={() => {
                    save(profileName, e.playerConfig.playerKey);
                    setSelectedProfile(profileName.trim());
                  }}
                >
                  Save
                </button>
              </div>
            </label>

            <div className={styles.actions}>
              <button className={styles.primary} disabled={regPhase === 'busy' || !e.playerConfig.playerKey.trim()} onClick={() => void doRegister()}>
                {regPhase === 'busy' ? 'Registering…' : 'Register'}
              </button>
            </div>

            {regPhase === 'busy' && <p className={styles.busyline}>Probing datacenters…</p>}
            {regPhase === 'done' &&
              (e.globalInitError ? (
                <p className={styles.failbanner}>Register failed: {e.globalInitError}</p>
              ) : gi ? (
                <p className={styles.okbanner}>
                  Registered: {gi.playerCode} (tenant {gi.tenant}) via {gi.datacenter}
                </p>
              ) : (
                <p className={styles.failbanner}>Register failed: no configuration returned</p>
              ))}

            <p className={styles.hint}>Register resolves the datacenter, player code &amp; backend automatically (like CKP2 + legacy).</p>
          </section>

          {(gi || e.globalInitError) && (
            <section className={styles.group}>
              <span className={styles.glabel}>Registration</span>
              {gi ? (
                <>
                  <dl className={styles.kv}>
                    <div>
                      <dt>player.code</dt>
                      <dd className={styles.ok}>{gi.playerCode}</dd>
                    </div>
                    <div>
                      <dt>tenant</dt>
                      <dd>{gi.tenant}</dd>
                    </div>
                    <div>
                      <dt>datacenter</dt>
                      <dd>{gi.datacenter}</dd>
                    </div>
                  </dl>
                  <button className={styles.linklike} onClick={() => setShowRaw((v) => !v)}>
                    {showRaw ? 'Hide' : 'Show'} raw config
                  </button>
                  {showRaw && <pre className={styles.raw}>{gi.raw}</pre>}
                </>
              ) : (
                <p className={styles.err}>Register failed: {e.globalInitError}</p>
              )}
            </section>
          )}

          <section className={styles.group}>
            <span className={styles.glabel}>Connection</span>
            <label className={styles.field}>
              <span>host</span>
              <input value={e.config.host} spellCheck={false} onChange={(ev) => e.setConfig({ ...e.config, host: ev.target.value })} />
            </label>
            <div className={styles.ports}>
              <span>VJ <b>:{e.config.vjPort}</b></span>
              <span>Pole <b>:{e.config.polePort}</b></span>
            </div>
            <div className={styles.actions}>
              <button className={styles.primary} onClick={() => void e.connect()}>
                Connect
              </button>
              <button className={styles.ghost} onClick={() => void e.disconnect()}>
                Disconnect
              </button>
            </div>
          </section>

          <section className={styles.group}>
            <span className={styles.glabel}>Data</span>
            <div className={styles.actions}>
              <button className={styles.ghost} onClick={() => void e.reloadQuickKeys()}>
                Reload quick keys
              </button>
              <button className={styles.ghost} onClick={() => void e.loadPricebook()}>
                Reload pricebook
              </button>
            </div>
            {e.pricebookStatus && (
              <p className={e.pricebookStatus.ok ? styles.okline : styles.err}>
                {e.pricebookStatus.ok ? `Pricebook: ${e.pricebookStatus.count} items` : `Pricebook error: ${e.pricebookStatus.error}`}
              </p>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
