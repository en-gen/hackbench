/**
 * The GFX-routine reader, swept over the corpus and proved able to move.
 *
 * Two standards are applied here. The corpus block sweeps every id below
 * $54 on every cart and asserts the counts and the agreement with the table
 * the reader replaces; a single-sprite acceptance test would say nothing
 * about the other 83. The planted block changes one cart byte at a time and
 * shows the answer follows it, which is the only thing separating a reader
 * from a lookup table with a `RomFile` parameter.
 *
 * Nothing is written to disk: `RomFile.writeAt` mutates the loaded buffer.
 *
 * Evidence scope: all six cart files in `test/roms/` for the corpus claims,
 * `Super Mario World (USA).vanilla.sfc` for the planted ones. Static reads
 * only; no emulator was run.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../../src/rom/RomFile'
import {
  decidedPropGroup,
  decidedRoutine,
  gfxRoutineMessage,
  readGfxRoutine,
  readGfxRoutines,
  resolveHandlerSite,
  type GfxRoutine,
} from '../../../../src/rom/dispatch/GfxRoutineReader'
import { walkHandler } from '../../../../src/rom/dispatch/HandlerWalk'

const ROM_DIR = resolve(__dirname, '../../../roms')
const ROM_FILES = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
] as const
const romsPresent = ROM_FILES.every(f => existsSync(resolve(ROM_DIR, f)))

const freshRom = (name: (typeof ROM_FILES)[number] = ROM_FILES[0]) =>
  RomFile.load(resolve(ROM_DIR, name))
const allRoms = () => ROM_FILES.map(name => ({ name, rom: freshRom(name) }))

/** Sprites below this use `SprTilemapOffset`, so this is the range the
 *  classification actually feeds. */
const TILEMAP_IDS = 0x54

/** The same eight addresses the reader watches, spelled out again so a
 *  direct walk here sees what `readGfxRoutine` sees. `ENTRY_POINTS` at the
 *  bottom of this file is the row-by-row check that the list is right. */
const WATCHED_ENTRIES: ReadonlyMap<number, string> = new Map([
  [0x019cf3, 'sub0'],
  [0x019cf5, 'sub0'],
  [0x019d67, 'sub1'],
  [0x019f09, 'sub2'],
  [0x019f0d, 'sub2'],
  [0x018042, 'sub0'],
  [0x019d5f, 'sub1'],
  [0x0190b2, 'sub2'],
])

/**
 * The classification `SpriteTileLoader` carried before this reader existed,
 * reconstructed here so the swap can be checked rather than asserted.
 * `SPR_0_TO_13_START_IDS` and the $40 mask are the frozen rule the reader
 * now reads off the cart.
 */
const FROZEN_OVERRIDES: Readonly<Record<number, GfxRoutine>> = {
  0x1a: 'sub1',
  0x1e: 'sub1',
  0x1f: 'sub1',
  0x22: 'sub1',
  0x23: 'sub1',
  0x24: 'sub1',
  0x25: 'sub1',
  0x2a: 'sub1',
  0x41: 'sub1',
  0x42: 'sub1',
  0x43: 'sub1',
  0x14: 'sub0',
  0x27: 'sub0',
  0x2b: 'sub0',
  0x2f: 'sub0',
  0x4d: 'sub0',
  0x4e: 'sub0',
}
const SPR_0_TO_13_START_IDS = [
  0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0f, 0x11, 0x13,
]
const SPR_0_TO_13_PROP_ADDR = 0x0188f0

function frozenAnswer(rom: RomFile, id: number): GfxRoutine {
  if (FROZEN_OVERRIDES[id]) return FROZEN_OVERRIDES[id]
  if (!SPR_0_TO_13_START_IDS.includes(id)) return 'sub2'
  return ((rom.readByte(SPR_0_TO_13_PROP_ADDR + id) ?? 0) & 0x40) !== 0 ? 'sub1' : 'sub2'
}

/** Rex. Its MAIN pointer is the bank-3 stub, so reaching a verdict at all
 *  requires the dispatch chain underneath. */
const REX = 0xab
/** Green Koopa. The `Spr0to13Gfx` selector, bank_01.asm:1762-1765. */
const SELECTED = 0x04
/** Classic Piranha Plant. A plain one-routine handler reaching `sub1`. */
const SINGLE_SUB1 = 0x1a
/** Magikoopa. Its draw call sits behind `JSL ExecutePtr`. */
const UNREACHED = 0x1f

