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
import { hasCaptures, hasRom, VANILLA } from '../support/corpus'
import { l3CaptureCase } from '../support/l3Capture'

const MAPS = ['011', '130', '1c1']

describe.skipIf(!hasRom(VANILLA) || !hasCaptures())(
  'world-locked layer 3 vs the captures (corpus)',
  () => {
    it.each(MAPS)('$%s: Y, camera X and the tilemap match frame 0', id => {
      const { v, u16, expectTilemapMatchesFrame0 } = l3CaptureCase(id)
      expect(u16(0x24)).toBe(v.l3!.yPx)
      expect(u16(0x24)).toBe(u16(0x1c))
      expect(u16(0x1a)).toBe(v.l3!.worldLocked!.camXPx)
      expect(u16(0x22)).toBeLessThanOrEqual(2)
      expectTilemapMatchesFrame0()
    })
  },
)
