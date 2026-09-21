/**
 * The dispatch-chain reader, proved to READ rather than to remember.
 *
 * Every value the reader reports has a test here that plants a different
 * byte in an in-memory copy of a real cart and shows the output follows it.
 * That is the whole standard: if changing the cart byte does not change the
 * result, the reader did not read it, and a "mapping" that merely records
 * what vanilla happens to hold is a hardcoded table wearing an address.
 *
 * Test tree:
 *   grammar on the vanilla corpus - shape, count and specific mappings
 *   planted bytes                 - id, routine, stub target, pair, geometry
 *   refusals                      - the four stubs that are not chains,
 *                                   plus each opcode check, one at a time
 *   bounds                        - a chain that never ends
 *
 * Nothing is written to disk: `RomFile.writeAt` mutates the loaded buffer.
 *
 * Evidence scope: `Bnk3CallSprMain` bank_03.asm:4305-4525. Corpus claims run
 * on all six carts in `test/roms/`; planted bytes run on
 * `Super Mario World (USA).vanilla.sfc`. Static reads only; no emulator was
 * run.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../../src/rom/RomFile'
import {
  MAX_CHAIN_LINKS,
  dispatchMessage,
  readDispatchChain,
  readHandlerThunk,
  resolveDispatch,
  type ChainLink,
  type DispatchChainRead,
} from '../../../../src/rom/dispatch/DispatchChain'
import {
  SPRITE_MAIN_PTR_TABLE,
  SPRITE_PTR_TABLE_COUNT,
} from '../../../../src/rom/dispatch/SpritePointerTables'

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

/** A fresh in-memory cart per test, so a planted byte never leaks sideways. */
const freshRom = (name: (typeof ROM_FILES)[number] = ROM_FILES[0]) =>
  RomFile.load(resolve(ROM_DIR, name))
const allRoms = () => ROM_FILES.map(name => ({ name, rom: freshRom(name) }))

// Sprite ids used as probes. Each names a DIFFERENT shape behind the MAIN
// pointer, so a change that collapses two shapes cannot pass unnoticed.
/** Rex. A plain one-id link, bank_03.asm:4485-4489. */
const REX = 0xab
/** Bowser. The only id no link claims, so it reaches the tail block. */
const FALLTHROUGH_ID = 0xa0
/** Carrot Top Lift, the `CMP/BEQ/CMP/BNE` pair at bank_03.asm:4412-4419. */
const PAIR_A = 0xb8
const PAIR_B = 0xb7
/** Falling Spike, the link preceded by a reload, bank_03.asm:4445-4450. */
const RELOADED = 0xb2
/** A Koopa: MAIN points at a real handler, so there is no stub to read. */
const DIRECT = 0x04

/** The `JSL/RTS` stub every bank-3 sprite's MAIN pointer holds. */
function bank3Thunk(rom: RomFile) {
  const t = readHandlerThunk(rom, mainHandlerOf(rom, REX))
  if (!t) throw new Error('bank-3 MAIN pointer is not a JSL/RTS stub')
  return t
}

function mainHandlerOf(rom: RomFile, spriteId: number): number {
  const p = rom.readAt(SPRITE_MAIN_PTR_TABLE + spriteId * 2, 2)
  if (!p) throw new Error('MAIN pointer unreadable')
  return 0x010000 | p[0] | (p[1] << 8)
}

function chainOf(rom: RomFile): DispatchChainRead {
  return readDispatchChain(rom, bank3Thunk(rom).target)
}

/** The chain, or a thrown failure, so a broken precondition is not read as
 *  a passing assertion about an empty link list. */
function linksOf(rom: RomFile): readonly ChainLink[] {
  const c = chainOf(rom)
  if (c.kind !== 'chain') throw new Error(`chain refused: ${JSON.stringify(c.refusal)}`)
  return c.links
}

function linkFor(rom: RomFile, spriteId: number): ChainLink {
  const l = linksOf(rom).find(x => x.ids.includes(spriteId))
  if (!l) throw new Error(`no link claims $${spriteId.toString(16)}`)
  return l
}

/** Address of the `CMP` immediate that selects a simple link:
 *  `CMP #imm` (2) + `BNE rel` (2) sit immediately before the `JSR`. */
const cmpImmAddrOf = (link: ChainLink) => link.jsrAt - 3
/** Address of the `BNE` displacement of a simple link. */
const bneRelAddrOf = (link: ChainLink) => link.jsrAt - 1

// ── Grammar on the corpus ───────────────────────────────────────────────────

