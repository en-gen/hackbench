/**
 * The ROM corpus, for the Vitest suites. Resolution lives in `corpus.cjs`,
 * shared with the Playwright specs; this adds types and the `RomFile` helper.
 *
 * Ask for a cart through here, never by building a path: gate with
 * `describe.skipIf(!hasRom(VANILLA))`, then read `romPath(VANILLA)`.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RomFile } from '../../../src/rom/RomFile'
import * as core from './corpus.cjs'

type Env = Record<string, string | undefined>
type Exists = (p: string) => boolean

export const CORPUS: readonly string[] = core.CORPUS
export const VANILLA: string = core.VANILLA
export const MAGIC: string = core.MAGIC
export const INVICTUS: string = core.INVICTUS
export const ROM_DIR: string = core.ROM_DIR
export const TOOLS_ROOT: string = core.TOOLS_ROOT
/** The sprite-trace capture set under `fixtures/sprite-trace/`: the vanilla ROM's (SHA-1 6b47bb75) traces with the
 *  45 castle-entry maps re-captured at the real level load (#649). `6b47bb75/` is the superseded set; do not point at it. */
export const SPRITE_TRACE_SET = '6b47bb75-realload-2026-10-09'
/** Where the `layers_v5` Mesen captures live (en-gen/hackbench#205); read-only. */
export const CAPTURE_DIR: string = core.CAPTURE_DIR

export const resolveRomDir: (env: Env, repoRoot: string, exists: Exists) => string =
  core.resolveRomDir
export const resolveToolsRoot: (env: Env, repoRoot: string, exists: Exists) => string =
  core.resolveToolsRoot
export const resolveCaptureDir: (env: Env, toolsRoot: string) => string = core.resolveCaptureDir

/** True when the `layers_v5` capture directory is on this machine. */
export const hasCaptures = (dir: string = CAPTURE_DIR): boolean => existsSync(dir)

/** Full path to a corpus ROM, whether or not it is on this machine. */
export const romPath = (name: string): string => join(ROM_DIR, name)

/** True when that ROM is on this machine. */
export const hasRom = (name: string): boolean => existsSync(romPath(name))

/** True when every named ROM is here. False for an empty list, which
 *  `[].every(...)` is not: that let a sweep over nothing pass. */
export const hasRoms = (names: readonly string[] = CORPUS): boolean =>
  names.length > 0 && names.every(hasRom)

/** A freshly loaded copy, safe to plant bytes into. */
export const freshRom = (name: string = VANILLA): RomFile => RomFile.load(romPath(name))

/** Every cart file in the corpus directory. For membership tripwires read
 *  inside a case; iterating it to register cases is banned by the gate. */
export function romsOnDisk(): string[] {
  if (!existsSync(ROM_DIR)) return []
  return readdirSync(ROM_DIR)
    .filter(f => /\.(sfc|smc)$/i.test(f))
    .sort()
}

/** A Mesen debugger dump, used as render ground truth. */
export const mesenDumpPath = (name: string): string =>
  join(core.TOOLS_ROOT, 'mesen', 'Debugger', name)
