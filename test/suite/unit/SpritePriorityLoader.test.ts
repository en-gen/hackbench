/**
 * SpritePriorityLoader -- OBJ priority read off the cart.
 *
 * Test tree:
 *   level default      : LevXYPPCCCTtbl sweep over all 32 modes
 *   handler lowering   : $1A/$2A ClassicPiranhas; whole-id-range sweep
 *   walker can fail    : synthetic carts where a byte search would be wrong
 *   honest degradation : synthetic SpriteBehindScene gate
 *
 * Derivation: docs/obj-priority.md.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  LEV_XYPPCCCT_TBL_ADDR,
  SPRITE_MAIN_PTR_ADDR,
  readLevelObjPriority,
  readSpriteObjPriority,
} from '../../../src/rom/SpritePriorityLoader'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

/**
 * A LoROM image with one sprite handler at $01:9000 and every pointer in
 * `CallSpriteMain`'s table aimed at it, so a test writes opcodes and asks
 * what the loader makes of them.
 */
function cartWithHandler(body: number[]): RomFile {
  const buf = Buffer.alloc(0x40000, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  const HANDLER = 0x019000
  for (let id = 0; id <= 0xc8; id++) {
    rom.writeAt(SPRITE_MAIN_PTR_ADDR + id * 2, [HANDLER & 0xff, (HANDLER >> 8) & 0xff])
  }
  rom.writeAt(HANDLER, body)
  return rom
}

describe('readLevelObjPriority (synthetic cart)', () => {
  it('reads bits 5:4 of LevXYPPCCCTtbl[levelMode], not a constant', () => {
    // rammap.asm:518-527 -- OBJ priority is bits 5:4 of an XYPPCCCT byte.
    const rom = cartWithHandler([0x60])
    rom.writeAt(LEV_XYPPCCCT_TBL_ADDR, [0x00, 0x10, 0x20, 0x30])
    expect([0, 1, 2, 3].map(m => readLevelObjPriority(rom, m))).toEqual([0, 1, 2, 3])
  })

  it('masks the mode to 5 bits, matching AND #$1F at bank_05.asm:539', () => {
    const rom = cartWithHandler([0x60])
    rom.writeAt(LEV_XYPPCCCT_TBL_ADDR + 3, [0x30])
    expect(readLevelObjPriority(rom, 0x23)).toBe(3)
  })
})

describe('readSpriteObjPriority walker (synthetic cart)', () => {
  it('reads the immediate a handler stores to $64', () => {
    // LDA #$10 : STA $64 : RTS
    const rom = cartWithHandler([0xa9, 0x10, 0x85, 0x64, 0x60])
    expect(readSpriteObjPriority(rom, 0x1a, 2)).toEqual({ value: 1, source: 'handler' })
  })

  it('reads whatever immediate is there, so a hacked constant reads back', () => {
    const rom = cartWithHandler([0xa9, 0x30, 0x85, 0x64, 0x60])
    expect(readSpriteObjPriority(rom, 0x1a, 2)).toEqual({ value: 3, source: 'handler' })
  })

  it('stops at RTS: bytes past the routine are not opcodes', () => {
    // The pattern is present 1 byte after the RTS. A raw byte search finds
    // it and is wrong; the walk must not.
    const rom = cartWithHandler([0x60, 0xa9, 0x10, 0x85, 0x64, 0x60])
    expect(readSpriteObjPriority(rom, 0x1a, 2)).toEqual({ value: 2, source: 'level' })
  })

  it('stops at BRA as well as RTS', () => {
    const rom = cartWithHandler([0x80, 0x02, 0xea, 0xea, 0xa9, 0x10, 0x85, 0x64, 0x60])
    expect(readSpriteObjPriority(rom, 0x1a, 2)).toEqual({ value: 2, source: 'level' })
  })

  it('keeps instruction boundaries: A9 85 64 inside an operand is not a match', () => {
    // LDA.W $64A9,X is BD A9 64 -- adjacent bytes spell nothing, but a
    // 3-byte operand straddling the pattern would fool a byte search.
    // LDA #$A9 (A9 A9) : LDA.W $6485 (AD 85 64) : RTS
    const rom = cartWithHandler([0xa9, 0xa9, 0xad, 0x85, 0x64, 0x60])
    expect(readSpriteObjPriority(rom, 0x1a, 2)).toEqual({ value: 2, source: 'level' })
  })

  it('widens the LDA immediate after REP #$20', () => {
    // REP #$20 : LDA #$0000 (3 bytes) : SEP #$20 : LDA #$10 : STA $64 : RTS
    // If the walker treated A9 as 2 bytes here it would desynchronise and
    // miss the real store.
    const rom = cartWithHandler([
      0xc2, 0x20, 0xa9, 0x00, 0x00, 0xe2, 0x20, 0xa9, 0x10, 0x85, 0x64, 0x60,
    ])
    expect(readSpriteObjPriority(rom, 0x1a, 2)).toEqual({ value: 1, source: 'handler' })
  })

  it('follows a repointed handler rather than a frozen address', () => {
    const rom = cartWithHandler([0x60])
    rom.writeAt(0x019500, [0xa9, 0x10, 0x85, 0x64, 0x60])
    rom.writeAt(SPRITE_MAIN_PTR_ADDR + 0x1a * 2, [0x00, 0x95])
    expect(readSpriteObjPriority(rom, 0x1a, 2)).toEqual({ value: 1, source: 'handler' })
    // Untouched ids still resolve through the old pointer.
    expect(readSpriteObjPriority(rom, 0x1b, 2).source).toBe('level')
  })

  it('declines to assert when the lowering is gated on SpriteBehindScene', () => {
    // LDA.W $1632,X : BEQ +2 : LDA #$10 : STA $64 : RTS
    // $1632 is zeroed at spawn (bank_07.asm:935) and only set by runtime
    // events, so a still frame has no value for it. Never reached on the
    // vanilla cart -- see docs/obj-priority.md section 3.
    const rom = cartWithHandler([0xbd, 0x32, 0x16, 0xf0, 0x02, 0xa9, 0x10, 0x85, 0x64, 0x60])
    expect(readSpriteObjPriority(rom, 0x1a, 2)).toEqual({ value: 2, source: 'runtimeGated' })
  })

  it('does not call an unrelated absolute,X load a runtime gate', () => {
    // LDA.W $1633,X -- one byte off SpriteBehindScene.
    const rom = cartWithHandler([0xbd, 0x33, 0x16, 0xf0, 0x02, 0xa9, 0x10, 0x85, 0x64, 0x60])
    expect(readSpriteObjPriority(rom, 0x1a, 2)).toEqual({ value: 1, source: 'handler' })
  })
})

describe.skipIf(!existsSync(ROM_PATH))('SpritePriorityLoader (vanilla ROM)', () => {
  const rom = () => SmwRom.open(ROM_PATH).rom

  it('LevXYPPCCCTtbl gives OBJ.2 on five level modes and OBJ.3 on the other 27', () => {
    // bank_05.asm:506-509 reads, in order:
    //   $20,$20,$20,$30,$30,$30,$30,$30 / $30 x6,$20,$20 / $30 x8 / $30 x8
    // so modes 0,1,2,$0E,$0F are OBJ.2 and the rest OBJ.3. The point of the
    // sweep is that "sprites default to OBJ.2" is false on 27 of 32 modes.
    const r = rom()
    const byMode = Array.from({ length: 32 }, (_, m) => readLevelObjPriority(r, m))
    expect(byMode.filter(p => p === 2)).toHaveLength(5)
    expect(byMode.filter(p => p === 3)).toHaveLength(27)
    expect([0, 1, 2, 0x0e, 0x0f].map(m => byMode[m])).toEqual([2, 2, 2, 2, 2])
    expect([3, 7, 0x0d, 0x10, 0x1f].map(m => byMode[m])).toEqual([3, 3, 3, 3, 3])
  })

  it('ClassicPiranhas ($1A, $2A) lowers to OBJ.1 via its handler immediate', () => {
    // bank_01.asm:2113-2114 -- LDA #!OBJ_Priority1 : STA SpriteProperties,
    // six instructions into the handler the $01:85CC table names.
    const r = rom()
    expect(readSpriteObjPriority(r, 0x1a, 2)).toEqual({ value: 1, source: 'handler' })
    expect(readSpriteObjPriority(r, 0x2a, 2)).toEqual({ value: 1, source: 'handler' })
  })

  it('a sprite with no entry-block store keeps the level default, whatever it is', () => {
    // $04 and $0F both dispatch to Spr0to13Start, which writes no immediate
    // to $64 before its first draw call.
    const r = rom()
    for (const id of [0x04, 0x0f]) {
      expect(readSpriteObjPriority(r, id, 2)).toEqual({ value: 2, source: 'level' })
      expect(readSpriteObjPriority(r, id, 3)).toEqual({ value: 3, source: 'level' })
    }
  })

  it('sweeps every sprite id: 7 lower to OBJ.1, none gate on runtime state', () => {
    // Measured over ids $00..$C8 on "Super Mario World (USA)". The four
    // bank_01 SpriteBehindScene sites all sit past an unconditional
    // transfer from their handler entry, so the walk never reaches them --
    // which is why the runtimeGated path is covered synthetically above.
    const r = rom()
    const ids = [...Array(0xc9).keys()]
    const resolved = ids.map(id => readSpriteObjPriority(r, id, 2))
    for (const p of resolved) expect(p.value).toBeGreaterThanOrEqual(0)
    for (const p of resolved) expect(p.value).toBeLessThanOrEqual(3)
    const lowered = ids.filter(id => resolved[id]!.source === 'handler')
    expect(lowered).toEqual([0x1a, 0x2a, 0x79, 0x7d, 0x7e, 0x7f, 0x80])
    for (const id of lowered) expect(resolved[id]!.value).toBe(1)
    expect(resolved.filter(p => p.source === 'runtimeGated')).toHaveLength(0)
  })
})