describe.skipIf(!romsPresent)('the bank-3 chain as the six carts hold it', () => {
  it('every cart points all bank-3 sprites at one JSL/RTS stub', () => {
    for (const { name, rom } of allRoms()) {
      const t = bank3Thunk(rom)
      const behind = Array.from({ length: SPRITE_PTR_TABLE_COUNT }, (_, i) => i).filter(
        i => mainHandlerOf(rom, i) === t.at,
      )
      expect(behind.length, name).toBe(37)
      expect(behind, name).toContain(REX)
      expect(behind, name).toContain(FALLTHROUGH_ID)
    }
  })

  it('reads 34 links covering 36 ids, with one id left to the tail block', () => {
    for (const { name, rom } of allRoms()) {
      const c = chainOf(rom)
      expect(c.kind, name).toBe('chain')
      if (c.kind !== 'chain') return
      expect(c.links.length, name).toBe(34)
      const ids = c.links.flatMap(l => l.ids)
      expect(ids.length, name).toBe(36)
      expect(new Set(ids).size, name).toBe(36)
      expect(ids, name).not.toContain(FALLTHROUGH_ID)
    }
  })

  it('accounts for all 37 ids: 36 dispatched plus 1 fallthrough', () => {
    for (const { name, rom } of allRoms()) {
      const kinds = Array.from(
        { length: SPRITE_PTR_TABLE_COUNT },
        (_, i) => resolveDispatch(rom, i).kind,
      )
      const tally = (k: string) => kinds.filter(x => x === k).length
      expect(tally('dispatched'), name).toBe(36)
      expect(tally('fallthrough'), name).toBe(1)
      expect(tally('dispatched') + tally('fallthrough'), name).toBe(37)
    }
  })

  it('resolves $AB to RexMainRt, whose JSR is the one at bank_03.asm:4487', () => {
    for (const { name, rom } of allRoms()) {
      const r = resolveDispatch(rom, REX)
      expect(r.kind, name).toBe('dispatched')
      if (r.kind !== 'dispatched') return
      // `RexMainRt` is $03:9517 in `SMWDisX/SMW_U.sym`. The bank comes from
      // the chain's own address, which is why the mirrored carts agree.
      expect(r.handler & 0xffff, name).toBe(0x9517)
      expect(r.sharedWith, name).toEqual([])
    }
  })

  it('reads the two paired links as two ids sharing one routine', () => {
    for (const { name, rom } of allRoms()) {
      const pairs = linksOf(rom).filter(l => l.ids.length > 1)
      expect(pairs.length, name).toBe(2)
      // CarrotTopLift $03:8C2F and WoodenSpike $03:9423, SMW_U.sym.
      expect(
        pairs.map(p => [p.ids, p.routine & 0xffff]),
        name,
      ).toEqual([
        [[PAIR_A, PAIR_B], 0x8c2f],
        [[0xac, 0xad], 0x9423],
      ])
    }
  })

  it('tells each half of a pair that its routine is shared', () => {
    const rom = freshRom()
    const a = resolveDispatch(rom, PAIR_A)
    const b = resolveDispatch(rom, PAIR_B)
    expect(a.kind === 'dispatched' && a.sharedWith).toEqual([PAIR_B])
    expect(b.kind === 'dispatched' && b.sharedWith).toEqual([PAIR_A])
  })

  it('steps over the mid-chain SpriteNumber reload instead of refusing', () => {
    // bank_03.asm:4445. Without the reload case the walk would refuse there
    // and lose every link below it, which is 12 of the 34.
    for (const { name, rom } of allRoms()) {
      const r = resolveDispatch(rom, RELOADED)
      expect(r.kind, name).toBe('dispatched')
    }
  })

  it('reports the unmatched id as a fallthrough address, not as a routine', () => {
    for (const { name, rom } of allRoms()) {
      const r = resolveDispatch(rom, FALLTHROUGH_ID)
      expect(r.kind, name).toBe('fallthrough')
      // The tail block is `JSL : JSR : JSR : PLB : RTL` (bank_03.asm:4521),
      // three calls rather than one, so no single routine is claimed for it.
      if (r.kind === 'fallthrough') expect(r.at & 0xffff, name).toBe(0xa259)
      expect(r, name).not.toHaveProperty('handler')
    }
  })

  it('leaves a sprite whose MAIN pointer is a real handler alone', () => {
    for (const { name, rom } of allRoms()) {
      const r = resolveDispatch(rom, DIRECT)
      expect(r.kind, name).toBe('direct')
      if (r.kind === 'direct') expect(r.handler, name).toBe(mainHandlerOf(rom, DIRECT))
    }
  })
})

