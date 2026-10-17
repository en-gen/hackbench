/** Loads the `layers_v5` Mesen captures (sprite_spawns, capture_summary, scroll_pass), shared by the sprite graders. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzip } from '../../../tools/scripts/capture_render'
import { CAPTURE_DIR } from './corpus'
import type { RecordedPiece } from './spriteGrade'

export interface Rec {
  id: string
  slot: number
  listX: number
  listY: number
  cameraX: number
  cameraY: number
  /** Null or absent when the capture caught no INIT for the sprite (initFacing is then null too). */
  marioAtInit?: { x: number; y: number } | null
  /** $157C right after INIT on hardware (SpriteMisc157C; 1 = facing left, SubHorizPos's Y). */
  initFacing?: number | null
  initFrame?: number
  drawnFrame?: number
  trueFrame?: number
  effFrame?: number
  frames?: { frameIndex?: number; tiles?: RecordedPiece[] }[]
  firstFrameIndex?: number
  complete?: boolean
}

export interface Loaded {
  map: string
  rec: Rec
  wram: Uint8Array | null
  /** capture_summary.json anchorFrame: when the sprites' MAIN starts running on hardware. */
  anchorFrame?: number
  /** scroll_pass.json marioStart: where Mario is held from the anchor on. */
  marioStart?: { x: number; y: number }
}

export function loadCaptures(dir: string = CAPTURE_DIR): Loaded[] {
  const out: Loaded[] = []
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f)
    if (!f.endsWith('.zip')) continue
    const name = f.slice(0, -4)
    const entries = unzip(readFileSync(p))
    const key = [...entries.keys()].find(k => k.endsWith('sprite_spawns.json'))
    if (!key) continue
    const j = JSON.parse(entries.get(key)!().toString('utf8'))
    const wk = [...entries.keys()].find(k => k.endsWith('frame_0000_wram.bin'))
    const wram = wk ? new Uint8Array(entries.get(wk)!()) : null
    const jsonOf = (suffix: string): Record<string, unknown> => {
      const k = [...entries.keys()].find(e => e.endsWith(suffix))
      return k ? JSON.parse(entries.get(k)!().toString('utf8')) : {}
    }
    const anchorFrame = jsonOf('capture_summary.json').anchorFrame as number | undefined
    const marioStart = jsonOf('scroll_pass.json').marioStart as Loaded['marioStart']
    for (const rec of j.spawns ?? []) out.push({ map: name, rec, wram, anchorFrame, marioStart })
  }
  return out
}
