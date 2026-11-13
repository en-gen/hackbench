/** Setup for the Layer 3 corpus test that binds the model to a layers_v5 capture. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { unzip } from '../../../tools/scripts/capture_render'
import { CAPTURE_DIR, freshRom, VANILLA } from './corpus'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import { buildL3Verdict } from '../../../src/rom/model/L3Model'

/** The first tilemap row compared: rows 0-7 are the status bar. A literal, so a wrong `L3_HUD_ROW_CUTOFF` in the code cannot move the oracle with it. */
const FIRST_ROW = 8

/** ClearOutLayer3 fills the tilemap with this blank tile (every cell the stripe image leaves alone); the model leaves those 0. */
const BLANK = 0x38fc

/** The model's Layer 3 verdict for map `id` (hex) on the vanilla ROM, plus readers for that map's capture. */
export function l3CaptureCase(id: string) {
  const rom = freshRom(VANILLA)
  const index = parseInt(id, 16)
  const header = parseLevelHeader(new SmwRom(rom).getLevelRawData(index)!)
  const v = buildL3Verdict(rom, index, { header, isVertical: false, colors: [] }, { ok: true, mode: 1 }) // prettier-ignore
  expect(v.reason).toBeNull()
  const entries = unzip(readFileSync(join(CAPTURE_DIR, `${id}.zip`)))
  const file = (name: string) => entries.get(`${id}/${name}`)!()
  const wram = file('frame_0000_wram.bin')
  const u16 = (a: number) => wram[a]! | (wram[a + 1]! << 8)

  /** The captured BG3 tilemap equals the model's below the status bar rows. */
  const expectTilemapMatchesFrame0 = () => {
    // BG3's 64 x 64 tilemap at VRAM word $5000, four 32 x 32 screens (BG3SC byte $53, ppu.json); the dump starts at word $4000.
    const vram = file('frame_0000_l3_vram.bin')
    const at = (r: number, c: number) => {
      const word = 0x1000 + (r >> 5) * 0x800 + (c >> 5) * 0x400 + (r & 31) * 32 + (c & 31)
      const t = vram[word * 2]! | (vram[word * 2 + 1]! << 8)
      return t === BLANK ? 0 : t
    }
    let compared = 0
    let nonBlank = 0
    for (let r = FIRST_ROW; r < 64; r++)
      for (let c = 0; c < 64; c++) {
        expect([r, c, v.l3!.tilemap[r * 64 + c]]).toEqual([r, c, at(r, c)])
        compared++
        if (at(r, c) !== 0) nonBlank++
      }
    expect(compared).toBe((64 - FIRST_ROW) * 64)
    // The captured side must hold drawn cells, or an all-blank comparison would pass on a map drawing nothing.
    expect(nonBlank).toBeGreaterThan(0)
  }
  return { v, rom, index, file, u16, expectTilemapMatchesFrame0 }
}
