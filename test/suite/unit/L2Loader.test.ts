/**
 * Unit tests for L2Loader's per-level initial-Y helper. Mirrors the shape of
 * L3Loader.test.ts § "primary-entrance camera Y reads from DATA_05F400 bits 3:2"
 * - the L2 path uses bits 1:0 of the same byte and a different lookup table.
 *
 * ROM-dependent; gated on test/roms/Super Mario World (USA).vanilla.sfc.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { readInitialLayer2YPos } from '../../../src/rom/L2Loader'
import { findSecondaryEntranceForLevel } from '../../../src/rom/L3Loader'
import { SmwRom } from '../../../src/rom/SmwRom'

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

describe.skipIf(!romPresent)('L2Loader.readInitialLayer2YPos (ROM-only)', () => {
  it('primary-entrance Layer2YPos reads DATA_05F400 bits 1:0 -> DATA_05D70C', () => {
    // bank_05.asm:7323-7328:
    //   LDA.W DATA_05F400,Y
    //   STA.B _2
    //   AND.B #$03           ; bits 1:0 (L2's selector - distinct from L1's >>2 & 3)
    //   TAX
    //   LDA.L DATA_05D70C,X  ; table = $60,$90,$C0,$00 (bank_05.asm:7035-7036)
    //   STA.B Layer2YPos
    //
    // $009 (Underground1 auto-scroller, object-stream L2):
    //   F400[$009] = $0A -> bits 1:0 = 2 -> D70C[2] = $C0
    //   matches live-game $7E:0020 verified via Mesen Memory Viewer (issue #245).
    const rom = SmwRom.open(ROM_PATH)
    expect(readInitialLayer2YPos(rom.rom, 0x009, false)).toBe(0xc0)
  })

  it('returns DATA_05D70C[3] = $00 when bits 1:0 select index 3', () => {
    // Diagnostic: $1CE has F400=$03 -> bits 1:0 = 3 -> D70C[3] = $00.
    // Confirms the helper indexes into the right table slot, not just $C0
    // for every input.
    const rom = SmwRom.open(ROM_PATH)
    expect(readInitialLayer2YPos(rom.rom, 0x1ce, false)).toBe(0x00)
  })

  it('sublevel with secondary entrance reads DATA_05FA00 bits 7:6 -> DATA_05D70C', () => {
    // bank_05.asm:7137-7146 (secondary-entrance path, post-LSR x6):
    //   AND.B #$03 -> top 2 bits of FA00[entrance]
    //   TAX
    //   LDA.L DATA_05D70C,X
    // For $102 (Yoshi's Island 4 sublevel, only reachable via entrance $1BE):
    //   FA00[$1BE] = $AB -> bits 7:6 = 2 -> D70C[2] = $C0.
    const rom = SmwRom.open(ROM_PATH)
    expect(findSecondaryEntranceForLevel(rom.rom, 0x102)).toBe(0x1be)
    expect(readInitialLayer2YPos(rom.rom, 0x102, false)).toBe(0xc0)
  })

  it('sublevel without targeting entrance falls back to primary-path bits', () => {
    // $111 is in the user's object-stream L2 cohort but no secondary entrance
    // targets it. The helper must fall through to the primary path (F400 & 3),
    // matching readInitialLayer1YPos's same fallback at L3Loader.ts:260-266.
    //   F400[$111] = $0A -> bits 1:0 = 2 -> D70C[2] = $C0.
    const rom = SmwRom.open(ROM_PATH)
    expect(findSecondaryEntranceForLevel(rom.rom, 0x111)).toBe(null)
    expect(readInitialLayer2YPos(rom.rom, 0x111, false)).toBe(0xc0)
  })

  it('loader is agnostic to preset-BG vs object-stream classification', () => {
    // The Layer2YPos init code (bank_05.asm:7323-7328) runs unconditionally
    // during level setup, before LoadLevel decides to take the preset-BG vs
    // object-stream branch (CODE_05801E, bank_05.asm:32-34). A preset-BG
    // level still has a valid DATA_05D70C entry; the render-side variant
    // (L2Preset) just doesn't apply it. The helper must not gate on
    // preset/object-stream itself - that decision lives in the render layer.
    //   $000 (preset BG, control): F400=$0A -> bits 1:0 = 2 -> $C0
    //   $105 (preset BG, control): F400=$9A -> bits 1:0 = 2 -> $C0
    const rom = SmwRom.open(ROM_PATH)
    expect(readInitialLayer2YPos(rom.rom, 0x000, false)).toBe(0xc0)
    expect(readInitialLayer2YPos(rom.rom, 0x105, false)).toBe(0xc0)
  })
})
