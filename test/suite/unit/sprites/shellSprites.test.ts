/**
 * Stationary Koopa shells (#837), on the synthetic cart (no ROM). The loader gives list ids
 * $DA-$DD and $DF status 9 and sprite number id-$DA+4 and runs InitSpriteTables but no INIT
 * (SMWDisX bank_02.asm:5290-5291, 5339-5340, 5349-5350, 5361, 5456-5462, 5498). The mapping is read
 * from the loader's bytes: the whole $C9-$FF range is swept so a wrong edge (a $DE or $E0 taken as a
 * shell, a shell dropped) goes red; every byte of every site that is not an operand is planted with a
 * NOP and must refuse, and each operand is planted to change the mapping.
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
/** Every non-operand byte of every loader site (opcodes and branch displacements), as the synthetic cart lays them out. */
const FIXED = [
  ...[0x02a866, 0x02a88c, 0x02a89c, 0x02a8ac, 0x02a8b0, 0x02a8c0, 0x02a8d0].flatMap(a => [
    a,
    a + 2,
    a + 3,
  ]),
  ...[0x02a978, 0x02a97a, 0x02a97c, 0x02a97d, 0x02a97e, 0x02a97f, 0x02a981, 0x02a982],
]

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

  it.each(FIXED)('refuses, naming the site, when the byte at %i is not the expected one', at => {
    for (const id of [0xda, 0xff]) {
      const r = buildSyntheticRom()
      r.writeAt(at, [0xea])
      expect(shellLoad(r, id).refusal, `$${at.toString(16)} id $${id.toString(16)}`).toMatch(
        /in the level loader is not the expected code/,
      )
    }
  })

  it('with one loader site planted, refuses exactly for ids from $C9 up and runs the rest plain', () => {
    const r = buildSyntheticRom()
    r.writeAt(0x02a866, [0xea])
    for (let id = 0; id <= 0xff; id++) {
      const got = shellLoad(r, id)
      if (id >= 0xc9) expect(got.refusal, `$${id.toString(16)}`).toMatch(/not the expected code/)
      else expect(got, `$${id.toString(16)}`).toEqual({})
    }
  })

  // [name, site, byte planted, id, expected shell number (undefined: not a shell), expected status]
  const OPERANDS: [string, number, number, number, number | undefined, number?][] = [
    ['ADC #5', 0x02a983, 0x05, 0xda, 5],
    ['SBC #$DB', 0x02a980, 0xdb, 0xdb, 4],
    ['shell ceiling $E2', 0x02a8c1, 0xe2, 0xe1, 0xe1 - 0xda + 4],
    ['status 8 keeps the id', 0x02a8d1, 0x08, 0xda, 0xda, 8],
    ['floor $C0 alone does not free $C5 (ceiling still $DA)', 0x02a8ad, 0xc0, 0xc5, undefined],
    [
      'floor $E0 (ceiling still $DA) leaves $DA plain: the game goes to CODE_02A8D4',
      0x02a8ad,
      0xe0,
      0xda,
      undefined,
    ],
    ['eeries compare $E1 frees $DE', 0x02a88d, 0xe1, 0xde, 0xde - 0xda + 4],
    ['platforms compare $E1 frees $E0', 0x02a89d, 0xe1, 0xe0, 0xe0 - 0xda + 4],
    ['entry $DD drops $DD', 0x02a867, 0xdd, 0xdd, undefined],
  ]
  it.each(OPERANDS)('reads the operand: %s', (_n, at, byte, id, num, status) => {
    const r = buildSyntheticRom()
    r.writeAt(at, [byte])
    const got = shellLoad(r, id)
    expect(got.refusal).toBeUndefined()
    if (num !== undefined) expect(got.shell).toEqual({ number: num, status: status ?? 9 })
    else expect(got.shell, 'not a shell').toBeUndefined()
  })

  it('derives the range from both generator operands: floor and ceiling $C0 make $C5 a shell', () => {
    const r = buildSyntheticRom()
    r.writeAt(0x02a8ad, [0xc0])
    r.writeAt(0x02a8b1, [0xc0])
    expect(shellLoad(r, 0xc5).shell).toEqual({ number: (0xc5 - 0xda + 4) & 0xff, status: 9 })
    expect(shellLoad(rom, 0xc5).shell).toBeUndefined()
  })

  it('the entry compare bounds the mapping: ceiling $F0 does not make $E8 a shell (a scroll sprite)', () => {
    const r = buildSyntheticRom()
    r.writeAt(0x02a8c1, [0xf0])
    expect(shellLoad(r, 0xe8).shell).toBeUndefined()
    expect(shellLoad(r, 0xe6).shell?.number).toBe(0xe6 - 0xda + 4)
  })

  it('a non-integer or out-of-range id is no shell', () => {
    for (const id of [NaN, -1, 0x100, 1.5]) expect(shellLoad(rom, id)).toEqual({})
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

  it('runs INIT from the loaded status: id 0 made a status-1 "shell" by the operands still runs INIT', () => {
    const r = buildSyntheticRom()
    for (const [at, b] of [
      [0x02a8ad, 0],
      [0x02a8b1, 0],
      [0x02a8c1, 1],
      [0x02a8d1, 1],
    ] as const)
      r.writeAt(at, [b])
    expect(shellLoad(r, 0).shell).toEqual({ number: 0, status: 1 })
    expect(runSprite(r, 0).initFrames).toBe(1)
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
    expect(runnerId(rom, 4, 5, entries)).toBe(4)
    expect(runnerId(rom, 4, 2, [{ index: 2, id: 'zz' }])).toBe(4)
    expect(runnerId(rom, 4, 2, undefined)).toBe(4)
  })
})
