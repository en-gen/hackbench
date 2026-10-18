/**
 * The five-Eerie command (#1015): the ROM's own spawner run on the core, each Eerie drawn by the sprite runner.
 * Synthetic cart (syntheticEeries.ts): its spawner, tables and sprite $39 are written for this fixture to the game's
 * I/O contract, so what is asserted is that the count, the X spread, the Y and the linked slot come from the cart's
 * code and data, and that every gate, refusal and shortfall is told. The vanilla ROM is in FiveEeries.corpus.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  eeriesGate,
  EERIES_ROUTE as ROUTE,
  fiveEeries,
  spawnerEntry,
  type EeriesEntry,
} from '../../../../src/rom/sprites/interp/FiveEeries'
import { bytesAt } from '../../../../src/rom/sprites/interp/Guards'
import {
  runOnce,
  SPAWN_SHORT,
  type SpriteModel,
} from '../../../../src/rom/sprites/interp/SpriteRunner'
import type { SpriteSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { flip } from '../../support/syntheticRom'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'
import {
  COUNT_IMMEDIATE_AT,
  DISTANCE_INY_AT,
  eeriesSeed,
  ROUTE_AT,
  SPAWNER_AT,
  SYNTHETIC_EERIES_ROUTINES as SYN,
  SYNTHETIC_OFFSETS as OFFSETS,
  SYNTHETIC_SPEEDS,
  TABLES_AT,
} from '../../support/syntheticEeries'

type Run = (rom: never, id: number, s: SpriteSeed, o?: Parameters<typeof runOnce>[3]) => SpriteModel

const seed = (marioX = 100) => eeriesSeed(marioX, { camera: { x: 700, y: 224 }, mario: { x: marioX, y: 0 } }) // prettier-ignore
/** The list entry of the fixture's stream: X 832, list index 9, data byte $71 (Y $170 = 368). */
const entry: EeriesEntry = { x: 832, y: 368, index: 9, streamOffset: 0 }
const cart = (e: Parameters<typeof buildSyntheticRom>[0] = { eeries: {} }) => buildSyntheticRom(e)
const JSR_AT = ROUTE_AT + 9
/** The offsets in spawn order: the spawner's loop runs from the table's last entry to its first. */
const SPAWN_ORDER = [...OFFSETS].reverse()

describe('the five Eeries', () => {
  it('spawns five, at the entry X plus the cart table, Y from the data byte', () => {
    const r = fiveEeries(cart(), seed(), entry, SYN)
    if (!r.ok) throw new Error(r.reason)
    expect(r.eeries.map(e => e.x)).toEqual(SPAWN_ORDER.map(o => 832 + o))
    expect(r.eeries.map(e => e.y)).toEqual([368, 368, 368, 368, 368])
    expect(r.unverified).toEqual([])
    expect(r.notes).toEqual([])
    expect(r.spawned).toBe(5)
    expect(r.parts).toHaveLength(5) // one 16 x 16 piece each
  })

  it('fits the 97 bytes the gate hashes', () => {
    const rom = cart()
    expect(bytesAt(rom, SPAWNER_AT + 92, 1)![0]).toBe(0x60) // its RTS is the last byte of the routine
    expect(bytesAt(rom, SPAWNER_AT + 93, 4)).toEqual([0, 0, 0, 0]) // and the rest of the hashed span is empty
  })

  it('follows its inputs: the entry X, the data byte and the table', () => {
    const rom = cart({
      eeries: { spacing: [-0x40, -0x20, 0x20, 0x40], stream: [0xa1, 0x43, 0xde, 0xff] },
    })
    const r = fiveEeries(rom, seed(), { ...entry, x: 560 }, SYN)
    if (!r.ok) throw new Error(r.reason)
    expect(r.eeries.map(e => e.x)).toEqual([560 + 0x40, 560 + 0x20, 560, 560 - 0x20, 560 - 0x40])
    expect(new Set(r.eeries.map(e => e.y))).toEqual(new Set([0x1a0]))
  })

  it('links only the first spawn to the list index, and that one is the rightmost, nth 0', () => {
    const linked: number[] = []
    const run: Run = (rom, id, s, o) =>
      runOnce(rom, id, s, {
        ...o,
        probe: (pass, w) => {
          if (pass !== -1) return
          const slot = Array.from({ length: 12 }, (_, i) => i).find(i => w[0x14c8 + i])!
          linked.push(w[0x161a + slot]!)
        },
      })
    const r = fiveEeries(cart(), seed(), entry, SYN, 1, run)
    // nth 0 is the first spawn (the spawner fills the highest slot first), the far end of the table.
    expect(linked).toEqual([9, 0, 0, 0, 0])
    expect(r.ok && r.eeries[0]!.x).toBe(832 + OFFSETS[4]!)
  })

  it('faces Mario: each piece shows the cart speed picked by his side', () => {
    const tiles = (marioX: number) => {
      const r = fiveEeries(cart(), seed(marioX), entry, SYN)
      return r.ok ? new Set(r.parts.map(p => p.char)) : new Set<number>()
    }
    expect(tiles(100)).toEqual(new Set([SYNTHETIC_SPEEDS.marioLeft]))
    expect(tiles(2000)).toEqual(new Set([SYNTHETIC_SPEEDS.marioRight]))
  })

  it('a planted wrong count shows: a spawner that loops four times draws four and says so', () => {
    const rom = cart()
    rom.writeAt(COUNT_IMMEDIATE_AT, [0x03]) // the loop counter's immediate, 4 -> 3
    const r = fiveEeries(rom, seed(), entry, SYN)
    if (!r.ok) throw new Error(r.reason)
    expect(r.eeries).toHaveLength(4)
    expect(r.unverified).toContain('the Eerie spawner')
  })

  it('a planted wrong spacing shows: a moved table entry moves its Eerie', () => {
    const bad = cart()
    bad.writeAt(TABLES_AT + 3, [0x30]) // the fourth X offset moves out
    const r = fiveEeries(bad, seed(), entry, SYN)
    expect(r.ok && r.eeries.map(e => e.x)).toContain(832 + 0x30)
    expect(r.ok && r.eeries.map(e => e.x)).not.toContain(832 + OFFSETS[3]!)
  })

  it('draws what it can when fewer than five spawn, and says so', () => {
    const run: Run = (rom, id, s, o) =>
      (o?.spawn?.nth ?? 0) >= 3
        ? { id, passes: [], dependsOn: [], steps: [], refusal: `${SPAWN_SHORT}3 sprites, not ${o!.spawn!.nth! + 1}` } // prettier-ignore
        : runOnce(rom, id, s, o)
    const r = fiveEeries(cart(), seed(), entry, SYN, 1, run)
    if (!r.ok) throw new Error(r.reason)
    expect(r.eeries).toHaveLength(3)
    expect(r.spawned).toBe(3)
  })

  it('refuses with the reason when the spawner never returns', () => {
    const rom = cart()
    rom.writeAt(SPAWNER_AT, [0x4c, SPAWNER_AT & 0xff, (SPAWNER_AT >> 8) & 0xff]) // a jump to itself
    const r = fiveEeries(rom, seed(), entry, SYN)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/step budget/)
  })
})