// ── Planted bytes ───────────────────────────────────────────────────────────

describe.skipIf(!romsPresent)('every reported value follows the cart byte', () => {
  it('the id a link claims comes from its CMP immediate', () => {
    const rom = freshRom()
    const at = cmpImmAddrOf(linkFor(rom, REX))
    // $B4 is behind no stub in vanilla, so it cannot collide with a real link.
    rom.writeAt(at, [0xb4])
    expect(resolveDispatch(rom, REX).kind).toBe('fallthrough')
    const moved = linksOf(rom).find(l => l.ids.includes(0xb4))
    expect(moved?.routine).toBe(linkFor(freshRom(), REX).routine)
  })

  it('the routine a link names comes from its JSR operand', () => {
    const rom = freshRom()
    rom.writeAt(linkFor(rom, REX).jsrAt + 1, [0x34, 0x12])
    const r = resolveDispatch(rom, REX)
    expect(r.kind === 'dispatched' && r.handler & 0xffff).toBe(0x1234)
  })

  it('the bank of the routine comes from the stub JSL, not from a constant', () => {
    const rom = freshRom()
    const t = bank3Thunk(rom)
    // Re-point the stub at the $80-mirror of the same chain. Same bytes, a
    // different bank, so a hardcoded bank would not move with it.
    rom.writeAt(t.at + 1, [
      t.target & 0xff,
      (t.target >> 8) & 0xff,
      ((t.target >> 16) | 0x80) & 0xff,
    ])
    const r = resolveDispatch(rom, REX)
    expect(r.kind === 'dispatched' && r.handler >> 16).toBe((t.target >> 16) | 0x80)
  })

  it('the chain is read at the address the stub JSL names', () => {
    const rom = freshRom()
    const t = bank3Thunk(rom)
    // A whole one-link chain planted elsewhere in the same bank. If the
    // reader used a fixed address rather than the stub's operand it would
    // still find the 34-link original.
    const planted = (t.target & 0xff0000) | ((t.target + 0x1000) & 0xffff)
    rom.writeAt(planted, [
      0x8b,
      0x4b,
      0xab,
      0xb5,
      0x9e, // PHB PHK PLB LDA SpriteNumber,X
      0xc9,
      REX,
      0xd0,
      0x05,
      0x20,
      0x34,
      0x12,
      0xab,
      0x6b, // CMP/BNE/JSR/PLB/RTL
      0x60, // not a CMP: the tail block
    ])
    rom.writeAt(t.at + 1, [planted & 0xff, (planted >> 8) & 0xff, (planted >> 16) & 0xff])
    expect(linksOf(rom).length).toBe(1)
    const r = resolveDispatch(rom, REX)
    expect(r.kind === 'dispatched' && r.handler & 0xffff).toBe(0x1234)
  })

  it('a stub whose RTS is gone is not a stub, so the pointer stands', () => {
    const rom = freshRom()
    rom.writeAt(bank3Thunk(rom).at + 4, [0xea])
    const r = resolveDispatch(rom, REX)
    expect(r.kind).toBe('direct')
    if (r.kind === 'direct') expect(r.handler).toBe(mainHandlerOf(rom, REX))
  })

  it('the pair form is recognised by its BEQ, not by the ids in it', () => {
    const rom = freshRom()
    const pair = linkFor(rom, PAIR_A)
    // The `BEQ` sits six bytes before the `JSR`: `BEQ`(2) `CMP`(2) `BNE`(2).
    const beqAt = pair.jsrAt - 6
    expect(rom.readAt(beqAt, 1)![0]).toBe(0xf0)
    rom.writeAt(beqAt, [0xd0])
    // Without the `BEQ` the second `CMP` now stands where a `JSR` must be.
    // The reader refuses there instead of mapping $B8 onto whatever follows.
    const c = chainOf(rom)
    expect(c.kind).toBe('refused')
    if (c.kind === 'refused') {
      expect(c.refusal.expected).toBe('JSR abs')
      expect(c.refusal.found).toBe(0xc9)
    }
  })
})

// ── Refusals ────────────────────────────────────────────────────────────────

