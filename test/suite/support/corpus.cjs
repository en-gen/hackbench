/**
 * Where the ROM corpus lives. The one resolver, shared by the Vitest suites
 * (through `corpus.ts`, which adds typed wrappers) and the Playwright specs,
 * which load as plain CommonJS and so cannot import TypeScript.
 *
 * The corpus is outside the repo, in `<projects>/hackbench-tools/roms/`, so
 * `git clean -x` cannot delete it. Resolution order:
 *
 *   1. `HACKBENCH_ROMS`, returned as given: an explicit override that names
 *      a missing directory should make the suites skip, not fall through to
 *      some other corpus.
 *   2. `HACKBENCH_TOOLS/roms`, likewise unchecked.
 *   3. The nearest ancestor of the repo root holding `hackbench-tools/roms`,
 *      walked to the filesystem root. Probing for `roms/` rather than
 *      `hackbench-tools/` alone is what stops a stray directory of that name,
 *      or a worktree named after it, from shadowing the real one.
 *   4. `<repo root>/test/roms`, the layout before the move.
 *   5. Otherwise the sibling spelling, which does not exist, so every gate
 *      reads false and the suites skip rather than throw during collection.
 */

const fs = require('fs')
const path = require('path')

/** This file is `<root>/test/suite/support/corpus.cjs`. */
const REPO_ROOT = path.resolve(__dirname, '../../..')
const TOOLS = 'hackbench-tools'

/** The nearest ancestor-relative `rel` that exists, walking to the root. */
function findUp(from, rel, exists) {
  for (let dir = from; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    const candidate = path.join(path.dirname(dir), rel)
    if (exists(candidate)) return candidate
  }
  return undefined
}

function resolveToolsRoot(env, repoRoot, exists) {
  if (env.HACKBENCH_TOOLS) return env.HACKBENCH_TOOLS
  const mesen = findUp(repoRoot, path.join(TOOLS, 'mesen'), exists)
  return mesen ? path.dirname(mesen) : path.join(path.dirname(repoRoot), TOOLS)
}

function resolveRomDir(env, repoRoot, exists) {
  if (env.HACKBENCH_ROMS) return env.HACKBENCH_ROMS
  if (env.HACKBENCH_TOOLS) return path.join(env.HACKBENCH_TOOLS, 'roms')
  const found = findUp(repoRoot, path.join(TOOLS, 'roms'), exists)
  if (found) return found
  const legacy = path.join(repoRoot, 'test', 'roms')
  if (exists(legacy)) return legacy
  return path.join(path.dirname(repoRoot), TOOLS, 'roms')
}

/** Vanilla first, then its Lunar Magic resave, then the four hacks. */
const CORPUS = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
]

const ROM_DIR = resolveRomDir(process.env, REPO_ROOT, fs.existsSync)
const TOOLS_ROOT = resolveToolsRoot(process.env, REPO_ROOT, fs.existsSync)

/**
 * Where the `layers_v5` Mesen captures live (en-gen/hackbench#205): an
 * explicit override wins unchecked, else `<tools root>/captures/layers_v5`.
 * Read-only; never written to, since it is a shared OneDrive folder.
 */
function resolveCaptureDir(env, toolsRoot) {
  return env.HACKBENCH_CAPTURES ?? path.join(toolsRoot, 'captures', 'layers_v5')
}
const CAPTURE_DIR = resolveCaptureDir(process.env, TOOLS_ROOT)

module.exports = {
  CORPUS,
  VANILLA: CORPUS[0],
  MAGIC: CORPUS[1],
  GPW2: CORPUS[2],
  INVICTUS: CORPUS[4],
  REPO_ROOT,
  ROM_DIR,
  TOOLS_ROOT,
  CAPTURE_DIR,
  resolveRomDir,
  resolveToolsRoot,
  resolveCaptureDir,
  romPath: name => path.join(ROM_DIR, name),
}
