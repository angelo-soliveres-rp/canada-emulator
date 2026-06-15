import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Locate the CK Player 2.0 repo so the __roundtrip__ suite can import its REAL
 * radiant6-canada parsers. Checks CKP2_DIR, then walks upward looking for a
 * sibling checkout named `omni` or `CKPlayer2.0` (worktree-safe).
 */
function findPlayerRepo(): string | null {
  const marker = ['electron', 'plugins', 'radiant6-canada'];
  const hasParsers = (dir: string): boolean => existsSync(join(dir, ...marker));

  const fromEnv = process.env.CKP2_DIR;
  if (fromEnv) {
    if (hasParsers(fromEnv)) return fromEnv;
    console.warn(
      `[vitest] CKP2_DIR=${fromEnv} is set but ${join(...marker)} was not found under it — ` +
        'ignoring it and falling back to the sibling-checkout search.',
    );
  }

  let dir = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    for (const name of ['omni', 'CKPlayer2.0']) {
      const candidate = join(dir, name);
      if (hasParsers(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const playerRepo = findPlayerRepo();
const skipRoundtrip = process.env.CKP2_SKIP_ROUNDTRIP === '1';
const runRoundtrip = Boolean(playerRepo) && !skipRoundtrip;
if (!playerRepo && !skipRoundtrip) {
  // In CI a missing player repo must be loud: otherwise the wire-parity
  // contract suite is silently excluded and the run still exits 0.
  if (process.env.CI) {
    throw new Error(
      '[vitest] CK Player 2.0 repo not found — the src/core/__roundtrip__ wire-parity ' +
        'contract tests cannot run in CI. Set CKP2_DIR to a CK Player 2.0 checkout ' +
        '(containing electron/plugins/radiant6-canada) or check out omni/ or CKPlayer2.0/ ' +
        'as a sibling. To deliberately opt out, set CKP2_SKIP_ROUNDTRIP=1.',
    );
  }
  console.warn(
    '[vitest] CK Player 2.0 repo not found (set CKP2_DIR or check out omni/ as a sibling) — ' +
      'SKIPPING the src/core/__roundtrip__ encoder↔parser contract tests.',
  );
}

export default defineConfig({
  resolve: {
    alias: playerRepo ? { '@ckp2': playerRepo } : {},
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(runRoundtrip ? [] : ['src/core/__roundtrip__/**'])],
  },
});
