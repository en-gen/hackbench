/** Planted defects: the spike's verdicts must go red when the code under them is wrong. */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { VANILLA, freshRom, hasRom } from '../../support/corpus'
import { runSprite, toParts, partKey } from '../../../../src/rom/spriteInterp/spriteRun'

const GOOMBA = 0x0f
const patched = (edit: (b: Uint8Array) => void): RomFile => {
  const bytes = new Uint8Array(freshRom().buffer)
  edit(bytes)
  return RomFile.fromBytes('planted.sfc', bytes)
}

describe.skipIf(!hasRom(VANILLA))('spriteRun planted defects (vanilla)', () => {
  const keyOf = (rom: RomFile) => toParts(runSprite(rom, GOOMBA)).map(partKey).join('|')
  // Read inside each test: describe.skipIf does not guard the describe body.
  const base = () => keyOf(freshRom())

  it('draws four chars for the Goomba', () => {
    expect(base().split('|')).toHaveLength(4)
  })

  it('goes red when SubHorizPos always says "Mario left" (BPL at $01:AD3E NOPed)', () => {
    const rom = patched(b => {
      b[0xad3e] = 0xea
      b[0xad3f] = 0xea
    })
    expect(keyOf(rom)).not.toBe(base())
  })

  it('goes red when the instruction that stores the tile is NOPed out', () => {
    const writer = runSprite(freshRom(), GOOMBA).oam[0].writer
    const o = ((writer >>> 16) & 0x7f) * 0x8000 + (writer & 0x7fff)
    const rom = patched(b => b.fill(0xea, o, o + 3)) // STA abs,Y is 3 bytes
    expect(runSprite(rom, GOOMBA).oam).toHaveLength(0)
  })
})
