/**
 * The smash-driven Layer 3 against the layers_v5 Mesen captures of $01F and $1D4 (#1065). Gated on the
 * vanilla ROM and the capture set. Evidence scope: vanilla, one machine, the two captures read once.
 *   - Y: the map view's yPx is the capture's Layer3YPos ($24, frame 0 WRAM). Y is bound at frame 0 because the
 *     smasher moves it as it falls (BG3VOFS 159, 157, 155 at frames 8, 16, 24).
 *   - X: the map view draws the smasher's first LANDING (#997), not the placed sprite X. Frame 0's $22 is the
 *     placed sprite X before state 0 runs ($100 on $01F, $70 on $1D4), which the map view does not draw by
 *     design, so X is bound to frame 8's BG3HOFS (10 bits, signed), the first frame the landing shows.
 *   - The BG3 tilemap equals frame 0's below the status-bar rows (a smash map's tilemap does not move).
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

/** ClearOutLayer3's blank tile; the model leaves those cells 0. */
const BLANK = 0x38fc
const MAPS = ['01f', '1d4']

describe.skipIf(!hasRom(VANILLA) || !hasCaptures())(
  'smash-driven layer 3 vs the captures (corpus, #1065)',
  () => {
    it.each(MAPS)(
      'map %s: Y is frame 0 Layer3YPos, X is the frame 8 landing, tilemap is frame 0',
      id => {
        const rom = RomFile.load(romPath(VANILLA))
        const index = parseInt(id, 16)
        const header = parseLevelHeader(new SmwRom(rom).getLevelRawData(index)!)
        const v = buildL3Verdict(rom, index, { header, isVertical: false, colors: [] }, { ok: true, mode: 1 }) // prettier-ignore
        expect(v.reason).toBeNull()
        const entries = unzip(readFileSync(join(CAPTURE_DIR, `${id}.zip`)))
        const file = (name: string) => entries.get(`${id}/${name}`)!()
        const w = file('frame_0000_wram.bin')
        const y = w[0x24]! | (w[0x25]! << 8)
        expect(v.l3!.yPx).toBe(y)
        const hofs = JSON.parse(file('frame_0008_ppu.json').toString('utf8')).BG3HOFS_2111 as number
        expect(v.l3!.xPx).toBe((hofs << 22) >> 22)
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
      },
    )
  },
)