describe.skipIf(!romsPresent)('the reader refuses rather than guessing', () => {
  /** Plant one byte and assert the walk stops there with a named expectation. */
  function refusalAfter(at: number, byte: number) {
    const rom = freshRom()
    rom.writeAt(at, [byte])
    const c = chainOf(rom)
    expect(c.kind).toBe('refused')
    return c.kind === 'refused' ? c.refusal : null
  }

  it('stops on a prologue that does not load SpriteNumber', () => {
    const rom = freshRom()
    const t = bank3Thunk(rom)
    // `LDA abs,X` rather than `LDA dp,X`: a chain dispatching on some other
    // byte is refused, not mapped as though it keyed on the sprite number.
    const r = refusalAfter(t.target + 3, 0xbd)
    expect(r?.expected).toBe('LDA dp,X')
    expect(r?.found).toBe(0xbd)
    expect(r?.at).toBe(t.target + 3)
  })

  it('stops when the prologue reads a different direct-page address', () => {
    const t = bank3Thunk(freshRom())
    const r = refusalAfter(t.target + 4, 0x9f)
    expect(r?.expected).toBe('SpriteNumber operand')
    expect(r?.found).toBe(0x9f)
  })

  it('stops when a link does not restore the data bank', () => {
    const rom = freshRom()
    const link = linkFor(rom, REX)
    const r = refusalAfter(link.jsrAt + 3, 0xea)
    expect(r?.expected).toBe('PLB')
    expect(r?.found).toBe(0xea)
  })

  it('stops when a link does not return long', () => {
    const rom = freshRom()
    const link = linkFor(rom, REX)
    const r = refusalAfter(link.jsrAt + 4, 0x60)
    expect(r?.expected).toBe('RTL')
    expect(r?.found).toBe(0x60)
  })

  it('stops when a link calls through something other than JSR', () => {
    const rom = freshRom()
    const link = linkFor(rom, REX)
    // `JSL` is longer than `JSR`, so taking its operand would shift every
    // link below it. This is the mis-cut the opcode check exists to stop.
    const r = refusalAfter(link.jsrAt, 0x22)
    expect(r?.expected).toBe('JSR abs')
    expect(r?.found).toBe(0x22)
  })

  it('stops when a BNE does not skip exactly one link tail', () => {
    const rom = freshRom()
    const link = linkFor(rom, REX)
    // Displacement 6 instead of 5 would land one byte into the next link and
    // re-cut every link below it at the wrong offset.
    const r = refusalAfter(bneRelAddrOf(link), 0x06)
    expect(r?.expected).toContain('BNE skipping 5 bytes')
  })

  it('stops when a paired BEQ does not land on its own JSR', () => {
    const rom = freshRom()
    const pair = linkFor(rom, PAIR_A)
    const r = refusalAfter(pair.jsrAt - 5, 0x06)
    expect(r?.expected).toContain('BEQ skipping 4 bytes')
  })

  it('stops when a mid-chain reload reads a different address', () => {
    const rom = freshRom()
    const link = linkFor(rom, RELOADED)
    // The reload is `LDA dp,X` immediately before this link's `CMP`.
    const operandAt = cmpImmAddrOf(link) - 2
    expect(rom.readAt(operandAt - 1, 2)![0]).toBe(0xb5)
    const r = refusalAfter(operandAt, 0x9f)
    expect(r?.expected).toBe('SpriteNumber operand')
  })

  it('names the link it stopped in, so a refusal can be located', () => {
    const rom = freshRom()
    const first = linksOf(rom)[0]
    const last = linkFor(rom, REX)
    expect(refusalAfter(first.jsrAt + 3, 0xea)?.linkIndex).toBe(0)
    expect(refusalAfter(last.jsrAt + 3, 0xea)?.linkIndex).toBeGreaterThan(20)
  })

  it('refuses the four other multi-id stubs, each at its own byte', () => {
    // Verified claim, against the relay this work started from: these do NOT
    // share the bank-3 chain's shape. Four different shapes, four refusals.
    const rom = freshRom()
    const cases = [
      // Chucks, bank_02.asm:8758. Reads SpriteMisc187B, not SpriteNumber.
      { id: 0x91, expected: 'LDA dp,X', found: 0xbd },
      // InvisSolid_Dinos, bank_03.asm:3655. No PHB/PHK/PLB prologue at all.
      { id: 0x6d, expected: 'PHB', found: 0xb5 },
      // Banzai_Rotating, bank_02.asm:11365. A two-way split joined by a
      // `BRA`, so it gets as far as the link tail and fails there.
      { id: 0x9e, expected: 'PLB', found: 0x80 },
      // JumpingPiranha, bank_02.asm:12804. Straight into a `JSR`.
      { id: 0x4f, expected: 'LDA dp,X', found: 0x20 },
    ]
    for (const c of cases) {
      const r = resolveDispatch(rom, c.id)
      expect(r.kind, `$${c.id.toString(16)}`).toBe('chainRefused')
      if (r.kind !== 'chainRefused') continue
      expect(r.refusal.expected, `$${c.id.toString(16)}`).toBe(c.expected)
      expect(r.refusal.found, `$${c.id.toString(16)}`).toBe(c.found)
    }
  })

  it('leaves the refused stubs unmapped rather than guessing a routine', () => {
    for (const { name, rom } of allRoms()) {
      const refused = Array.from({ length: SPRITE_PTR_TABLE_COUNT }, (_, i) =>
        resolveDispatch(rom, i),
      ).filter(r => r.kind === 'chainRefused')
      // 83 ids sit behind a stub and 37 of them are the bank-3 chain.
      expect(refused.length, name).toBe(46)
      expect(
        refused.every(r => !('handler' in r)),
        name,
      ).toBe(true)
    }
  })

  it('reports an out-of-range id as unreadable, not as direct', () => {
    const rom = freshRom()
    expect(resolveDispatch(rom, SPRITE_PTR_TABLE_COUNT).kind).toBe('unreadable')
    expect(resolveDispatch(rom, -1).kind).toBe('unreadable')
  })
})

