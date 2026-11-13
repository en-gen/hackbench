/**
 * The call-path gate (ClusterPath.ts) on the synthetic stand-in path, no ROM: what it must flag, what it must
 * not, and the mutants a run-to-the-target gate would let through (adversarial review of #1061). The cart
 * is the synthetic sprite cart plus the stand-in of test/suite/support/clusterPathStandIn.ts and one-RTS
 * stand-ins for the spawns and draws, which the gate only reaches or runs to their return.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { ringGate, VANILLA_RING_ROUTINES } from '../../../../src/rom/sprites/interp/RotatingRing'
import { clusterPath, pathMismatches } from '../../../../src/rom/sprites/interp/ClusterPath'
import { hi, lo } from '../../support/syntheticCart'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'
import {
  clusterPathStandIn,
  COUNT_DOWN,
  LOOP,
  PATH_HACKS,
  ROUTE,
  SPAWN_STUB,
  STANDIN,
  STANDIN_LAYOUT,
  tableWord,
  type StandInOptions,
} from '../../support/clusterPathStandIn'

const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)
const RTS = [0x60]

const FLAMES = clusterPath({
  ids: [0xe6],
  spawn: STANDIN.flameSpawn,
  spawnLength: 5,
  type: 5,
  draw: STANDIN.flameDraw,
  dispatchWhat: 'the $E6 branch to the flame spawn',
  layout: STANDIN_LAYOUT,
})
const RING = clusterPath({
  ids: [0xe2, 0xe3],
  spawn: STANDIN.ringSpawn,
  spawnLength: 5,
  type: 4,
  draw: STANDIN.ringDraw,
  dispatchWhat: 'the $E2/$E3 branch to the ring spawn',
  layout: STANDIN_LAYOUT,
})

function cart(edit: (b: Uint8Array) => void = () => {}, o: StandInOptions = {}): RomFile {
  const b = new Uint8Array(buildSyntheticRom().buffer)
  const put = (at: number, v: number[]) => b.set(v, off(at))
  put(STANDIN.flameSpawn, SPAWN_STUB)
  put(STANDIN.ringSpawn, SPAWN_STUB)
  put(STANDIN.flameDraw, RTS)
  put(STANDIN.ringDraw, RTS)
  for (const [at, v] of clusterPathStandIn(o)) put(at, v)
  edit(b)
  return RomFile.fromBytes('path.sfc', b)
}
const names = (xs: string[]) => xs.map(x => x.replace(/ \(.*\)$/, ''))
const edit = (...es: [number, number[]][]) => cart(b => es.forEach(([at, v]) => b.set(v, off(at))))
const hack = (name: string, flame: boolean) =>
  edit(...PATH_HACKS.find(x => x.name === name)!.edits(flame))

describe('the call-path gate on the stand-in path', () => {
  // The loop reaches slot 19 after about 140 steps: a step budget of 40 would flag this clean path.
  it('accepts the clean path for the flames and the ring', () => {
    expect(pathMismatches(cart(), FLAMES)).toEqual([])
    expect(pathMismatches(cart(), RING)).toEqual([])
  })

  it('flags a route that leaves out $E3 alone (a gate that only ran the first id would pass it)', () => {
    const rom = hack('route stub excludes the last id', false)
    expect(names(pathMismatches(rom, RING))).toEqual([ROUTE])
    expect(pathMismatches(rom, { ...RING, ids: RING.ids.slice(0, 1) })).toEqual([])
  })

  it('flags a route that depends on game state (the all-zero WRAM would pass it)', () => {
    const rom = hack('route stub depends on the level number', true)
    expect(names(pathMismatches(rom, FLAMES))).toEqual([ROUTE])
  })

  it('a spinning route ends at the step budget and is flagged, not hung', () => {
    const rom = hack('route spins', true)
    const r = pathMismatches(rom, FLAMES)
    expect(names(r)).toEqual([ROUTE])
    expect(r[0]).toMatch(/did not reach \$02A846 in 3000 steps/)
  })

  it('a dispatch through the FastROM mirror of the bank is the same code (a verdict keyed on the raw address would flag it)', () => {
    // The loop calls the block by a long call through $82; the block and the draw are reached at $82:xxxx.
    const rom = cart(() => {}, { fastRom: true })
    const layout = { ...STANDIN_LAYOUT, longCall: true }
    expect(pathMismatches(rom, { ...FLAMES, layout })).toEqual([])
  })

  it('a HiROM-flagged cart is refused: every stage is named, nothing throws', () => {
    const rom = cart(b => (b[0x7fd5] = 0x21))
    expect(names(pathMismatches(rom, RING))).toEqual([ROUTE, RING.dispatchWhat, LOOP])
  })

  it('a failure that is not a refusal is rethrown, never turned into a verdict', () => {
    expect(() => pathMismatches(null as never, FLAMES)).toThrow(TypeError)
  })

  it('the verdict handed out is a copy: appending to it cannot change the next answer', () => {
    const rom = hack('loop skips slot 0', true)
    const first = pathMismatches(rom, FLAMES)
    expect(first.length).toBeGreaterThan(0)
    first.push('junk')
    expect(pathMismatches(rom, FLAMES)).not.toContain('junk')
  })

  it('the verdict does not depend on what an earlier run left in WRAM', () => {
    const clean = cart()
    const bad = hack('activate flag store removed', true)
    const a = [
      pathMismatches(clean, FLAMES),
      pathMismatches(bad, FLAMES),
      pathMismatches(clean, RING),
    ]
    const b = [
      pathMismatches(cart(), RING),
      pathMismatches(hack('activate flag store removed', true), FLAMES),
    ]
    expect(a[0]).toEqual([])
    expect(names(a[1]!)).toEqual([FLAMES.dispatchWhat])
    expect(b[0]).toEqual([])
    expect(names(b[1]!)).toEqual([FLAMES.dispatchWhat])
  })

  it('a table word moved to a wrapper is flagged by its address', () => {
    const r = pathMismatches(
      hack('dispatch words reach a wrapper that writes a cell', true),
      FLAMES,
    )
    expect(r).toEqual([expect.stringMatching(/^the cluster loop \(runs code at \$02F980\)$/)])
  })

  it('the table words sit at the stand-in dispatch block, not at the game address', () => {
    expect(tableWord(5)).toBe(STANDIN.dispatch + 14)
    expect(STANDIN.dispatch).not.toBe(0x02f821)
  })
})

describe('what the gate must accept and where its limits sit', () => {
  const LP = STANDIN.loop

  it('a loop that counts down from slot 19 is accepted as well as one that counts up', () => {
    const rom = edit([LP + 6, [0x13]], [LP + 12, COUNT_DOWN])
    expect(pathMismatches(rom, FLAMES)).toEqual([])
  })

  it('a spawn that needs a free cluster slot is accepted: the route run clears the table first', () => {
    // LDA table / BEQ over / BRA here (spins when the table is not empty) / LDX #0 / LDY #0 / RTS
    const spawn = [0xad, 0x92, 0x18, 0xf0, 0x02, 0x80, 0xfe, 0xa2, 0x00, 0xa0, 0x00, 0x60]
    const rom = edit([STANDIN.ringSpawn, spawn])
    expect(pathMismatches(rom, { ...RING, spawnLength: spawn.length })).toEqual([])
  })

  it('a spawn that runs on past its length is flagged under the spawn, not the route', () => {
    // The stub's own span is 5 bytes: a jump to a copy 16 bytes on leaves it, though it stays near.
    const at = STANDIN.flameSpawn
    const rom = edit([at, [0x4c, lo(at + 16), hi(at + 16)]], [at + 16, SPAWN_STUB])
    expect(pathMismatches(rom, FLAMES)).toEqual([
      expect.stringMatching(/^the \$E6 branch.*runs code at/),
    ])
  })

  it('a span ends before its last address: a fetch at the end is foreign', () => {
    const tight = { ...STANDIN_LAYOUT, loop: [LP, LP + 25] as const }
    expect(names(pathMismatches(cart(), { ...FLAMES, layout: tight }))).toEqual([LOOP])
  })

  it('a conditional branch whose fall-through leaves the span is flagged though no run falls through', () => {
    // BVC for the loop's closing BRA: V is never set, so it always branches. The span ends at the fall-through.
    const tight = { ...STANDIN_LAYOUT, loop: [LP, LP + 27] as const }
    expect(pathMismatches(cart(), { ...FLAMES, layout: tight })).toEqual([])
    const r = pathMismatches(edit([LP + 25, [0x50, 0xf1]]), { ...FLAMES, layout: tight })
    expect(r).toEqual([expect.stringMatching(/falls through to/)])
  })
})

describe('the layout allowances and the checks on stack, spawn and cache', () => {
  const LP = STANDIN.loop

  it('a branch to an address listed in exits is accepted, by its FastROM mirror too; unlisted it is flagged', () => {
    const rom = edit([STANDIN.route, [0xc0, 0x55, 0xf0, 0x7e]])
    expect(names(pathMismatches(rom, FLAMES))).toEqual([ROUTE])
    for (const exits of [[0x02f8e2], [0x82f8e2]])
      expect(pathMismatches(rom, { ...FLAMES, layout: { ...STANDIN_LAYOUT, exits } })).toEqual([])
  })

  it('a loop that returns with a byte left on the stack is flagged for the stack alone', () => {
    // BRA to an island inside a widened loop span: PLB, push a copy of the return frame and a spare byte, RTL.
    const layout = { ...STANDIN_LAYOUT, loop: [LP, LP + 0x30] as const }
    const island = [0xab, 0xf4, 0, 0, 0xf4, 0xff, 0x7e, 0x6b]
    const rom = edit([LP + 17, [0x80, 0x0d]], [LP + 0x20, island])
    expect(pathMismatches(rom, { ...FLAMES, layout })).toEqual([
      'the cluster loop (the stack is not restored)',
    ])
  })

  it('a spawn with a conditional branch out of its own span is accepted: its branches are its own', () => {
    // LDX #0 / LDY #0 / BNE away (Z is set, so never taken) / RTS
    const spawn = [0xa2, 0x00, 0xa0, 0x00, 0xd0, 0x10, 0x60]
    const rom = edit([STANDIN.ringSpawn, spawn])
    expect(pathMismatches(rom, { ...RING, spawnLength: spawn.length })).toEqual([])
  })

  it('a cached verdict handed out twice is still unchanged by the second caller', () => {
    const rom = hack('loop skips slot 0', true)
    pathMismatches(rom, FLAMES)
    pathMismatches(rom, FLAMES).push('junk')
    expect(pathMismatches(rom, FLAMES)).not.toContain('junk')
  })
})

describe('each hacked path, for both carts', () => {
  it.each(PATH_HACKS.flatMap(h => [[h.name, h, true] as const, [h.name, h, false] as const]))(
    '%s (flames: %s)',
    (_, h, flame) => {
      const p = flame ? FLAMES : RING
      const got = pathMismatches(edit(...h.edits(flame)), p)
      expect(names(got)).toEqual([{ route: ROUTE, dispatch: p.dispatchWhat, loop: LOOP }[h.stage]])
      expect(got[0]).toMatch(h.why)
    },
  )
})

describe('every byte of the stand-in path', () => {
  // Flip each byte of each written region (the stand-in code and the table words): the verdict either holds or
  // names a stage. The bytes whose change cannot matter (an operand the run never reads) are listed, so a new
  // always-clean byte, or a stage that stops catching one, fails here.
  const regions = clusterPathStandIn().map(([at, v]) => [at, v.length] as const)
  const flagged: string[] = []
  const quiet: string[] = []
  for (const [at, n] of regions) {
    for (let i = 0; i < n; i++) {
      const rom = cart(b => (b[off(at + i)]! ^= 0x40))
      const r = [...pathMismatches(rom, FLAMES), ...pathMismatches(rom, RING)]
      ;(r.length ? flagged : quiet).push((at + i).toString(16))
    }
  }

  it('each byte is caught by a stage, but the operands the run never reads', () => {
    expect(flagged.length).toBeGreaterThan(quiet.length * 4)
    expect(quiet.join(' ')).toBe(QUIET)
  })
})

// Bytes whose flip (xor $40) leaves both paths clean, one machine, the stand-in as committed. Each is an
// equivalent change or code the gate never reaches: the NOP after the route's PHX (flipped to TAX, which the
// PLX undoes), the BNE after the compare for $04 (as BCC it is not taken for $E2/$E6 either), the entry's
// final PLA/RTS (reached only for an id the cart does not name), the loop's BCC (BNE acts the same on the
// counter's last step) and the dispatch JSL's bank byte (a mirror of the same bank).
const QUIET = '2f8a1 2aad5 2aadb 2aadc 2f817 2f903'

// The call target is read only behind a JSL: any other opcode at the dispatch site has no operand to admit.
describe('the dispatch call target needs a JSL at the site', () => {
  const gate = (rom: RomFile) =>
    ringGate(rom, { ...VANILLA_RING_ROUTINES, layout: STANDIN_LAYOUT }).filter(x =>
      x.includes('call target'),
    )
  it('names no target problem when the site is a JSL', () => expect(gate(cart())).toEqual([]))
  // JSR, JMP, JML, NOP, BRK, LDA #, RTL: none is a call through an operand.
  it.each([0x20, 0x4c, 0x5c, 0xea, 0x00, 0xa9, 0x6b])('opcode $%s at the site is reported', op => {
    const rom = cart(b => (b[off(STANDIN.dispatch)] = op))
    expect(gate(rom)).toEqual(['the cluster dispatch call target'])
  })
})