describe('the spawn frame (D137): no travel', () => {
  /** The Eeries' positions and parts, rounded to what the editor draws. */
  const shape = (r: ReturnType<typeof fiveEeries>) => {
    if (!r.ok) throw new Error(r.reason)
    return { at: r.eeries.map(e => [e.x, e.y]), parts: r.parts.map(p => [p.dx, p.dy, p.char]) }
  }
  const atRest = () => shape(fiveEeries(cart({ eeries: {} }), seed(), entry, SYN))
  const travelling = (run?: Run) => shape(fiveEeries(cart({ eeries: { travel: true } }), seed(), entry, SYN, 1, run)) // prettier-ignore

  it('the fixture Eerie really moves: its drawn pass is not at its spawn spot (so the checks below can fail)', () => {
    const m = runOnce(cart({ eeries: { travel: true } }), 0x39, seed(), { spawn: { inputs: { 0: 832 & 0xff, 1: 832 >> 8, 2: 9, 3: 0 }, routine: spawnerEntry(cart())!, nth: 2 } }) // prettier-ignore
    expect(m.spawnPos).toEqual({ x: 832, y: 368 })
    expect(m.passes[0]!.pos).not.toEqual(m.spawnPos)
  })

  it('runs no MAIN before pass 0: a status-8 spawn has no INIT frame, so the anchor is the spawn spot', () => {
    const m = runOnce(cart({ eeries: { travel: true } }), 0x39, seed(), { spawn: { inputs: { 0: 832 & 0xff, 1: 832 >> 8, 2: 9, 3: 0 }, routine: spawnerEntry(cart())!, nth: 0 } }) // prettier-ignore
    expect(m.initFrames).toBe(0)
    expect(m.anchor).toMatchObject(m.spawnPos!)
  })

  it('draws each Eerie at the spawn offsets from the entry, as the same fixture that does not move', () => {
    const s = travelling()
    expect(s.at).toEqual(SPAWN_ORDER.map(o => [832 + o, 368]))
    expect(s).toEqual(atRest())
  })

  it('goes red on a planted travel frame: positions taken from the drawn pass differ', () => {
    const planted: Run = (rom, id, s, o) => {
      const m = runOnce(rom, id, s, o)
      return { ...m, spawnPos: m.passes[m.chosen ?? 0]?.pos }
    }
    expect(travelling(planted)).not.toEqual(atRest())
    expect(travelling(planted).at).not.toEqual(SPAWN_ORDER.map(o => [832 + o, 368]))
  })
})

