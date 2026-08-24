import { useEffect, useRef } from 'react';
import { LOA_PLAYER_ENTRY_URL, loaEntryUrl } from '../../../core/posTypes';
import { loaTransport } from '../loaTransport';
import styles from './LoaFrame.module.css';

/**
 * Embeds the real loa-player as a cross-origin iframe (LOA mode) and registers
 * it with `loaTransport`, which drives it over postMessage. The player has to be
 * running on its own dev server first (:9000); until then the frame shows the
 * browser's own connection error, which is the honest state to show.
 *
 * The playerKey rides in the URL hash (`#playerKey=…`) — the player reads it
 * from `window.location.hash` to boot as that registered player and resolve its
 * tenant, settings and station. Without it the player falls back to a default
 * config and never consumes the order documents we send.
 *
 * The iframe is mounted only while connected, so Disconnect -> Connect tears it
 * down and re-creates it. That is a genuine re-boot: it retries the player's own
 * network fetch, recovering from a failed load without reloading the whole app.
 */
export function LoaFrame({
  playerKey,
  connected,
  baseUrl = LOA_PLAYER_ENTRY_URL,
}: {
  playerKey?: string;
  connected: boolean;
  baseUrl?: string;
}): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null);
  const key = (playerKey ?? '').trim();
  const entryUrl = loaEntryUrl(key, baseUrl);

  useEffect(() => {
    if (!connected) {
      loaTransport.setFrame(null, entryUrl);
      return;
    }
    loaTransport.setFrame(ref.current, entryUrl);
    return () => loaTransport.setFrame(null, entryUrl);
  }, [entryUrl, connected]);

  const shell = (body: JSX.Element): JSX.Element => (
    <section className={styles.wrap}>
      <div className={styles.head}>
        <h3 className={styles.title}>loa-player</h3>
        {key && connected && <span className={styles.url}>{entryUrl}</span>}
      </div>
      {body}
    </section>
  );

  if (!key) {
    return shell(<div className={styles.empty}>Paste a player key in Setup to boot the embedded player.</div>);
  }
  if (!connected) {
    return shell(<div className={styles.empty}>Not connected — press Connect to load the player.</div>);
  }

  return shell(
    // The player derives our origin from document.referrer and only accepts
    // postMessages from it, so the referrer must survive the cross-origin load.
    // `origin` sends exactly the origin regardless of the default policy.
    <iframe ref={ref} className={styles.frame} title="loa-player" src={entryUrl} referrerPolicy="origin" />,
  );
}