// ── Bounds ──────────────────────────────────────────────────────────────────

describe('a chain that never ends terminates anyway', () => {
  /** A cart exposing only `readAt`, which is all the reader uses. */
  function fakeRom(bytes: Record<number, number[]>): RomFile {
    return {
      readAt(addr: number, len: number) {
        for (const [baseStr, data] of Object.entries(bytes)) {
          const base = Number(baseStr)
          if (addr >= base && addr + len <= base + data.length) {
            return Buffer.from(data.slice(addr - base, addr - base + len))
          }
        }
        return null
      },
    } as unknown as RomFile
  }

  it('stops at the link ceiling instead of walking off the bank', () => {
    const at = 0x038000
    const link = [0xc9, 0x00, 0xd0, 0x05, 0x20, 0x00, 0x90, 0xab, 0x6b]
    const body = [0x8b, 0x4b, 0xab, 0xb5, 0x9e]
    for (let i = 0; i < MAX_CHAIN_LINKS + 10; i++) body.push(...link)
    const c = readDispatchChain(fakeRom({ [at]: body }), at)
    expect(c.kind).toBe('refused')
    if (c.kind === 'refused') {
      expect(c.refusal.linkIndex).toBe(MAX_CHAIN_LINKS)
      expect(c.refusal.expected).toContain(`within ${MAX_CHAIN_LINKS} links`)
    }
  })

  it('refuses a chain that runs off the end of readable memory', () => {
    const at = 0x038000
    // A prologue and one truncated link: the `JSR` operand is missing.
    const c = readDispatchChain(
      fakeRom({ [at]: [0x8b, 0x4b, 0xab, 0xb5, 0x9e, 0xc9, 0xab, 0xd0, 0x05, 0x20] }),
      at,
    )
    expect(c.kind).toBe('refused')
    if (c.kind === 'refused') expect(c.refusal.found).toBe(null)
  })
})

// ── Messages ────────────────────────────────────────────────────────────────

describe.skipIf(!romsPresent)('a refusal can be read by whoever has to fix it', () => {
  it('names the routine a dispatched sprite reaches', () => {
    expect(dispatchMessage(resolveDispatch(freshRom(), REX))).toContain('$039517')
  })

  it('says an unmatched id fell through, and where to', () => {
    const m = dispatchMessage(resolveDispatch(freshRom(), FALLTHROUGH_ID))
    expect(m).toContain('falls through to')
    expect(m).toContain('$03A259')
  })

  it('quotes the byte that stopped a refused chain', () => {
    // Without the byte and the address a refusal is unactionable, which is
    // how a silent mis-map gets shipped as "the reader said no".
    const m = dispatchMessage(resolveDispatch(freshRom(), 0x91))
    expect(m).toContain('LDA dp,X')
    expect(m).toContain('$BD')
  })

  it('reports a sprite whose pointer is a real handler as just that', () => {
    expect(dispatchMessage(resolveDispatch(freshRom(), DIRECT))).toMatch(/^handler \$0/)
  })

  it('survives an unreadable id without throwing', () => {
    expect(dispatchMessage(resolveDispatch(freshRom(), 999))).toContain('unreadable')
  })
})
