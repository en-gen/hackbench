/**
 * The smash-driven Layer 3 against the layers_v5 Mesen captures of $01F and $1D4 (#1065). Gated on the
 * vanilla ROM and the capture set. Evidence scope: vanilla, one machine, the two captures read once. Both
 * maps land at X -104, Y $A0 with the same tilemap (the same RNG path), so they are one data point, not two.
 *   - The capture's frame 0 already holds the smasher (sprite $89, one slot) after state 0 ran: C2 = 1,
 *     $1540 = $80, X = the landing X, Y = the landing Y. That same frame's Layer3XPos/YPos ($22/$24) came from
 *     CODE_00FF61 on the PLACED sprite, before state 0 (bank_02.asm:11124 before 11138-11166).
 *   - X: the map view draws the smasher's first LANDING (#997), so xPx is the slot's signed 16-bit X, with
 *     frame 8's BG3HOFS (10 bits, signed; the first captured frame that shows the landing) as the register witness. Frame 0's $22 is the placed X pinned by
 *     CODE_00FF61 ($100 on $01F, placed $120; $70 on $1D4), which the map view does not draw by design.
 *   - Y: bound to frame 0's $24, but only once the slot's landing Y equals the placed Y read from the map's
 *     sprite list (both 0 on these maps), so that write provably equals the landing write. Y moves as the
 *     smasher falls (BG3VOFS 159, 157, 155 at frames 8, 16, 24), so no later frame is used.
 *   - The BG3 tilemap equals frame 0's below the status-bar rows (a smash map's tilemap does not move).
 */
import { describe, it, expect } from 'vitest'
import { readMapSprites } from '../../../src/rom/L3Smash'
import { hasCaptures, hasRom, VANILLA } from '../support/corpus'
import { l3CaptureCase } from '../support/l3Capture'

const MAPS = ['01f', '1d4']
const SMASH_SPRITE_ID = 0x89

describe.skipIf(!hasRom(VANILLA) || !hasCaptures())(
  'smash-driven layer 3 vs the captures (corpus, #1065)',
  () => {
    it.each(MAPS)('map %s: X is the landing, Y is frame 0 Layer3YPos, tilemap is frame 0', id => {
      const { v, rom, index, file, u16, expectTilemapMatchesFrame0 } = l3CaptureCase(id)
      const wram = file('frame_0000_wram.bin')
      // Sprite tables: type $9E, state $C2, timer $1540, X $E4/$14E0, Y $D8/$14D4 (12 slots).
      const slots = [...Array(12).keys()].filter(s => wram[0x9e + s] === SMASH_SPRITE_ID)
      expect(slots).toHaveLength(1)
      const s = slots[0]!
      expect([wram[0xc2 + s], wram[0x1540 + s]]).toEqual([1, 0x80]) // state 0 has run
      const slotX = ((wram[0xe4 + s]! | (wram[0x14e0 + s]! << 8)) << 16) >> 16
      const slotY = wram[0xd8 + s]! | (wram[0x14d4 + s]! << 8)
      expect(v.l3!.xPx).toBe(slotX)
      const hofs = JSON.parse(file('frame_0008_ppu.json').toString('utf8')).BG3HOFS_2111 as number
      expect(v.l3!.xPx).toBe((hofs << 22) >> 22)
      // A horizontal map's placed Y is the list's y in 16 px rows; the landing Y must equal it.
      const placed = readMapSprites(rom, index)!.filter(p => p.spriteId === SMASH_SPRITE_ID)
      expect(placed).toHaveLength(1)
      expect(slotY).toBe(placed[0]!.y * 16)
      expect(v.l3!.yPx).toBe(u16(0x24))
      expectTilemapMatchesFrame0()
    })
  },
)
