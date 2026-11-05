/**
 * World-locked Layer 3 against the layers_v5 Mesen captures (#563): maps $011, $130 and $1C1 (settings
 * byte $81 on tileset 9). Gated on the vanilla ROM and the capture set; a machine without either skips
 * all of it. At frame 0 (about 30 frames after the level loaded, EffFrame 31..) the captured WRAM and
 * VRAM must agree with what the model draws from:
 *   - Layer3YPos ($24) is the model's yPx ($C0) and equals Layer1YPos,
 *   - Layer1XPos ($1A) is exactly the entrance camera X (start - $8C: 0, 0 and 652),
 *     and Layer3XPos ($22) is only the drift so far (0..2 px),
 *   - the captured BG3 tilemap equals the model's below the status bar rows, so the tile at map X
 *     camXPx + 8c in row R is the one the model draws.
 * The comparison is by registers and tilemap, not pixels: the drift moves the picture 1 px by frame 0.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzip } from '../../../tools/scripts/capture_render'
import { CAPTURE_DIR, hasCaptures, hasRom, romPath, VANILLA } from '../support/corpus'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import { buildL3Verdict } from '../../../src/rom/model/L3Model'
import { L3_HUD_ROW_CUTOFF } from '../../../src/rom/L3Loader'

/** ClearOutLayer3 fills the tilemap with this blank tile (seen in every cell the stripe image leaves alone); the model leaves those 0. */
const BLANK = 0x38fc
const MAPS = ['011', '130', '1c1']

describe.skipIf(!hasRom(VANILLA) || !hasCaptures())(
  'world-locked layer 3 vs the captures (corpus)',
  () => {
    it.each(MAPS)('$%s: Y, camera X and the tilemap match frame 0', id => {
      const rom = RomFile.load(romPath(VANILLA))
      const index = parseInt(id, 16)
      const header = parseLevelHeader(new SmwRom(rom).getLevelRawData(index)!)
      const v = buildL3Verdict(
        rom,
        index,
        { header, isVertical: false, colors: [] },
        { ok: true, mode: 1 },
      )
      expect(v.reason).toBeNull()
      const entries = unzip(readFileSync(join(CAPTURE_DIR, `${id}.zip`)))
      const file = (name: string) => entries.get(`${id}/${name}`)!()
      const w = file('frame_0000_wram.bin')
      const u16 = (a: number) => w[a]! | (w[a + 1]! << 8)
      expect(u16(0x24)).toBe(v.l3!.yPx)
      expect(u16(0x24)).toBe(u16(0x1c))
      expect(u16(0x1a)).toBe(v.l3!.worldLocked!.camXPx)
      expect(u16(0x22)).toBeLessThanOrEqual(2)
      // BG3's 64 x 64 tilemap at VRAM word $5000, four 32 x 32 screens (BG3SC byte $53, ppu.json); the dump starts at word $4000.
      const vram = file('frame_0000_l3_vram.bin')
      const at = (r: number, c: number) => {
        const word = 0x1000 + (r >> 5) * 0x800 + (c >> 5) * 0x400 + (r & 31) * 32 + (c & 31)
        const t = vram[word * 2]! | (vram[word * 2 + 1]! << 8)
        return t === BLANK ? 0 : t
      }
      let compared = 0
      for (let r = L3_HUD_ROW_CUTOFF; r < 64; r++)
        for (let c = 0; c < 64; c++) {
          expect([r, c, v.l3!.tilemap[r * 64 + c]]).toEqual([r, c, at(r, c)])
          compared++
        }
      expect(compared).toBe((64 - L3_HUD_ROW_CUTOFF) * 64)
    })
  },
)
