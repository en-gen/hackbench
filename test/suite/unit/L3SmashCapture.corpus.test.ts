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
import { hasCaptures, hasRom, VANILLA } from '../support/corpus'
import { l3CaptureCase } from '../support/l3Capture'

const MAPS = ['01f', '1d4']

describe.skipIf(!hasRom(VANILLA) || !hasCaptures())(
  'smash-driven layer 3 vs the captures (corpus, #1065)',
  () => {
    it.each(MAPS)(
      'map %s: Y is frame 0 Layer3YPos, X is the frame 8 landing, tilemap is frame 0',
      id => {
        const { v, file, u16, expectTilemapMatchesFrame0 } = l3CaptureCase(id)
        expect(v.l3!.yPx).toBe(u16(0x24))
        const hofs = JSON.parse(file('frame_0008_ppu.json').toString('utf8')).BG3HOFS_2111 as number
        expect(v.l3!.xPx).toBe((hofs << 22) >> 22)
        expectTilemapMatchesFrame0()
      },
    )
  },
)
