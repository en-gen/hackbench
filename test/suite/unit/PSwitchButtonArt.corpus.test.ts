/**
 * PSwitchButtonArt.ts against the real ROMs: every value on vanilla, cross-checked
 * with bank_01.asm, and the refusal on a hack that replaces CallSpriteInit.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { readPSwitchButtonArt } from '../../../src/rom/PSwitchButtonArt'
import { CORPUS, VANILLA, hasRom, romPath } from '../support/corpus'

const GPW2 = CORPUS[2]!

describe.skipIf(!hasRom(VANILLA))('readPSwitchButtonArt (vanilla corpus)', () => {
  it('reads the tiles, displacement, masks and PSwitchPal the disassembly names', () => {
    const result = readPSwitchButtonArt(RomFile.load(romPath(VANILLA)))
    if (!result.ok) throw new Error(result.reason)
    expect(result.art).toEqual({
      unpressedTile: 0x42,
      pressedTile: 0xfe,
      xOffset: 8,
      yOffset: 8,
      tile1Mask: 0xfe,
      spriteProperties: 0,
      blueAttr: 0x06,
      silverAttr: 0x02,
    })
  })
})

// GPW2 1.1 (like GPW 1.2 and Invictus) replaces CallSpriteInit's LDA #$08 with a JSL, so
// PSwitchPal cannot be proven reachable: refuse rather than report the vanilla palette.
describe.skipIf(!hasRom(GPW2))('readPSwitchButtonArt (GPW2, edited CallSpriteInit)', () => {
  it('refuses rather than reporting the vanilla-shaped palette', () => {
    const result = readPSwitchButtonArt(RomFile.load(romPath(GPW2)))
    expect(!result.ok && result.reason).toContain('CallSpriteInit')
  })
})