describe.skipIf(!romsPresent)('the classification as the six carts hold it', () => {
  it('resolves 57 of the 84 tilemap-range ids, 56 on Grand Poo World 2', () => {
    // GPW2 1.1 patches the body behind $21's handler pointer and puts a
    // computed dispatch in front of the draw call. Its own count is the
    // evidence that this number is measured per cart, not remembered.
    const expected: Record<string, number> = { 'Grand Poo World 2 1.1.sfc': 56 }
    for (const { name, rom } of allRoms()) {
      const readings = readGfxRoutines(rom, TILEMAP_IDS)
      const decided = [...readings.values()].filter(r => decidedRoutine(r) !== null)
      expect(decided.length, name).toBe(expected[name] ?? 57)
    }
  })

  it('never contradicts the frozen table it replaces, on any cart', () => {
    for (const { name, rom } of allRoms()) {
      const readings = readGfxRoutines(rom, TILEMAP_IDS)
      const clashes: string[] = []
      for (const [id, reading] of readings) {
        const live = decidedRoutine(reading)
        if (live && live !== frozenAnswer(rom, id)) {
          clashes.push(`$${id.toString(16)} live=${live} frozen=${frozenAnswer(rom, id)}`)
        }
      }
      expect(clashes, name).toEqual([])
    }
  })

  it('splits the remainder into 5 ambiguous and the rest unreached', () => {
    for (const { name, rom } of allRoms()) {
      const readings = readGfxRoutines(rom, TILEMAP_IDS)
      const kinds = [...readings.values()].map(r => r.kind)
      const tally = (k: string) => kinds.filter(x => x === k).length
      // Para-Goomba, Para-Bomb, Jumping Piranha and two others draw several
      // parts through different routines. There is no single answer to give.
      expect(tally('ambiguous'), name).toBe(5)
      expect(
        tally('read') + tally('selected') + tally('ambiguous') + tally('unreached'),
        name,
      ).toBe(TILEMAP_IDS)
    }
  })

  it('reads the Spr0to13 selector, table and mask, off the cart', () => {
    for (const { name, rom } of allRoms()) {
      const r = readGfxRoutine(rom, SELECTED)
      expect(r.kind, name).toBe('selected')
      if (r.kind !== 'selected') return
      // `LDA Spr0to13Prop,Y : AND #$40 : BNE`, bank_01.asm:1763-1765.
      expect(r.select.table, name).toBe(SPR_0_TO_13_PROP_ADDR)
      expect(r.select.mask, name).toBe(0x40)
      expect(r.select.whenSet, name).toBe('sub1')
      expect(r.select.whenClear, name).toBe('sub2')
    }
  })

  it('resolves every one of the 17 ids that reach that selector', () => {
    for (const { name, rom } of allRoms()) {
      const selected = [...readGfxRoutines(rom, TILEMAP_IDS)]
        .filter(([, r]) => r.kind === 'selected')
        .map(([id]) => id)
      expect(selected.length, name).toBe(17)
      // The frozen list named 12 of these. The five it left out are the
      // ones whose prop byte has the bit clear, so the omission never
      // showed; the reader covers them because the code path does.
      expect(selected, name).toEqual(expect.arrayContaining(SPR_0_TO_13_START_IDS))
    }
  })

  it('reaches a bank-3 sprite only through the dispatch chain', () => {
    for (const { name, rom } of allRoms()) {
      const site = resolveHandlerSite(rom, REX)
      expect(site?.via, name).toBe('dispatched')
      expect(site!.at & 0xffff, name).toBe(0x9517) // RexMainRt, SMW_U.sym
    }
  })

  it('never reaches a probe ceiling at the default budgets, on any cart', () => {
    // A refusal costs a live answer, so a default set where a real cart
    // trips it is a silent loss of coverage. This walks the handlers
    // directly rather than reading the verdicts, because a `GfxRoutineReading`
    // keeps `stops` only when it is `unreached`: at `DEFAULT_PROBE_DEPTH` 4
    // the two ids that refuse are $4F and $50, both `ambiguous`, so their
    // stops are discarded and no count moves. Measured thresholds, by
    // bisecting each ceiling against the default result on all six carts:
    // the corpus needs a budget of 159 and a depth of 5.
    for (const { name, rom } of allRoms()) {
      const refused: string[] = []
      for (let id = 0; id < TILEMAP_IDS; id++) {
        const site = resolveHandlerSite(rom, id)
        if (!site) continue
        for (const stop of walkHandler(rom, site.at, { watch: WATCHED_ENTRIES }).stops) {
          if (stop === 'probeBudget' || stop === 'probeDepth') {
            refused.push(`$${id.toString(16)}: ${stop}`)
          }
        }
      }
      expect(refused, name).toEqual([])
    }
  })

  it('says plainly that Magikoopa is unreached, and why', () => {
    for (const { name, rom } of allRoms()) {
      const r = readGfxRoutine(rom, UNREACHED)
      expect(r.kind, name).toBe('unreached')
      if (r.kind === 'unreached') expect(r.stops, name).toContain('nonReturningCall')
    }
  })
})

