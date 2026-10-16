/**
 * Stationary Koopa shells (#837), on the synthetic cart (no ROM). The loader gives list ids
 * $DA-$DD and $DF status 9 and sprite number id-$DA+4 and runs InitSpriteTables but no INIT
 * (SMWDisX bank_02.asm:5339-5340, 5349-5350, 5361, 5456-5462, 5498). The whole $D8-$E1 range is
 * swept so a wrong edge (a $DE or $E0 taken as a shell, a shell dropped) goes red.
 */
import { describe, expect, it } from 'vitest'
import { shellSpriteNumber } from '../../../../src/rom/sprites/ShellSprites'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const rom = buildSyntheticRom()
const SHELLS = new Map([
  [0xda, 4],
  [0xdb, 5],
  [0xdc, 6],
  [0xdd, 7],
  [0xdf, 9],
])

describe('stationary shell list ids', () => {
  it('maps exactly $DA-$DD and $DF, across $D8-$E1', () => {
    for (let id = 0xd8; id <= 0xe1; id++) expect(shellSpriteNumber(id), `$${id.toString(16)}`).toBe(SHELLS.get(id)) // prettier-ignore
  })

  it('loads each shell in status 9 as sprite id-$DA+4, with InitSpriteTables but no INIT', () => {
    for (const [id, num] of SHELLS) {
      let wram: Uint8Array | undefined
      const m = runSprite(rom, id, withSeed({ slot: 3 }), {
        probe: (p, w) => {
          if (p === -1) wram = w.slice()
        },
      })
      const at = `$${id.toString(16)}`
      expect(m.refusal, at).toBeUndefined()
      expect(wram![0x14c8 + 3], `${at} status`).toBe(9)
      expect(wram![0x9e + 3], `${at} number`).toBe(num)
      expect(wram![0x1603], `${at} InitSpriteTables ran`).toBe(0x55)
      expect(m.initFrames, `${at} INIT frames`).toBe(0)
    }
  })

  it('does not treat $DE, $E0 or their neighbours as shells', () => {
    for (const id of [0xd8, 0xd9, 0xde, 0xe0, 0xe1]) {
      // The synthetic table ends at $C8 like the cart's: these ids are past it, not a shell number.
      expect(runSprite(rom, id).refusal, `$${id.toString(16)}`).toMatch(/past the/)
    }
  })

  it('still runs a plain id through INIT in status 1', () => {
    expect(runSprite(rom, 0).initFrames).toBe(1)
  })
})
