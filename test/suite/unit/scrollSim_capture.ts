/**
 * scrollSim_capture.ts - shared loader + comparator for the
 * scrollSim_*.test.ts capture-validation tests.
 *
 * Each test takes a path to a Mesen `l2_scroll.csv` capture, reads
 * row 1 as the seed, builds a simulator, and verifies subsequent rows
 * frame-by-frame. The frame-1 helper validates the post-setup state;
 * the full-walk helper validates per-frame motion with an optional
 * field-exclusion mask (for levels where Mario-camera tracking
 * diverges) and a game-freeze guard.
 */

import * as fs from 'fs'
import { resolve } from 'path'
import { existsSync } from 'fs'
import { RomFile } from '../../../src/rom/RomFile'
import { buildScrollSimulator, type ScrollState } from '../../../src/rom/scrollSim'

/** Path to the vanilla SMW ROM used as the source of truth for all
 *  scroll-sim ROM reads. Tests check `vanillaRomPresent` and skip
 *  gracefully when the gitignored ROM isn't present.
 *
 *  Resolves across multiple candidates because git worktrees don't
 *  share the gitignored `test/roms/` directory - the ROM only lives
 *  in the canonical checkout. */
function resolveVanillaRom(): string | null {
  const candidates = [
    resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc'),
    'C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc',
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}
const _vanillaRomPath = resolveVanillaRom()
export const VANILLA_ROM_PATH: string = _vanillaRomPath ?? ''
export const vanillaRomPresent: boolean = _vanillaRomPath !== null

let _cachedRom: RomFile | null = null
export function loadVanillaRom(): RomFile {
  if (_cachedRom !== null) return _cachedRom
  _cachedRom = RomFile.load(VANILLA_ROM_PATH)
  return _cachedRom
}

export interface CaptureRow {
  frame: number
  l1x: number
  l1y: number
  l2x: number
  l2y: number
  l1cmd: number
  l2cmd: number
  l1bits: number
  l2bits: number
  l1type: number
  l2type: number
  l1timer: number
  l2timer: number
  l1xspd: number
  l1yspd: number
  l2xspd: number
  l2yspd: number
  l1xupd: number
  l1yupd: number
  l2xupd: number
  l2yupd: number
  nl1x: number
  nl1y: number
  nl2x: number
  nl2y: number
  l1dir: number
  shakeY: number
  marioX: number
  marioY: number
  horizL2: number
  vertL2: number
  scrollIdx: number
}

export function loadCapture(csvPath: string): CaptureRow[] {
  const text = fs.readFileSync(csvPath, 'utf8')
  const lines = text.trim().split('\n')
  const header = lines[0].split(',')
  const idx: Record<string, number> = {}
  header.forEach((name, i) => {
    idx[name] = i
  })
  return lines.slice(1).map(line => {
    const c = line.split(',').map(s => parseInt(s, 10))
    return {
      frame: c[idx.frame],
      l1x: c[idx.l1x],
      l1y: c[idx.l1y],
      l2x: c[idx.l2x],
      l2y: c[idx.l2y],
      l1cmd: c[idx.l1cmd],
      l2cmd: c[idx.l2cmd],
      l1bits: c[idx.l1bits],
      l2bits: c[idx.l2bits],
      l1type: c[idx.l1type],
      l2type: c[idx.l2type],
      l1timer: c[idx.l1timer],
      l2timer: c[idx.l2timer],
      l1xspd: c[idx.l1xspd],
      l1yspd: c[idx.l1yspd],
      l2xspd: c[idx.l2xspd],
      l2yspd: c[idx.l2yspd],
      l1xupd: c[idx.l1xupd],
      l1yupd: c[idx.l1yupd],
      l2xupd: c[idx.l2xupd],
      l2yupd: c[idx.l2yupd],
      nl1x: c[idx.nl1x],
      nl1y: c[idx.nl1y],
      nl2x: c[idx.nl2x],
      nl2y: c[idx.nl2y],
      l1dir: c[idx.l1dir],
      shakeY: c[idx.shakeY],
      marioX: c[idx.marioX],
      marioY: c[idx.marioY],
      horizL2: c[idx.horizL2],
      vertL2: c[idx.vertL2],
      scrollIdx: c[idx.scrollIdx],
    }
  })
}

export type FieldKey =
  | 'l1x'
  | 'l1y'
  | 'l2x'
  | 'l2y'
  | 'l1type'
  | 'l2type'
  | 'l1timer'
  | 'l2timer'
  | 'l1xspd'
  | 'l1yspd'
  | 'l2xspd'
  | 'l2yspd'
  | 'l1xupd'
  | 'l1yupd'
  | 'l2xupd'
  | 'l2yupd'
  | 'nl1x'
  | 'nl1y'
  | 'nl2x'
  | 'nl2y'

const FIELD_MAP: Record<FieldKey, keyof ScrollState> = {
  l1x: 'layer1XPos',
  l1y: 'layer1YPos',
  l2x: 'layer2XPos',
  l2y: 'layer2YPos',
  l1type: 'layer1ScrollType',
  l2type: 'layer2ScrollType',
  l1timer: 'layer1ScrollTimer',
  l2timer: 'layer2ScrollTimer',
  l1xspd: 'layer1ScrollXSpeed',
  l1yspd: 'layer1ScrollYSpeed',
  l2xspd: 'layer2ScrollXSpeed',
  l2yspd: 'layer2ScrollYSpeed',
  l1xupd: 'layer1ScrollXPosUpd',
  l1yupd: 'layer1ScrollYPosUpd',
  l2xupd: 'layer2ScrollXPosUpd',
  l2yupd: 'layer2ScrollYPosUpd',
  nl1x: 'nextLayer1XPos',
  nl1y: 'nextLayer1YPos',
  nl2x: 'nextLayer2XPos',
  nl2y: 'nextLayer2YPos',
}

const ALL_FIELDS: readonly FieldKey[] = [
  'l1x',
  'l1y',
  'l2x',
  'l2y',
  'l1type',
  'l2type',
  'l1timer',
  'l2timer',
  'l1xspd',
  'l1yspd',
  'l2xspd',
  'l2yspd',
  'l1xupd',
  'l1yupd',
  'l2xupd',
  'l2yupd',
  'nl1x',
  'nl1y',
  'nl2x',
  'nl2y',
]

/**
 * Compare a simulator state against a capture row over the given field
 * subset. Returns the first divergent field name and value pair, or
 * null if all checked fields match.
 */
export function firstMismatch(
  s: ScrollState,
  r: CaptureRow,
  fields: readonly FieldKey[] = ALL_FIELDS,
): string | null {
  for (const k of fields) {
    const sim = s[FIELD_MAP[k]] as number
    const cap = r[k]
    if (sim !== cap) return `${k} sim=${sim} cap=${cap}`
  }
  return null
}

/**
 * Build a simulator seeded from capture row 1. Loads the vanilla ROM
 * (cached) so all scroll handlers can read their data tables from ROM.
 * Optional `extra` lets a test pass per-level fields that aren't in
 * the Mesen capture (e.g. `lastScreenHoriz` for cmd $0C, sourced from
 * the level header in production).
 */
export function simFromCapture(
  r0: CaptureRow,
  extra: { lastScreenHoriz?: number; horizLayer1Setting?: number } = {},
) {
  const rom = loadVanillaRom()
  return buildScrollSimulator(rom, {
    layer1XPos: r0.l1x,
    layer1YPos: r0.l1y,
    layer2XPos: r0.l2x,
    layer2YPos: r0.l2y,
    layer1ScrollCmd: r0.l1cmd,
    layer2ScrollCmd: r0.l2cmd,
    layer1ScrollBits: r0.l1bits,
    layer2ScrollBits: r0.l2bits,
    horizLayer2Setting: r0.horizL2,
    vertLayer2Setting: r0.vertL2,
    marioSpawnX: r0.marioX,
    marioSpawnY: r0.marioY,
    screenMode: 0,
    lastScreenHoriz: extra.lastScreenHoriz,
    marioWalkRate: 0, // tests inject exact marioX; no auto-advance
    horizLayer1Setting: extra.horizLayer1Setting ?? 0, // disabled unless test opts in
  })
}

/**
 * Detect the first frame at which the capture starts emitting frozen
 * rows (Mesen `l2_dump.lua` keeps writing after Mario dies; the
 * SpriteLock gate in `CODE_05BC76` halts cmd handlers but our sim
 * doesn't model SpriteLock). Returns the highest frame index whose
 * row N is still "active" (different from row N+1 in any of the
 * specified freeze-detection fields).
 */
export function detectActiveFrames(
  cap: readonly CaptureRow[],
  freezeKeys: readonly FieldKey[] = ['l2xspd', 'l2yspd', 'l2xupd', 'l2yupd', 'nl1x', 'nl2x'],
): number {
  let active = 0
  for (let r = 1; r < cap.length; r++) {
    const cur = cap[r - 1],
      nxt = cap[r]
    let frozen = true
    for (const k of freezeKeys) {
      if (cur[k] !== nxt[k]) {
        frozen = false
        break
      }
    }
    if (frozen) break
    active = r
  }
  return active
}