describe.skipIf(!romsPresent)('every verdict follows a cart byte', () => {
  it('follows the JSR operand that names the shared routine', () => {
    const rom = freshRom()
    const before = readGfxRoutine(rom, SINGLE_SUB1)
    expect(before.kind).toBe('read')
    if (before.kind !== 'read') return
    expect(before.routine).toBe('sub1')
    // SubSprGfx2Entry1 is $9F0D, SubSprGfx1 is $9D67; both in bank $01.
    rom.writeAt(before.callAt + 1, [0x0d, 0x9f])
    expect(decidedRoutine(readGfxRoutine(rom, SINGLE_SUB1))).toBe('sub2')
  })

  it('follows the selector table byte, so the bit decides', () => {
    const rom = freshRom()
    expect(decidedRoutine(readGfxRoutine(rom, SELECTED))).toBe('sub1')
    const at = SPR_0_TO_13_PROP_ADDR + SELECTED
    rom.writeAt(at, [rom.readByte(at)! & ~0x40 & 0xff])
    expect(decidedRoutine(readGfxRoutine(rom, SELECTED))).toBe('sub2')
  })

  it('follows the selector MASK, not a remembered $40', () => {
    const rom = freshRom()
    const r = readGfxRoutine(rom, SELECTED)
    expect(r.kind).toBe('selected')
    if (r.kind !== 'selected') return
    // Spr0to13Prop[$04] is $40. Testing bit 0 instead flips the verdict
    // without touching the table at all.
    rom.writeAt(r.select.at - 1, [0x01])
    const after = readGfxRoutine(rom, SELECTED)
    expect(after.kind === 'selected' && after.select.mask).toBe(0x01)
    expect(decidedRoutine(after)).toBe('sub2')
  })

  it('follows the selector branch POLARITY', () => {
    const rom = freshRom()
    const r = readGfxRoutine(rom, SELECTED)
    if (r.kind !== 'selected') throw new Error('precondition: $04 is selector-resolved')
    expect(rom.readByte(r.select.at)).toBe(0xd0) // BNE
    rom.writeAt(r.select.at, [0xf0]) // BEQ: the sides swap
    const after = readGfxRoutine(rom, SELECTED)
    expect(after.kind === 'selected' && after.select.whenSet).toBe('sub2')
    expect(decidedRoutine(after)).toBe('sub2')
  })

  it('follows the selector TABLE ADDRESS, not a remembered $0188F0', () => {
    const rom = freshRom()
    const r = readGfxRoutine(rom, SELECTED)
    if (r.kind !== 'selected') throw new Error('precondition: $04 is selector-resolved')
    // Point the load at a stretch of bank $01 whose byte at +$04 has bit 6
    // clear, and the verdict must change even though $0188F0 is untouched.
    const moved = 0x018000
    expect((rom.readByte(moved + SELECTED)! & 0x40) === 0).toBe(true)
    rom.writeAt(r.select.at - 4, [moved & 0xff, (moved >> 8) & 0xff])
    const after = readGfxRoutine(rom, SELECTED)
    expect(after.kind === 'selected' && after.select.table).toBe(moved)
    expect(decidedRoutine(after)).toBe('sub2')
  })

  it('follows the dispatch chain link for a bank-3 sprite', () => {
    const rom = freshRom()
    // Rex draws through none of the three shared routines, so the verdict
    // is unreached either way. The claim under test is the one underneath
    // it: the code being walked is whatever the chain's JSR operand names.
    expect(readGfxRoutine(rom, REX).kind).toBe('unreached')
    const operandAt = findChainJsrOperand(rom, REX)
    rom.writeAt(operandAt, [0xb2, 0x90])
    expect(resolveHandlerSite(rom, REX)).toEqual({ at: 0x0390b2, via: 'dispatched' })
    // $03:90B2 is not bank 1's GenericSprGfxRt2, so still no shared routine.
    expect(decidedRoutine(readGfxRoutine(rom, REX))).toBe(null)
  })

  it('reaches sub2 when the chain link is pointed at code that calls it', () => {
    const rom = freshRom()
    // A three-byte JSL into bank 1's sub2 trampoline, planted in bank 3.
    const planted = 0x03fff0
    rom.writeAt(planted, [0x22, 0xb2, 0x90, 0x01, 0x6b])
    rom.writeAt(findChainJsrOperand(rom, REX), [planted & 0xff, (planted >> 8) & 0xff])
    expect(decidedRoutine(readGfxRoutine(rom, REX))).toBe('sub2')
  })

  it('declines a relocated ExecutePtr instead of decoding its table', () => {
    // The hazard is not the address $00:86DF. It is that the bytes after
    // the call are a dw table, and a copy of that routine anywhere else
    // has the same property. Copy the body to $00:FFB0 and repoint the
    // one JSL that Magikoopa's handler makes.
    const rom = freshRom()
    const before = readGfxRoutine(rom, UNREACHED)
    expect(before.kind).toBe('unreached')
    const body = rom.readAt(0x0086df, 0x1b)!
    rom.writeAt(0x00ffb0, Array.from(body))
    rom.writeAt(0x01bde6, [0x22, 0xb0, 0xff, 0x00])
    const after = readGfxRoutine(rom, UNREACHED)
    expect(after.kind).toBe('unreached')
    if (after.kind === 'unreached') expect(after.stops).toContain('nonReturningCall')
  })

  it('reads the sub0 prop group from the LDA in front of the call', () => {
    for (const { name, rom } of allRoms()) {
      // $14 SpinyEgg and $2F portable spring both pass 2; $2B passes 0.
      // bank_01.asm:1813 and :13884 for the two twos.
      expect(decidedPropGroup(readGfxRoutine(rom, 0x14)), name).toBe(2)
      expect(decidedPropGroup(readGfxRoutine(rom, 0x2b)), name).toBe(0)
      expect(decidedPropGroup(readGfxRoutine(rom, 0x2f)), name).toBe(2)
    }
  })

  it('follows the prop-group immediate, and drops it when it is not one', () => {
    const rom = freshRom()
    const r = readGfxRoutine(rom, 0x2f)
    if (r.kind !== 'read') throw new Error('precondition: $2F resolves to a single routine')
    rom.writeAt(r.callAt - 1, [0x05])
    expect(decidedPropGroup(readGfxRoutine(rom, 0x2f))).toBe(5)

    // $A5 is `LDA dp`, two bytes, so the call stays where it was and the
    // only thing that changed is what reaches it in A. An earlier version
    // of this test planted $EA, and NOP being ONE byte shifted the decode
    // so the call was never reached at all: the reading came back
    // `unreached` and the null was for an unrelated reason.
    const shifted = freshRom()
    shifted.writeAt(r.callAt - 2, [0xea])
    expect(readGfxRoutine(shifted, 0x2f).kind).toBe('unreached')

    const kept = freshRom()
    expect(kept.readByte(r.callAt - 2)).toBe(0xa9) // LDA #imm, as read
    kept.writeAt(r.callAt - 2, [0xa5]) // LDA dp: same length, no immediate
    const after = readGfxRoutine(kept, 0x2f)
    expect(after.kind).toBe('read')
    expect(after.kind === 'read' && after.callAt).toBe(r.callAt)
    expect(decidedPropGroup(after)).toBe(null)
  })

  it('will not take a prop group from bytes that only look like an LDA #imm', () => {
    // `LDA $07A9` is `AD A9 07`: three bytes ending two before the call,
    // whose last two spell `LDA #$07`. Matching bytes at `callAt - 2`
    // read a row of 7 that no instruction ever loaded, and because live
    // beats frozen it overrode the correct frozen 2. The decoder already
    // knows A holds a table read here, so nothing is claimed.
    const rom = freshRom()
    const r = readGfxRoutine(rom, 0x2f)
    if (r.kind !== 'read') throw new Error('precondition: $2F resolves to a single routine')
    expect(decidedPropGroup(r)).toBe(2)
    rom.writeAt(r.callAt - 3, [0xad, 0xa9, 0x07])
    const after = readGfxRoutine(rom, 0x2f)
    expect(after.kind === 'read' && after.callAt).toBe(r.callAt)
    expect(decidedPropGroup(after)).toBe(null)
  })

  it('caches per cart and re-reads once a byte is planted', () => {
    // The cache exists because a map build reruns on every toolbar change.
    // A cache that missed a planted byte would make every test above lie.
    const rom = freshRom()
    const first = readGfxRoutines(rom, 0x54)
    expect(readGfxRoutines(rom, 0x54)).toBe(first)
    const link = readGfxRoutine(rom, SINGLE_SUB1)
    if (link.kind !== 'read') throw new Error('precondition')
    rom.writeAt(link.callAt + 1, [0x0d, 0x9f])
    const second = readGfxRoutines(rom, 0x54)
    expect(second).not.toBe(first)
    expect(decidedRoutine(second.get(SINGLE_SUB1))).toBe('sub2')
  })

  it('reports noHandler for an id past the pointer table', () => {
    expect(readGfxRoutine(freshRom(), 500).kind).toBe('noHandler')
  })

  it('messages name the address that produced the verdict', () => {
    const rom = freshRom()
    expect(gfxRoutineMessage(readGfxRoutine(rom, SINGLE_SUB1))).toMatch(
      /^sub1 via the call at \$01/,
    )
    expect(gfxRoutineMessage(readGfxRoutine(rom, SELECTED))).toContain('$0188F0 & $40')
    expect(gfxRoutineMessage(readGfxRoutine(rom, UNREACHED))).toContain('nonReturningCall')
    expect(gfxRoutineMessage(readGfxRoutine(rom, 500))).toContain('unreadable')
  })
})

