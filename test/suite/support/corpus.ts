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

/** Names in `<dir>/personal.txt`: carts the owner keeps in the ROM folder that are not corpus (#1289). */
export const parsePersonalList: (text: string) => string[] = core.parsePersonalList
export const personalRoms: (dir?: string) => string[] = core.personalRoms

const isCart = (f: string): boolean => /\.(sfc|smc)$/i.test(f)
const cartsIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter(isCart).sort() : []
const personalSet = (dir: string): Set<string> =>
  new Set(personalRoms(dir).map(n => n.toLowerCase()))

/** Every cart file in the corpus directory, minus those listed in `personal.txt`.
 *  For membership tripwires read inside a case; iterating it to register cases
 *  is banned by the gate. */
export function romsOnDisk(dir: string = ROM_DIR): string[] {
  const personal = personalSet(dir)
  return cartsIn(dir).filter(f => !personal.has(f.toLowerCase()))
}

/** The personal ROMs that are actually on disk: what `romsOnDisk` left out. */
export function personalRomsPresent(dir: string = ROM_DIR): string[] {
  const personal = personalSet(dir)
  return cartsIn(dir).filter(f => personal.has(f.toLowerCase()))
}

/** Carts that are neither personal nor named in CORPUS: what the membership guards must flag. */
export function unlistedCarts(dir: string = ROM_DIR): string[] {
  return romsOnDisk(dir).filter(f => !CORPUS.includes(f))
}

/** Names in `personal.txt` that are also CORPUS carts, case-folded, whether or not the file
 *  is on disk. Listing a corpus cart would silently drop it from every sweep, so it must be empty. */
export function personalCorpusOverlap(dir: string = ROM_DIR): string[] {
  const corpus = new Set(CORPUS.map(n => n.toLowerCase()))
  return personalRoms(dir).filter(n => corpus.has(n.toLowerCase()))
}

/** A Mesen debugger dump, used as render ground truth. */
export const mesenDumpPath = (name: string): string =>
  join(core.TOOLS_ROOT, 'mesen', 'Debugger', name)
