/**
 * Stationary Koopa shells (#837), on the synthetic cart (no ROM). The loader gives list ids
 * $DA-$DD and $DF status 9 and sprite number id-$DA+4 and runs InitSpriteTables but no INIT
 * (SMWDisX bank_02.asm:5339-5340, 5349-5350, 5361, 5456-5462, 5498). The mapping is read from the
 * loader's bytes: the whole $C9-$FF range is swept so a wrong edge (a $DE or $E0 taken as a shell, a
 * shell dropped) goes red, and each loader site is planted to prove a changed opcode refuses and a
 * changed operand changes the mapping.
 */
import { describe, expect, it } from 'vitest'
import { shellLoad } from '../../../../src/rom/sprites/ShellSprites'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { runnerId } from '../../support/gradeTimeline'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const rom = buildSyntheticRom()
const SHELLS = new Map([
  [0xda, 4],
  [0xdb, 5],
  [0xdc, 6],
  [0xdd, 7],
  [0xdf, 9],
])
/** The loader's sites with the byte planted over each opcode, as the synthetic cart lays them out. */
const OPCODES = [0x02a88c, 0x02a89c, 0x02a8ac, 0x02a8b0, 0x02a8c0, 0x02a8d0, 0x02a978, 0x02a97e]

describe('stationary shell list ids', () => {
  it('maps exactly $DA-$DD and $DF, across $C9-$FF', () => {
    for (let id = 0xc9; id <= 0xff; id++) {
      const r = shellLoad(rom, id)
      expect(r.refusal, `$${id.toString(16)}`).toBeUndefined()
      expect(r.shell?.number, `$${id.toString(16)}`).toBe(SHELLS.get(id))
    }
  })

  it('completes a run for exactly the shells across $C9-$FF; every other id is past the table', () => {
    for (let id = 0xc9; id <= 0xff; id++) {
      const refusal = runSprite(rom, id).refusal
      if (SHELLS.has(id)) expect(refusal, `$${id.toString(16)}`).toBeUndefined()
      else expect(refusal, `$${id.toString(16)}`).toMatch(/past the/)
    }
  })

  it('refuses, naming the site, when any loader opcode is not the expected one', () => {
    for (const at of OPCODES) {
      const r = buildSyntheticRom()
      r.writeAt(at, [0xea])
      expect(runSprite(r, 0xda).refusal, `$${at.toString(16)}`).toMatch(
        /in the level loader is not the expected code/,
      )
    }
  })

  it('reads the operands: ADC #5 maps $DA to 5, SBC #$DB maps $DB to 4, CMP #$E2 makes $E1 a shell', () => {
    const adc = buildSyntheticRom()
    adc.writeAt(0x02a983, [0x05])
    expect(shellLoad(adc, 0xda).shell?.number).toBe(5)
    const sbc = buildSyntheticRom()
    sbc.writeAt(0x02a980, [0xdb])
    expect(shellLoad(sbc, 0xdb).shell?.number).toBe(4)
    const ceil = buildSyntheticRom()
    ceil.writeAt(0x02a8c1, [0xe2])
    expect(shellLoad(ceil, 0xe1).shell?.number).toBe(0xe1 - 0xda + 4)
    expect(shellLoad(rom, 0xe1).shell).toBeUndefined()
  })

  it('leaves plain ids alone even when the loader bytes are wrong', () => {
    const r = buildSyntheticRom()
    r.writeAt(0x02a8d0, [0xea])
    expect(runSprite(r, 0).refusal).toBeUndefined()
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

  it('runs no sprite-loop frame before MAIN: the steps after InitSpriteTables are zero', () => {
    // steps[0] counts what ran between InitSpriteTables and the first MAIN pass: an INIT frame for a plain id.
    expect(runSprite(rom, 0xda, withSeed({ slot: 3 })).steps[0]).toBe(0)
    expect(runSprite(rom, 0, withSeed({ slot: 3 })).steps[0]).toBeGreaterThan(0)
  })

  it('still runs a plain id through INIT in status 1', () => {
    expect(runSprite(rom, 0).initFrames).toBe(1)
  })
})

describe('runnerId (the grader hands the runner the placed list id)', () => {
  const entries = [
    { index: 2, id: '$DA' },
    { index: 3, id: '$04' },
  ]
  it('a shell record gets its list id; anything else keeps its own', () => {
    expect(runnerId(rom, 4, 2, entries)).toBe(0xda)
    expect(runnerId(rom, 4, 3, entries)).toBe(4)
    expect(runnerId(rom, 7, 2, entries)).toBe(7)
    expect(runnerId(rom, 4, 9, entries)).toBe(4)
    expect(runnerId(rom, 4, undefined, entries)).toBe(4)
    expect(runnerId(rom, 4, 2, undefined)).toBe(4)
  })
})