describe.skipIf(!romsPresent)('all nine shared entry points are watched', () => {
  /** Every entry point and trampoline, with a vanilla caller that reaches
   *  it, so dropping any one row from the watch map goes red. Addresses
   *  from `SMW_U.sym`; each caller found by walking the sprite named. */
  const ENTRY_POINTS: ReadonlyArray<readonly [number, string, string]> = [
    [0x019cf3, 'sub0', 'SubSprGfx0Entry0 bank_01.asm:3853'],
    [0x019cf5, 'sub0', 'SubSprGfx0Entry1 bank_01.asm:3855'],
    [0x019d67, 'sub1', 'SubSprGfx1 bank_01.asm:3920'],
    [0x019f09, 'sub2', 'SubSprGfx2Entry0 bank_01.asm:4144'],
    [0x019f0d, 'sub2', 'SubSprGfx2Entry1 bank_01.asm:4148'],
    [0x018042, 'sub0', 'GenericSprGfxRt0 bank_01.asm:61'],
    [0x019d5f, 'sub1', 'GenericSprGfxRt1 bank_01.asm:3912'],
    [0x0190b2, 'sub2', 'GenericSprGfxRt2 bank_01.asm:2393'],
  ]

  it.each(ENTRY_POINTS)('$%s is classified as its own routine', (addr, routine, label) => {
    // A planted handler calling the entry point directly, so the claim is
    // about the watch map and not about which sprite happens to use it.
    const bytes = new Uint8Array(0x400000).fill(0xea)
    bytes[0x7fd5] = 0x20
    const rom = RomFile.fromBytes('synthetic.sfc', bytes)
    const at = 0x018800
    rom.writeAt(at, [0x20, (addr as number) & 0xff, ((addr as number) >> 8) & 0xff, 0x60])
    rom.writeAt(0x0185cc, [at & 0xff, (at >> 8) & 0xff])
    const r = readGfxRoutine(rom, 0)
    expect(r.kind, label as string).toBe('read')
    if (r.kind === 'read') expect(r.routine, label as string).toBe(routine)
  })

  it('classifies a call that is not one of them as reaching nothing', () => {
    const bytes = new Uint8Array(0x400000).fill(0xea)
    bytes[0x7fd5] = 0x20
    const rom = RomFile.fromBytes('synthetic.sfc', bytes)
    rom.writeAt(0x018800, [0x20, 0x00, 0x91, 0x60])
    rom.writeAt(0x019100, [0x60])
    rom.writeAt(0x0185cc, [0x00, 0x88])
    expect(readGfxRoutine(rom, 0).kind).toBe('unreached')
  })
})