describe('the spawner the loader calls', () => {
  /** A copy of the cart's spawner at $02:B100 (counting 3 instead of 4: four Eeries), and the loader's JSR pointed at it. */
  function repointed() {
    const rom = cart()
    const code = bytesAt(rom, SPAWNER_AT, 97)!
    code[COUNT_IMMEDIATE_AT - SPAWNER_AT] = 0x03
    rom.writeAt(0x02b100, code)
    rom.writeAt(JSR_AT + 1, [0x00, 0xb1])
    return rom
  }

  it('is the JSR operand the loader holds: a repointed one runs the spawner it names, and says so', () => {
    const r = fiveEeries(repointed(), seed(), entry, SYN)
    if (!r.ok) throw new Error(r.reason)
    expect(r.eeries).toHaveLength(4) // the copy counts 3
    expect(r.unverified).toEqual(['the Eerie spawner']) // the route is intact: only the spawner differs
    expect(spawnerEntry(repointed())).toBe(0x02b100)
  })

  it('has no spawner to name when the byte at the call is not a JSR', () => {
    const rom = cart()
    rom.writeAt(JSR_AT, [0x4c])
    expect(spawnerEntry(rom)).toBeNull()
  })
})

describe('the loader route (checked by structure, before the JSR is read)', () => {
  /** The route instructions the check reads, by offset from $02:A88C: CMP, the id, BNE, PHY, PHX, DEY, STY, its operand, JSR. */
  const SHAPE = { cmp: 0, id: 1, bne: 2, phy: 4, phx: 5, dey: 6, sty: 7, dp: 8, jsr: 9 }
  const refusal = (rom: ReturnType<typeof cart>) => {
    const ran: unknown[] = []
    const run: Run = (r, id, s, o) => (ran.push(o), runOnce(r, id, s, o))
    const r = fiveEeries(rom, seed(), entry, SYN, 1, run)
    return { r, ran }
  }

  it.each(Object.entries(SHAPE))('a changed %s byte refuses and runs nothing', (_name, off) => {
    const rom = cart()
    flip(rom, ROUTE_AT + off)
    const { r, ran } = refusal(rom)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe(`${ROUTE} is not the shape this reader knows, so the Eerie spawner cannot be found`) // prettier-ignore
    expect(!r.ok && r.unverified).toContain(ROUTE)
    expect(ran, 'no spawner was run').toEqual([])
  })

  it('a BRA planted at the PHY / PHX that jumps over the call refuses: the JSR bytes are still there', () => {
    const rom = cart()
    rom.writeAt(ROUTE_AT + 4, [0x80, 0x06]) // BRA +6: past the JSR the old reader still found at +9
    const { r, ran } = refusal(rom)
    expect(r.ok).toBe(false)
    expect(ran).toEqual([])
  })

  it('a $20 that is an operand, not a JSR, at the call refuses: LDA #$20 and SEP #$20 in place of the DEY and STY', () => {
    for (const op of [0xa9, 0xe2]) {
      const rom = cart()
      rom.writeAt(ROUTE_AT + 6, [op, 0x20, 0x20]) // an immediate-$20 instruction, then the byte the call read
      expect(bytesAt(rom, JSR_AT, 1)![0]).toBe(0x20) // the old reader would take this for a JSR
      const { r, ran } = refusal(rom)
      expect(r.ok, `opcode ${op}`).toBe(false)
      expect(ran).toEqual([])
    }
  })

  it('a route that differs only where the check does not look (the branch offset, the bytes after the call) still runs, unflagged', () => {
    const rom = cart()
    flip(rom, ROUTE_AT + 3)
    flip(rom, ROUTE_AT + 12)
    const r = fiveEeries(rom, seed(), entry, SYN)
    expect(r.ok && r.unverified).toEqual([])
  })
})

describe('the gate', () => {
  it('is quiet for the cart it was fingerprinted on', () => {
    expect(eeriesGate(cart(), SYN)).toEqual([])
  })

  it('names the spawner for a change to any of its 97 bytes', () => {
    for (let i = 0; i < 97; i++) {
      const rom = cart()
      flip(rom, SPAWNER_AT + i)
      expect(eeriesGate(rom, SYN), `byte ${i}`).toContain('the Eerie spawner')
    }
  })

  it('names the loader route for a change to a byte it reads, and not the tables', () => {
    const route = cart()
    flip(route, ROUTE_AT + 6)
    expect(eeriesGate(route, SYN)).toEqual([ROUTE])
    const table = cart()
    flip(table, TABLES_AT)
    expect(eeriesGate(table, SYN)).toEqual([])
  })

  it('does not check the distance routine on its own: the spawner run executes it, so a changed one is drawn as the cart makes it, unflagged', () => {
    const rom = cart()
    // The distance routine without its increment: every Eerie reads Mario as to the right of it.
    rom.writeAt(DISTANCE_INY_AT, [0xea])
    expect(eeriesGate(rom, SYN)).toEqual([])
    const r = fiveEeries(rom, seed(), entry, SYN)
    if (!r.ok) throw new Error(r.reason)
    expect(r.unverified).toEqual([])
    expect(r.eeries).toHaveLength(5)
    expect(new Set(r.parts.map(p => p.char))).toEqual(new Set([SYNTHETIC_SPEEDS.marioRight]))
  })
})
