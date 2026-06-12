import { useCallback, useState } from 'react';

export interface PlayerProfile {
  name: string;
  playerKey: string;
}

const KEY = 'r6ca.profiles';

function read(): PlayerProfile[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p): p is PlayerProfile => !!p && typeof p.name === 'string' && typeof p.playerKey === 'string')
      .map((p) => ({ name: p.name.trim(), playerKey: p.playerKey.trim() }));
  } catch {
    return [];
  }
}

/** Named player.key profiles, persisted to localStorage. */
export function useProfiles(): {
  profiles: PlayerProfile[];
  save: (name: string, playerKey: string) => void;
  remove: (name: string) => void;
} {
  const [profiles, setProfiles] = useState<PlayerProfile[]>(read);

  const persist = useCallback((next: PlayerProfile[]): void => {
    setProfiles(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // ignore storage failures
    }
  }, []);

  const save = useCallback(
    (name: string, playerKey: string): void => {
      const n = name.trim();
      const k = playerKey.trim();
      if (!n || !k) return;
      persist(
        [...profiles.filter((p) => p.name !== n), { name: n, playerKey: k }].sort((a, b) => a.name.localeCompare(b.name)),
      );
    },
    [profiles, persist],
  );

  const remove = useCallback((name: string): void => persist(profiles.filter((p) => p.name !== name)), [profiles, persist]);

  return { profiles, save, remove };
}