describe('a synthetic cart, for shapes no real cart holds', () => {
  /** A 4 MB LoROM cart of NOPs with one planted handler and one planted
   *  MAIN pointer. The shared-routine addresses are real, so a planted
   *  `JSR $9F0D` counts as sub2 even though nothing is there. */
  function cartWithHandler(code: number[], handlerAt = 0x018800, id = 0): RomFile {
    const bytes = new Uint8Array(0x400000).fill(0xea)
    bytes[0x7fd5] = 0x20
    const rom = RomFile.fromBytes('synthetic.sfc', bytes)
    rom.writeAt(handlerAt, code)
    rom.writeAt(0x0185cc + id * 2, [handlerAt & 0xff, (handlerAt >> 8) & 0xff])
    return rom
  }

  const jsr = (t: number) => [0x20, t & 0xff, (t >> 8) & 0xff]
  /** `LDY SpriteNumber,X : LDA $88F0,Y : AND #$40 : BNE +4`. */
  const bitTestBranch = [0xb4, 0x9e, 0xb9, 0xf0, 0x88, 0x29, 0x40, 0xd0, 0x04]

  it('declines a branch whose two sides reach the SAME routine', () => {
    // Two routines are reachable overall, so the selector search runs, but
    // the branch does not separate them. Reporting it as a selector would
    // hand back a routine chosen by a bit that decides nothing.
    const rom = cartWithHandler([
      ...jsr(0x9d67), // sub1, above the branch
      ...bitTestBranch,
      ...jsr(0x9f0d),
      0x60, // not taken: sub2
      ...jsr(0x9f0d),
      0x60, // taken: sub2 as well
    ])
    const r = readGfxRoutine(rom, 0)
    expect(r.kind).toBe('ambiguous')
    expect(decidedRoutine(r)).toBe(null)
  })

  it('declines a bit test whose index is not the sprite number', () => {
    // Same split, same two routines, but Y was loaded with a constant. The
    // table byte it reads is not the one for this sprite, so resolving
    // from it would be a confident answer about the wrong row.
    const rom = cartWithHandler([
      ...jsr(0x9d67),
      0xa0,
      0x00, // LDY #$00 in place of LDY SpriteNumber,X
      0xb9,
      0xf0,
      0x88,
      0x29,
      0x40,
      0xd0,
      0x04,
      ...jsr(0x9f0d),
      0x60,
      ...jsr(0x9cf5),
      0x60,
    ])
    const r = readGfxRoutine(rom, 0)
    expect(r.kind).toBe('ambiguous')
  })

  it('claims a prop group only for sub0, whatever A held at the call', () => {
    // `propGroup` is the `GeneralSprGfxProp` row `SubSprGfx0Entry1` reads
    // out of A. `SubSprGfx1` does not read A that way, so an immediate in
    // front of a sub1 call names nothing. Reporting it anyway would put a
    // row number on a reading whose routine has no rows.
    const sub1 = cartWithHandler([0xa9, 0x07, ...jsr(0x9d67), 0x60])
    const r1 = readGfxRoutine(sub1, 0)
    expect(r1.kind === 'read' && r1.routine).toBe('sub1')
    expect(decidedPropGroup(r1)).toBe(null)

    // The identical shape aimed at sub0, so the assertion above is about
    // the routine and not about the immediate being unreadable.
    const sub0 = cartWithHandler([0xa9, 0x07, ...jsr(0x9cf5), 0x60])
    expect(decidedPropGroup(readGfxRoutine(sub0, 0))).toBe(7)
  })

  it('takes the same branch when the sides do separate the routines', () => {
    // The identical shape with one operand changed, so the previous test is
    // about the guard and not about the cart being unreadable.
    const rom = cartWithHandler([
      ...jsr(0x9d67),
      ...bitTestBranch,
      ...jsr(0x9f0d),
      0x60, // not taken: sub2
      ...jsr(0x9cf5),
      0x60, // taken: sub0
    ])
    const r = readGfxRoutine(rom, 0)
    expect(r.kind).toBe('selected')
    if (r.kind === 'selected') {
      expect(r.select.whenClear).toBe('sub2')
      expect(r.select.whenSet).toBe('sub0')
    }
  })
})

/** Address of the operand of the chain `JSR` that claims `spriteId`. The
 *  reader gives the routine, not the site, so it is recovered by matching. */
function findChainJsrOperand(rom: RomFile, spriteId: number): number {
  const site = resolveHandlerSite(rom, spriteId)!
  const stub = rom.readAt(0x0185cc + spriteId * 2, 2)!
  const target = rom.readAt(0x010000 | stub[0] | (stub[1] << 8), 4)!
  const chainAt = target[1] | (target[2] << 8) | (target[3] << 16)
  for (let p = chainAt; p < chainAt + 0x400; p++) {
    const b = rom.readAt(p, 3)!
    if (b[0] === 0x20 && ((chainAt & 0xff0000) | b[1] | (b[2] << 8)) === site.at) return p + 1
  }
  throw new Error('chain JSR not found')
}
