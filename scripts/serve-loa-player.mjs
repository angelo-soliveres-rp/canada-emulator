/**
 * Serve the loa-player that LOA mode embeds.
 *
 * LOA mode drives a REAL player in an iframe over postMessage, so that player
 * has to be running somewhere. It lives in its own repo with its own webpack
 * dev server on :9000 — the port `LOA_PLAYER_ENTRY_URL` points at — so this
 * script locates that checkout and delegates to its `serve:player`, rather than
 * duplicating its build here.
 *
 * Resolution mirrors vitest.config.ts's `findPlayerRepo`: `LOA_PLAYER_DIR` wins,
 * otherwise walk upward for a sibling checkout named `loa-player`. Both are
 * worktree-safe.
 *
 * Usage: npm run serve:player   (leave it running, then pick LOA in the emulator)
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Present in a loa-player checkout and nothing else we'd walk past. */
const MARKER = 'webpack.config.ts';
const PORT = 9000;

function isPlayerRepo(dir) {
  return existsSync(join(dir, MARKER)) && existsSync(join(dir, 'package.json'));
}

function findPlayerRepo() {
  const fromEnv = process.env.LOA_PLAYER_DIR;
  if (fromEnv) {
    const abs = resolve(fromEnv);
    if (isPlayerRepo(abs)) return abs;
    console.warn(
      `[serve:player] LOA_PLAYER_DIR=${fromEnv} is set but ${MARKER} was not found under it — ` +
        'ignoring it and falling back to the sibling-checkout search.',
    );
  }
  let dir = resolve(HERE, '..');
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'loa-player');
    if (isPlayerRepo(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const repo = findPlayerRepo();
if (!repo) {
  console.error(
    '[serve:player] No loa-player checkout found.\n' +
      '  Check one out as a sibling of this repo, or point LOA_PLAYER_DIR at it:\n' +
      '    LOA_PLAYER_DIR=/path/to/loa-player npm run serve:player',
  );
  process.exit(1);
}

// The player's dev server is webpack + 60-odd deps of its own. Say so plainly
// instead of letting `npm run` fail with a bare "webpack: not found".
if (!existsSync(join(repo, 'node_modules'))) {
  console.error(
    `[serve:player] ${repo} has no node_modules — install its dependencies first:\n` +
      `    (cd ${repo} && npm install)`,
  );
  process.exit(1);
}

// Two setup steps the player's own `serve:player` assumes and fails opaquely
// without. Both are cheap and local, so do them rather than make the operator
// decode a webpack stack trace.

// 1. webpack.config.ts writes dist/version.json while merely LOADING the config,
//    so the directory has to exist first. The player's own `serve` script gets
//    this for free from build:emulator — which builds its Angular emulator UI and
//    its microsite, neither of which LOA mode uses (we ARE the emulator), so
//    creating the directory is the whole requirement.
mkdirSync(join(repo, 'dist'), { recursive: true });

// 2. Without config/development.properties the config decides it must be running
//    in CI and appends to process.env.GITHUB_ENV, which is undefined locally —
//    a bare ERR_INVALID_ARG_TYPE. The file is git-ignored on purpose and
//    config/example.properties is the documented starting point.
const localProps = join(repo, 'config', 'development.properties');
const exampleProps = join(repo, 'config', 'example.properties');
if (!existsSync(localProps)) {
  if (!existsSync(exampleProps)) {
    console.error(`[serve:player] ${localProps} is missing and there is no example.properties to seed it from.`);
    process.exit(1);
  }
  copyFileSync(exampleProps, localProps);
  console.log(`[serve:player] seeded ${localProps} from example.properties (git-ignored; edit it to point at another environment)`);
}

console.log(`[serve:player] loa-player: ${repo}`);
console.log(`[serve:player] serving on http://localhost:${PORT}/index.html`);
console.log('[serve:player] leave this running, then pick "LOA (loa-player)" in the emulator and press Connect.');

// stdio inherit so webpack's own progress/errors are the output, and the exit
// code propagates — this script is a locator, not a wrapper with opinions.
const child = spawn('npm', ['run', 'serve:player'], { cwd: repo, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
child.on('error', (err) => {
  console.error(`[serve:player] failed to start: ${err.message}`);
  process.exit(1);
});
