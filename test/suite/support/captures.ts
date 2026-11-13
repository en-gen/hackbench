/** Loads the `layers_v5` Mesen captures (sprite_spawns, capture_summary, scroll_pass), shared by the sprite graders. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzip } from '../../../tools/scripts/capture_render'
import { CAPTURE_DIR } from './corpus'
import type { PlacedSprite } from './gradeTimeline'
import type { RecordedPiece } from './spriteGrade'

/** One sprite_spawns.json record: the placed sprite, its INIT/draw frames and the OAM tiles Mesen caught. */
export interface Rec {
  id: string
  slot: number
  listIndex?: number
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

/** A capture record with its map's frame-0 WRAM and the per-map capture fields. */
export interface Loaded {
  map: string
  rec: Rec
  wram: Uint8Array | null
  /** capture_summary.json anchorFrame: when PlayerAnimation reaches 0 after the entrance wait; the recorder starts here. */
  anchorFrame?: number
  /** capture_summary.json gateFrame: the first GM14 frame, where MAIN resumes after GM12/GM13 (#875). */
  gateFrame?: number
  /** scroll_pass.json marioStart: where Mario is held from the anchor on. */
  marioStart?: { x: number; y: number }
  /** sprites.json entries: the placed list ids by index. */
  listed?: PlacedSprite[]
}

/** Every sprite record in every `*.zip` under the corpus capture folder, in map order. */
export function loadCaptures(): Loaded[] {
  const out: Loaded[] = []
  for (const f of readdirSync(CAPTURE_DIR).sort()) {
    const p = join(CAPTURE_DIR, f)
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
    const gateFrame = jsonOf('capture_summary.json').gateFrame as number | undefined
    const marioStart = jsonOf('scroll_pass.json').marioStart as Loaded['marioStart']
    const listed = jsonOf('sprites.json').entries as Loaded['listed']
    for (const rec of j.spawns ?? [])
      out.push({ map: name, rec, wram, anchorFrame, gateFrame, marioStart, listed })
  }
  return out
}
