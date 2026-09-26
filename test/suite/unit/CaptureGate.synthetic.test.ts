/**
 * Synthetic tests for the L1 (foreground) data gate's table checks
 * (tools/scripts/capture_gate.ts, en-gen/hackbench#421). Each check is a
 * pure function over plain arrays/bytes, so these need no ROM and no
 * capture on disk - the corpus-backed suite (CaptureGate.corpus.test.ts)
 * exercises the real thing.
 *
 * Byte layouts here are hand-rolled, not built through capture_decode's own
 * decoders, so a bug in that module cannot also shape what a test expects.
 * `loadLevel` refusals (missing capture, unrecognized tileId/vertical
 * rules) are covered by CaptureRender.synthetic.test.ts; the
 * encode/decode round trip is covered by Map16.subtileWord.test.ts - not
 * duplicated here.
 */
import { describe, it, expect } from 'vitest'
import {
  ALLOWED_PIPE_BUG_S0_ALT,
  ALLOWED_PIPE_BUG_S0_OTHER,
  ALLOWED_PIPE_BUG_VERTICAL,
  checkChars,
  checkDefs,
  checkGrid,
  checkPalette,
  checkPipes,
  citedWords,
  hex,
  parsePipeWrites,
  quadWords,
  usedByStrip,
  type PipeWrites,
} from '../../../tools/scripts/capture_gate'
import { pipeVariantIndex, type Map16Tile } from '../../../src/rom/Map16'
import type { AnimationData } from '../../../src/rom/AnimationLoader'
import type { VramState } from '../../../src/rom/GfxLoader'
import type { GridMeta } from '../../../tools/scripts/capture_decode'

const SUB = (charNum: number, priority = false) => ({ charNum, palette: 0, priority, flipX: false, flipY: false }) // prettier-ignore
const tile = (id: number, tl = 0, tr = 0, bl = 0, br = 0): Map16Tile => ({ id, tl: SUB(tl), tr: SUB(tr), bl: SUB(bl), br: SUB(br) }) // prettier-ignore
const PIPE_LO = 0x133
const PIPE_HI = 0x13a

// One screen, one row: 16 columns, base 0, low plane at 0, high plane right after it.
const META: GridMeta = { orientation: 'horizontal', screens: 1, bytesPerScreen: 16, lowOffset: 0, highOffset: 16, base: 0 } // prettier-ignore
const ORDER = [0, 1, 2, 3] // TL,TR,BL,BR stored in that order

/** A capture grid of `screens` horizontal screens (16 cols each), 1 row: every id is `fill`, `overrides[col]` applied. */ // prettier-ignore
function gridRow(fill: number, screens = 1, overrides: Record<number, number> = {}): Uint8Array {
  const cols = screens * 16
  const g = new Uint8Array(cols * 2)
  for (let c = 0; c < cols; c++) {
    const id = overrides[c] ?? fill
    g[c] = id & 0xff
    g[cols + c] = (id >> 8) & 1
  }
  return g
}
const romRow = (fill: number, screens = 1, overrides: Record<number, number> = {}): number[] =>
  Array.from({ length: screens * 16 }, (_, c) => overrides[c] ?? fill)

describe('checkGrid', () => {
  it('passes when the ROM grid and the capture grid agree', () => {
    const { mismatches, overflow } = checkGrid([romRow(0x25)], gridRow(0x25), META, 16, false)
    expect(mismatches).toEqual([])
    expect(overflow).toEqual([])
  })

  it('reports a wrong id by cell', () => {
    const { mismatches } = checkGrid([romRow(0x25, 1, { 3: 0x99 })], gridRow(0x25), META, 16, false)
    expect(mismatches).toEqual([{ table: 'grid', cell: '3,0', expected: hex(0x25), actual: hex(0x99) }]) // prettier-ignore
  })

  it('reports a dimension mismatch (wrong row count) before any cell', () => {
    const { mismatches } = checkGrid([romRow(0x25), romRow(0x25)], gridRow(0x25), META, 16, false)
    expect(mismatches).toEqual([{ table: 'grid', cell: 'dimensions', expected: '16x1', actual: '16x2' }]) // prettier-ignore
  })

  it("reports a dimension mismatch when the capture's own screen axis disagrees with extent, never silently truncating", () => {
    // prettier-ignore
    // The capture states 2 screens (32 cols); the ROM's own header/boss-arena
    // extent says 1 (16). Both must be surfaced, not silently clipped to 16.
    const { mismatches } = checkGrid([romRow(0x25, 2)], gridRow(0x25, 2), { ...META, screens: 2 }, 16, false) // prettier-ignore
    expect(mismatches).toContainEqual({ table: 'grid', cell: 'dimensions', expected: 'cols=16', actual: 'cols=32' }) // prettier-ignore
  })

  it('reports a dimension mismatch when a ROM row is shorter than the compared width, never silently under-comparing', () => {
    // prettier-ignore
    const rom = [romRow(0x25).slice(0, 10)] // 10 cols instead of 16
    const { mismatches } = checkGrid(rom, gridRow(0x25), META, 16, false)
    expect(mismatches).toContainEqual({ table: 'grid', cell: 'dimensions', expected: 'row 0: 16 cols', actual: 'row 0: 10 cols' }) // prettier-ignore
  })

  it("a genuine mismatch inside the shorter row's own bound is still reported alongside the length mismatch", () => {
    // prettier-ignore
    const rom = [romRow(0x25, 1, { 2: 0x99 }).slice(0, 10)]
    const { mismatches } = checkGrid(rom, gridRow(0x25), META, 16, false)
    expect(mismatches).toContainEqual({ table: 'grid', cell: '2,0', expected: hex(0x25), actual: hex(0x99) }) // prettier-ignore
  })

  it('a write past the level end is an informational overflow note, never a mismatch (the width rule)', () => {
    const rom = [[...romRow(0x25), 0x99]] // 17 cols: col 16 is a handler bleeding past a 1-screen level
    const { mismatches, overflow } = checkGrid(rom, gridRow(0x25), META, 16, false)
    expect(mismatches).toEqual([])
    expect(overflow).toEqual(["row 0 writes col 16..16 past the level's own end"])
  })

  it('a genuine mismatch inside the level end is still reported even with an overflow write past it', () => {
    const rom = [[...romRow(0x25, 1, { 2: 0x99 }), 0x30]]
    const { mismatches, overflow } = checkGrid(rom, gridRow(0x25), META, 16, false)
    expect(mismatches).toEqual([
      { table: 'grid', cell: '2,0', expected: hex(0x25), actual: hex(0x99) },
    ])
    expect(overflow).toHaveLength(1)
  })

  it('vertical: reports a dimension mismatch when the capture has more screens than the ROM extent, rather than silently comparing only the first', () => {
    // prettier-ignore
    // A silent-truncation bug would happily compare only rows 0-15 and pass;
    // the capture's own 2-screen extent disagreeing with the ROM's 1-screen
    // extent is itself real information and must surface.
    const vmeta: GridMeta = { orientation: 'vertical', screens: 2, bytesPerScreen: 0x200, lowOffset: 0, highOffset: 32 * 32, base: 0 } // prettier-ignore
    const capGrid = new Uint8Array(32 * 32 * 2)
    const romGrid = Array.from({ length: 32 }, (_, r) => new Array(32).fill(r < 16 ? 0 : 0x99))
    const { mismatches } = checkGrid(romGrid, capGrid, vmeta, 16, true)
    expect(mismatches).toContainEqual({ table: 'grid', cell: 'dimensions', expected: 'rows=16', actual: 'rows=32' }) // prettier-ignore
  })

  it('vertical: bounds the row axis to the ROM extent when the capture agrees with it', () => {
    // Capture and extent agree (1 screen, 16 rows); rows past that in the
    // physical array (a boss-arena override never applies here) still must
    // not be compared even though the array happens to be 32 rows long.
    const vmeta: GridMeta = { orientation: 'vertical', screens: 1, bytesPerScreen: 0x200, lowOffset: 0, highOffset: 32 * 16, base: 0 } // prettier-ignore
    const capGrid = new Uint8Array(32 * 16 * 2)
    const romGrid = Array.from({ length: 16 }, () => new Array(32).fill(0))
    const { mismatches } = checkGrid(romGrid, capGrid, vmeta, 16, true)
    expect(mismatches).toEqual([])
  })

  it('handles a 2-screen grid with ids at and above $100 via the high-plane bit', () => {
    const rom = [romRow(0x25, 2, { 20: 0x100, 21: 0x1ff })]
    const cap = gridRow(0x25, 2, { 20: 0x100, 21: 0x1ff }) // 32 cols: low plane [0,32), high plane [32,64)
    const meta2: GridMeta = { ...META, screens: 2, highOffset: 32 }
    const { mismatches } = checkGrid(rom, cap, meta2, 32, false)
    expect(mismatches).toEqual([])
  })
})

describe('checkDefs', () => {
  it('passes when every word matches, including the priority bit', () => {
    const t: Map16Tile = { id: 0, tl: SUB(1, true), tr: SUB(2), bl: SUB(3), br: SUB(4) }
    const defs = new Uint8Array(8)
    const words = [t.tl, t.tr, t.bl, t.br].map(w => (w.charNum & 0x3ff) | (w.priority ? 0x2000 : 0))
    for (let i = 0; i < 4; i++) defs.set([words[i]! & 0xff, words[i]! >> 8], i * 2)
    expect(checkDefs([t], [], defs, ORDER, false)).toEqual([])
  })

  it('catches a flipped priority bit (bit 13) the ROM disagrees on', () => {
    const capTl = 1 // char 1, no priority
    const romTile: Map16Tile = { id: 0, tl: SUB(1, true), tr: SUB(0), bl: SUB(0), br: SUB(0) } // same char, priority SET
    const defs = new Uint8Array(8)
    defs.set([capTl & 0xff, capTl >> 8], 0)
    const out = checkDefs([romTile], [], defs, ORDER, false)
    expect(out).toEqual([
      { table: 'defs', cell: '$0 q0', expected: hex(capTl), actual: hex(0x2001) },
    ])
  })

  it.each([
    ['q1 (tr)', (t: Map16Tile) => ({ ...t, tr: SUB(0x99) })],
    ['q2 (bl)', (t: Map16Tile) => ({ ...t, bl: SUB(0x99) })],
    ['q3 (br)', (t: Map16Tile) => ({ ...t, br: SUB(0x99) })],
  ])('catches a def wrong only in %s, not just quadrant 0', (_label, mutate) => {
    const good: Map16Tile = { id: 0, tl: SUB(1), tr: SUB(2), bl: SUB(3), br: SUB(4) }
    const bad = mutate(good)
    const defs = new Uint8Array(8)
    const words = [good.tl, good.tr, good.bl, good.br].map(w => w.charNum)
    for (let i = 0; i < 4; i++) defs.set([words[i]! & 0xff, words[i]! >> 8], i * 2)
    const out = checkDefs([bad], [], defs, ORDER, false)
    expect(out).toHaveLength(1)
    expect(out[0]!.actual).toBe(hex(0x99))
  })

  it('reports a wrong def above $100', () => {
    const id = 0x150
    const tiles = Array.from({ length: id + 1 }, (_, i) => tile(i))
    tiles[id] = tile(id, 0x99)
    const defs = new Uint8Array((id + 1) * 8)
    const out = checkDefs(tiles, [], defs, ORDER, false)
    expect(out).toEqual([{ table: 'defs', cell: `${hex(id)} q0`, expected: hex(0), actual: hex(0x99) }]) // prettier-ignore
  })

  it('reports a tiles/defs length mismatch instead of silently truncating', () => {
    const out = checkDefs([tile(0)], [], new Uint8Array(16), ORDER, false)
    expect(out).toEqual([{ table: 'defs', cell: 'length', expected: '2 ids', actual: '1 ids' }])
  })

  it('compares the pipe range directly when no MAP16AppTable exists (ordinary tiles)', () => {
    const tiles = Array.from({ length: PIPE_LO + 1 }, (_, id) => (id === PIPE_LO ? tile(id, 0x99) : tile(id))) // prettier-ignore
    const defs = new Uint8Array(tiles.length * 8) // capture says char 0 everywhere
    const out = checkDefs(tiles, [], defs, ORDER, false)
    expect(out).toEqual([{ table: 'defs', cell: `${hex(PIPE_LO)} q0`, expected: hex(0), actual: hex(0x99) }]) // prettier-ignore
  })

  it.each([
    ['$132 (just below the range)', PIPE_LO - 1],
    ['$13B (just above the range)', PIPE_HI + 1],
  ])('compares %s normally even when the pipe range itself is skipped', (_label, id) => {
    const tiles = Array.from({ length: id + 1 }, (_, i) => (i === id ? tile(i, 0x99) : tile(i)))
    const defs = new Uint8Array(tiles.length * 8)
    const out = checkDefs(tiles, [], defs, ORDER, true)
    expect(out).toContainEqual({ table: 'defs', cell: `${hex(id)} q0`, expected: hex(0), actual: hex(0x99) }) // prettier-ignore
  })

  it('skips the pipe range only when an app table is present, and only inside $133..$13A', () => {
    const pipeVariants = [Array.from({ length: 8 }, (_, i) => tile(PIPE_LO + i, 0x50 + i))]
    // Every pipe id matches variant 0's compiled default; $132 and $13B (just
    // outside the range) are the zero tile, matching zero defs.
    const tiles = Array.from({ length: PIPE_HI + 2 }, (_, id) =>
      id >= PIPE_LO && id <= PIPE_HI ? tile(id, 0x50 + (id - PIPE_LO)) : tile(id),
    )
    const defs = new Uint8Array(tiles.length * 8)
    const out = checkDefs(tiles, pipeVariants, defs, ORDER, true)
    expect(out).toEqual([])
  })

  it('flags a resident pipe-range default that matches none of the 4 known variants', () => {
    const pipeVariants = [Array.from({ length: 8 }, (_, i) => tile(PIPE_LO + i, 0x50 + i))]
    const tiles = Array.from(
      { length: PIPE_HI + 1 },
      (_, id) =>
      id === PIPE_LO ? tile(id, 0x77) : id > PIPE_LO && id <= PIPE_HI ? tile(id, 0x50 + (id - PIPE_LO)) : tile(id), // prettier-ignore
    )
    const defs = new Uint8Array(tiles.length * 8)
    const out = checkDefs(tiles, pipeVariants, defs, ORDER, true)
    expect(out).toEqual([{ table: 'defs', cell: `${hex(PIPE_LO)} (compiled default)`, expected: 'one of the 4 MAP16AppTable variants', actual: '$77,$0,$0,$0' }]) // prettier-ignore
  })
})

function makePipeVariants(base: number[]): Map16Tile[][] {
  // 4 variants, each id i (0-7) holding word `base[v]+i` in every quadrant.
  return base.map(b => Array.from({ length: 8 }, (_, i) => tile(PIPE_LO + i, b + i, b + i, b + i, b + i))) // prettier-ignore
}
const build = (
  pipeVariants: Map16Tile[][],
  strip: number,
  variant: number,
  frame = 0,
): PipeWrites['builds'][number] => ({
  strip,
  frame,
  words: pipeVariants[variant]!.flatMap(t => [
    t.tl.charNum,
    t.tr.charNum,
    t.bl.charNum,
    t.br.charNum,
  ]),
})

describe('checkPipes', () => {
  const pipeVariants = makePipeVariants([0x100, 0x140, 0x180, 0x1c0])
  // Every case anchors s0=0 with this trivially-matching build (frame 0,
  // variant f(0)) so `checkPipes` computes the same s0=0 the comments below assume. // prettier-ignore
  const anchor = build(pipeVariants, 0, 0, 0)

  it('sanity: the four reference points the #571 cases below build on are distinct', () => {
    // f(0)=0, f(31)=f(s0+$1F)=1, f(32)=f(s0+$20)=2, f(64)=0.
    expect([0, 31, 32, 64].map(pipeVariantIndex)).toEqual([0, 1, 2, 0])
  })

  it('refuses rather than default when the capture lo/hi is not $133/$13A', () => {
    const writes: PipeWrites = { lo: 0x100, hi: 0x107, builds: [], unresolved: [] }
    const { mismatches } = checkPipes(pipeVariants, writes, false, false)
    expect(mismatches).toEqual([{ table: 'pipes', cell: 'range', expected: `${hex(PIPE_LO)}..${hex(PIPE_HI)}`, actual: '$100..$107' }]) // prettier-ignore
  })

  it('N10: zero builds and the grid does not cite the pipe range is clean, nothing to check', () => {
    const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [], unresolved: [] }
    expect(checkPipes(pipeVariants, writes, false, false).mismatches).toEqual([])
  })

  it('N10: zero builds but the grid CITES the pipe range is reported, not silently passed', () => {
    const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [], unresolved: [] }
    const { mismatches } = checkPipes(pipeVariants, writes, true, false)
    expect(mismatches).toEqual([{ table: 'pipes', cell: 'builds', expected: 'at least one recorded strip build', actual: '0' }]) // prettier-ignore
  })

  it('predicts every build via pipeVariantIndex(strip), with no resident/first-strip exemption', () => {
    // prettier-ignore
    const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [anchor], unresolved: [] }
    const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, false)
    expect(mismatches).toEqual([])
    expect(allowed).toEqual([])
  })

  it('a negative strip is predicted exactly like any other (dropped only by the oracle, never by this check)', () => {
    // prettier-ignore
    // strip -8: pipeVariantIndex(-8) = ((-8>>3)&6)>>1 = ((-1)&6)>>1 = 6>>1 = 3.
    // -8 becomes the new s0 here (earliest frame), so it is exempt as s0
    // itself only if it matches f(s0) or f(s0+$1F) - it matches f(-8)=3 directly.
    const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [build(pipeVariants, -8, 3, -1)], unresolved: [] } // prettier-ignore
    expect(checkPipes(pipeVariants, writes, false, false).mismatches).toEqual([])
  })

  it('reports a build whose words disagree with the predicted variant, negative strip included', () => {
    // prettier-ignore
    // Alone, strip -8 is its own s0, widened (round 5c) to allow ANY of the
    // ROM's 4 variants - so words must match NONE of them to still mismatch.
    const bogusWords = pipeVariants[0]!.flatMap(quadWords).map(w => w ^ 0x7fff)
    const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [{ strip: -8, frame: -1, words: bogusWords }], unresolved: [] } // prettier-ignore
    const { mismatches } = checkPipes(pipeVariants, writes, false, false)
    expect(mismatches.length).toBeGreaterThan(0)
    expect(mismatches[0]!.cell).toMatch(/^strip -8/)
  })

  it('reports unavailable per build when the ROM has no MAP16AppTable (empty pipeVariants)', () => {
    const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [anchor], unresolved: [] }
    const { mismatches } = checkPipes([], writes, false, false)
    expect(mismatches[0]!.actual).toMatch(/unavailable/)
  })

  it('a later build of the same strip is predicted independently each time (no memory of an earlier build)', () => {
    // prettier-ignore
    // strip 8 built twice: once matching the formula, once not - both are judged on their own.
    const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [anchor, build(pipeVariants, 8, 0, 10), build(pipeVariants, 8, 3, 900)], unresolved: [] } // prettier-ignore
    const { mismatches } = checkPipes(pipeVariants, writes, false, false)
    expect(mismatches.length).toBeGreaterThan(0) // the second (wrong) build is reported
  })

  it("F6: an unresolved build (from parsePipeWrites' opt-in) is reported, not silently absent", () => {
    // prettier-ignore
    const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [], unresolved: [{ strip: 5, frame: 100 }] } // prettier-ignore
    const { mismatches } = checkPipes(pipeVariants, writes, false, false)
    expect(mismatches).toEqual([{ table: 'pipes', cell: 'strip 5 frame 100', expected: 'a resolved build (pointers and a numeric frame/strip)', actual: 'unresolved' }]) // prettier-ignore
  })

  // #571: the one allowed pipe difference, one test per rule (all must be
  // seen red on their own planted defect - flip the expectation and each fails).
  describe('#571 the one allowed pipe difference', () => {
    it('a first strip (s0) equal to f(s0) passes, with no allowed-difference recorded', () => {
      const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [anchor], unresolved: [] } // anchor IS s0, variant f(0)=0 // prettier-ignore
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, false)
      expect(mismatches).toEqual([])
      expect(allowed).toEqual([]) // matches the default directly - not the bug's exemption
    })

    it('a first strip (s0) equal to f(s0+$1F) passes, recorded as one allowed difference', () => {
      const s0Build = build(pipeVariants, 0, 1, 0) // variant 1 = f(31) = f(s0+$1F), not f(0)=0
      const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [s0Build], unresolved: [] }
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, false)
      expect(mismatches).toEqual([])
      expect(allowed).toEqual([{ rule: ALLOWED_PIPE_BUG_S0_ALT, count: 1 }])
    })

    it('a first strip (s0) equal to a third ROM variant PASSES (round 5c: widened to any of the 4, neither f(s0) nor f(s0+$1F), reported separately)', () => {
      const s0Build = build(pipeVariants, 0, 2, 0) // variant 2: neither f(0)=0 nor f(31)=1, but still a real ROM variant
      const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [s0Build], unresolved: [] }
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, false)
      expect(mismatches).toEqual([])
      expect(allowed).toEqual([{ rule: ALLOWED_PIPE_BUG_S0_OTHER, count: 1 }])
    })

    it('a first strip (s0) holding words matching NO ROM variant still FAILS', () => {
      const bogusWords = pipeVariants[0]!.flatMap(quadWords).map(w => w ^ 0x7fff) // not any of the 4 variants
      const s0Build = { strip: 0, frame: 0, words: bogusWords }
      const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [s0Build], unresolved: [] }
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, false)
      expect(mismatches.length).toBeGreaterThan(0)
      expect(allowed).toEqual([])
    })

    it('a REVISIT of s0 (a later build of the same strip number) holding a non-f(strip) variant still FAILS on a horizontal map', () => {
      // The load's own first build of strip 0 matches f(0) exactly (ordinary,
      // no exemption needed); a SECOND build of strip 0 at a later frame,
      // holding a different ROM variant, is not the load's own first write
      // and gets no exemption of its own - the widened rule only ever
      // applies to that one object, identified by object, not by strip value.
      const firstBuild = build(pipeVariants, 0, 0, 0) // matches f(0) - ordinary
      const revisit = build(pipeVariants, 0, 1, 500) // matches f(s0+$1F), but this is not the s0 build
      const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [firstBuild, revisit], unresolved: [] } // prettier-ignore
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, false)
      expect(mismatches.length).toBeGreaterThan(0)
      expect(allowed).toEqual([])
    })

    it('a vertical post-load build equal to f(s0+$20) passes, recorded as one allowed difference', () => {
      // prettier-ignore
      // strip 64 (> loadLoopEnd=31): f(64)=0, but f(s0+$20)=f(32)=2 - the build
      // holds variant 2, which the naive f(strip) rule alone would reject.
      const post = build(pipeVariants, 64, 2, 500)
      const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [anchor, post], unresolved: [] } // prettier-ignore
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, true)
      expect(mismatches).toEqual([])
      expect(allowed).toEqual([{ rule: ALLOWED_PIPE_BUG_VERTICAL, count: 1 }])
    })

    it('a vertical post-load build equal to f(strip), differing from f(s0+$20), FAILS - the capture must match the bug', () => {
      // prettier-ignore
      // Same strip 64, but variant 0 = f(64) itself, not f(s0+$20)=f(32)=2.
      // CODE_0587CB writes no set, so f(s0+$20) is the ONLY correct answer here.
      const post = build(pipeVariants, 64, 0, 500)
      const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [anchor, post], unresolved: [] } // prettier-ignore
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, true)
      expect(mismatches.length).toBeGreaterThan(0)
      expect(allowed).toEqual([])
    })

    it('a horizontal scroll build (post-load) is never exempt: f(strip) only, even if it equals f(s0+$20)', () => {
      // prettier-ignore
      // Same strip 64 holding variant 2 (= f(s0+$20)=f(32)), but isVertical=false:
      // horizontal scroll (CODE_05877E) always writes f(strip) itself, no exemption.
      const post = build(pipeVariants, 64, 2, 500)
      const writes: PipeWrites = { lo: PIPE_LO, hi: PIPE_HI, builds: [anchor, post], unresolved: [] } // prettier-ignore
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, false)
      expect(mismatches.length).toBeGreaterThan(0)
      expect(allowed).toEqual([])
    })

    it('a load-loop strip (s0+1..s0+$1F) is never exempt, even holding the value an adjacent rule would allow', () => {
      // A real, chronologically contiguous load pass from s0=0 through
      // strip 8 (the window is s0..s0+$1F=31): strips 0-7 each hold their
      // true f(strip), so the load pass is recognized as such, and strip 8
      // holds variant 2 (= f(s0+$20)=f(32), the VERTICAL post-load rule's
      // own value) instead of its true f(8)=0 - the load loop has no
      // exemption at all, vertical or not, even for a value an adjacent
      // rule would allow.
      const loadRun = Array.from({ length: 8 }, (_, strip) =>
        build(pipeVariants, strip, pipeVariantIndex(strip), strip),
      )
      const inLoop = build(pipeVariants, 8, 2, 8)
      const writes: PipeWrites = {
        lo: PIPE_LO,
        hi: PIPE_HI,
        builds: [...loadRun, inLoop],
        unresolved: [],
      }
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, true)
      expect(mismatches.length).toBeGreaterThan(0)
      expect(allowed).toEqual([])
    })

    it('a vertical build ABOVE the window (strip > s0+$1F) is exempt exactly like one below it, at f(s0+$20)', () => {
      // strip 64 > loadLoopEnd=31: f(64)=0, but f(s0+$20)=f(32)=2 - the same
      // shape as the "post-load build equal to f(s0+$20)" case above, kept
      // here explicitly so a regression narrowing the freeze to only the
      // strip-below-s0 direction is caught.
      const above = build(pipeVariants, 64, 2, 500)
      const writes: PipeWrites = {
        lo: PIPE_LO,
        hi: PIPE_HI,
        builds: [anchor, above],
        unresolved: [],
      }
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, true)
      expect(mismatches).toEqual([])
      expect(allowed).toEqual([{ rule: ALLOWED_PIPE_BUG_VERTICAL, count: 1 }])
    })

    it('a first frame that builds several strips at once (s0 ambiguity) takes s0 as the MINIMUM strip of that frame, not any of the others', () => {
      // $0D0's real load builds strips 247-250 in one frame (452): s0 is the
      // lowest (247), not an arbitrary member of the group. Modeled here at
      // a smaller scale: one frame builds strips 13,14,15,16 together, so s0
      // must resolve to 13, making loadLoopEnd = 13+$1F = 44 and s0+$20 = 45,
      // not the 16+$1F = 47 / 48 a wrong "take the last strip" reading
      // would produce (chosen so the two predict different variants: f(45)
      // and f(48) differ, so a wrong s0 is caught, not accidentally passed).
      const multiStrip = [13, 14, 15, 16].map(strip =>
        build(pipeVariants, strip, pipeVariantIndex(strip), 0),
      )
      const post = build(pipeVariants, 64, pipeVariantIndex(45), 900)
      const writes: PipeWrites = {
        lo: PIPE_LO,
        hi: PIPE_HI,
        builds: [...multiStrip, post],
        unresolved: [],
      }
      const { mismatches, allowed } = checkPipes(pipeVariants, writes, false, true)
      expect(mismatches).toEqual([])
      expect(allowed).toEqual([{ rule: ALLOWED_PIPE_BUG_VERTICAL, count: 1 }])
    })
  })
})

describe('parsePipeWrites', () => {
  const raw = {
    entryPointers: 'Map16Pointers[$133..$13A] in order',
    defsWordOrder: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    defs: { $A: [1, 2, 3, 4] },
    stripBuilds: [
      { strip: -3, frame: 50, pointers: ['$A', '$A', '$A', '$A', '$A', '$A', '$A', '$A'] },
      { strip: 5, frame: 60, pointers: ['$A', '$A', '$A', '$A', '$A', '$A', '$A', '$A'] },
      { strip: 6, frame: 60, pointers: ['$missing'] }, // unresolved: wordsOf fails (wrong count, absent key)
      { strip: NaN, frame: 60, pointers: ['$A', '$A', '$A', '$A', '$A', '$A', '$A', '$A'] }, // unresolved: NaN strip
    ],
  }

  it('keeps negative strips (unlike the default oracle) and surfaces unresolved builds instead of dropping them', () => {
    // prettier-ignore
    const writes = parsePipeWrites(raw, { levelLoadFrame: 0 })
    expect(writes).not.toBeNull()
    expect(writes!.builds.some(b => b.strip === -3)).toBe(true)
    expect(writes!.unresolved).toHaveLength(2)
  })

  it('returns null when the sidecar itself does not state the pipe range/defs/order/builds', () => {
    expect(parsePipeWrites({}, null)).toBeNull()
  })
})

describe('usedByStrip / citedWords', () => {
  it('keys each id by column for a horizontal grid, row for a vertical one', () => {
    expect(usedByStrip([[7, 8]], false)).toEqual(new Map([[7, new Set([0])], [8, new Set([1])]])) // prettier-ignore
    expect(usedByStrip([[7], [8]], true)).toEqual(new Map([[7, new Set([0])], [8, new Set([1])]])) // prettier-ignore
  })

  it('collects only the chars and palette rows the grid actually cites', () => {
    const tiles = [tile(0, /* tl */ 5), tile(1, /* tl */ 9)]
    const { chars, rows, citesPipeRange } = citedWords([[0]], false, tiles, [])
    // tl=char5,pal0; tr/bl/br default char0,pal0 too - id 1 (char9) is never placed, so not cited.
    expect(chars).toEqual(new Set([5, 0]))
    expect(rows).toEqual(new Set([0]))
    expect(citesPipeRange).toBe(false)
  })

  it('N18: cites a palette row 4 or higher unmodified (the field is 3 bits, not `palette & 3`)', () => {
    // prettier-ignore
    const t: Map16Tile = { id: 0, tl: { charNum: 1, palette: 6, priority: false, flipX: false, flipY: false }, tr: SUB(0), bl: SUB(0), br: SUB(0) } // prettier-ignore
    const { rows } = citedWords([[0]], false, [t], [])
    // tr/bl/br default to palette 0 too, so row 0 is cited alongside row 6.
    // A `palette & 3` mutant would report row 2 (6 & 3) instead of row 6.
    expect(rows).toEqual(new Set([0, 6]))
    expect(rows.has(2)).toBe(false)
  })

  it('resolves a pipe id through the variant for its OWN strip, not variant 0 regardless of strip', () => {
    const pipeVariants = makePipeVariants([0x50, 0x60, 0x70, 0x80])
    // strip 0 (horizontal column) -> pipeVariantIndex(0) = 0: variant 0's word for id PIPE_LO is 0x50.
    const { chars, citesPipeRange } = citedWords([[PIPE_LO]], false, [], pipeVariants)
    expect(citesPipeRange).toBe(true)
    expect(chars.has(0x50)).toBe(true)
    // Placed at column 40 instead: pipeVariantIndex(40) = 2, so it resolves variant 2's word (0x70).
    const grid40 = [Array.from({ length: 41 }, (_, c) => (c === 40 ? PIPE_LO : 0x25))]
    const at40 = citedWords(grid40, false, [], pipeVariants)
    expect(at40.chars.has(0x70)).toBe(true)
  })

  it('resolves a pipe id on a vertical grid using the row as the strip', () => {
    const pipeVariants = makePipeVariants([0x50, 0x60, 0x70, 0x80])
    // Row 40 (vertical strip) -> pipeVariantIndex(40) = 2, same as the horizontal case above.
    const grid = Array.from({ length: 41 }, (_, r) => [r === 40 ? PIPE_LO : 0x25])
    const { chars, citesPipeRange } = citedWords(grid, true, [], pipeVariants)
    expect(citesPipeRange).toBe(true)
    expect(chars.has(0x70)).toBe(true)
  })
})

const flatChar = (v: number): Uint8Array => new Uint8Array(64).fill(v)

/** vram.bin bytes for one 4bpp char at BG word address `charBase+ch`, holding uniform color `v` (0-15, all 4 planes). */ // prettier-ignore
function planarChar(charBase: number, ch: number, v: number, bg12nba = 0): Uint8Array {
  const b = new Uint8Array(0x10000)
  const baseWord = (bg12nba & 15) << 12
  const a = (baseWord * 2 + (charBase + ch) * 32) & 0xffff
  for (let row = 0; row < 8; row++) {
    b[a + row * 2] = v & 1 ? 0xff : 0
    b[a + row * 2 + 1] = v & 2 ? 0xff : 0
    b[a + 16 + row * 2] = v & 4 ? 0xff : 0
    b[a + 16 + row * 2 + 1] = v & 8 ? 0xff : 0
  }
  return b
}

describe('checkChars', () => {
  const vram: VramState = {
    fg1: [flatChar(0), flatChar(0), flatChar(0), flatChar(0), flatChar(0), flatChar(3)],
  } // char 5 = 3 // prettier-ignore

  it('passes when the ROM char pixels equal the capture VRAM at BG12NBA 0', () => {
    const capVram = planarChar(0, 5, 3)
    expect(checkChars(new Set([5]), vram, null, capVram, 0)).toEqual([])
  })

  it('passes with a non-zero BG12NBA (the capture reads the shifted base)', () => {
    const capVram = planarChar(0, 5, 3, 3) // BG12NBA=3 -> base word $3000
    expect(checkChars(new Set([5]), vram, null, capVram, 3)).toEqual([])
  })

  it('reports a wrong char pixel', () => {
    const capVram = planarChar(0, 5, 2, 0) // differs: value 2, not 3
    const out = checkChars(new Set([5]), vram, null, capVram, 0)
    expect(out).toEqual([{ table: 'chars', cell: hex(5), expected: [...planarPixels(capVram, 0, 5, 0)].join(','), actual: [...flatChar(3)].join(',') }]) // prettier-ignore
  })

  it('N41: reports a char the ROM has no data for at all (a null ROM char), not "unavailable" silently passing', () => {
    // prettier-ignore
    const capVram = planarChar(0, 99, 3) // char 99 is cited but out of range of every VRAM slot
    const out = checkChars(new Set([99]), vram, null, capVram, 0)
    expect(out).toEqual([{ table: 'chars', cell: hex(99), expected: [...planarPixels(capVram, 0, 99, 0)].join(','), actual: 'unavailable' }]) // prettier-ignore
  })

  it('resolves a pixel using planes 2-3 (value 4-15), not just the low 2 bits', () => {
    const highVram: VramState = {
      fg1: [flatChar(0), flatChar(0), flatChar(0), flatChar(0), flatChar(0), flatChar(12)],
    } // 12 = bits 2+3 // prettier-ignore
    const capVram = planarChar(0, 5, 12)
    expect(checkChars(new Set([5]), highVram, null, capVram, 0)).toEqual([])
  })

  it('reports an animated char matching no ROM-derived frame', () => {
    const capVram = planarChar(0, 5, 9) // matches neither the base (3) nor the one frame below (2)
    const anim: AnimationData = { frameCount: 1, intervalMs: 100, frames: [[{ charBase: 5, tiles: [flatChar(2)] }]] } // prettier-ignore
    const out = checkChars(new Set([5]), vram, anim, capVram, 0)
    expect(out).toHaveLength(1)
  })

  it('does not accept a match from a frame slot covering a DIFFERENT char', () => {
    const capVram = planarChar(0, 5, 2) // equals the frame value, but that frame is for char 6, not 5
    const anim: AnimationData = { frameCount: 1, intervalMs: 100, frames: [[{ charBase: 6, tiles: [flatChar(2)] }]] } // prettier-ignore
    const out = checkChars(new Set([5]), vram, anim, capVram, 0)
    expect(out).toHaveLength(1)
  })

  it('passes an animated char that matches one of its ROM-derived frames, not the base pixels', () => {
    const capVram = planarChar(0, 5, 2)
    const anim: AnimationData = { frameCount: 1, intervalMs: 100, frames: [[{ charBase: 5, tiles: [flatChar(2)] }]] } // prettier-ignore
    expect(checkChars(new Set([5]), vram, anim, capVram, 0)).toEqual([])
  })

  it("M19: a slot with two animated chars - the capture holding the OTHER char's frame still mismatches", () => {
    // prettier-ignore
    // One slot, charBase 5, covering chars 5 and 6 with distinct frame pixels.
    const anim: AnimationData = { frameCount: 1, intervalMs: 100, frames: [[{ charBase: 5, tiles: [flatChar(2), flatChar(7)] }]] } // prettier-ignore
    // Char 5's capture shows char 6's own frame value (7), not char 5's (2) or its base (3).
    const capVram = planarChar(0, 5, 7)
    const out = checkChars(new Set([5]), vram, anim, capVram, 0)
    expect(out).toHaveLength(1) // must not match by slot alone; the PER-CHAR tile index inside the slot matters
  })
})

/** Decode planarChar's own bytes back to 64 pixel values, for building an exact `expected` in a test. */
function planarPixels(vram: Uint8Array, charBase: number, ch: number, bg12nba: number): Uint8Array {
  const baseWord = (bg12nba & 15) << 12
  const a = (baseWord * 2 + (charBase + ch) * 32) & 0xffff
  const out = new Uint8Array(64)
  for (let y = 0; y < 8; y++) {
    const lo = (vram[a + y * 2]! & 0xff) !== 0 ? 1 : 0
    const hi2 = (vram[a + y * 2 + 1]! & 0xff) !== 0 ? 2 : 0
    const hi3 = (vram[a + 16 + y * 2]! & 0xff) !== 0 ? 4 : 0
    const hi4 = (vram[a + 16 + y * 2 + 1]! & 0xff) !== 0 ? 8 : 0
    for (let x = 0; x < 8; x++) out[y * 8 + x] = lo | hi2 | hi3 | hi4
  }
  return out
}

describe('checkPalette', () => {
  // Widened 5-bit channels 1,2,3: (k<<3)|(k>>2), the only values a real
  // BGR555 round trip can produce - not arbitrary RGB, or "matches" and
  // "mismatches" would both be artifacts of the widening, not the check.
  const STATIC_RGB: [number, number, number, number] = [8, 16, 24, 255]
  const STATIC_W = 1 | (2 << 5) | (3 << 10)
  const staticColors = new Array(256).fill(STATIC_RGB)

  /** A full 256-color cgram matching `staticColors` everywhere, except `idx` overridden to `rgb555`. */
  function cgram(idx: number, rgb555: number): Uint8Array {
    const c = new Uint8Array(512)
    for (let i = 0; i < 256; i++) {
      const w = i === idx ? rgb555 : STATIC_W
      c[i * 2] = w & 0xff
      c[i * 2 + 1] = w >> 8
    }
    return c
  }

  it('passes when every cited row matches', () => {
    expect(checkPalette(new Set([0]), staticColors, new Map(), cgram(0, STATIC_W))).toEqual([])
  })

  it('never checks a row the grid does not cite', () => {
    // Row 1 (idx 16-31) is wrong everywhere, but row 1 is not cited.
    const c = cgram(16, 0x7fff)
    expect(checkPalette(new Set([0]), staticColors, new Map(), c)).toEqual([])
  })

  it('reports a wrong static color on a cited row', () => {
    const out = checkPalette(new Set([0]), staticColors, new Map(), cgram(0, 0x7fff))
    expect(out).toEqual([{ table: 'palette', cell: hex(0), expected: '255,255,255', actual: '8,16,24' }]) // prettier-ignore
  })

  it('reports an animated palette index whose ROM-derived frames do not match any of them (M25)', () => {
    const c = cgram(0, 0x7fff) // observed color widens to (255,255,255)
    const animByIdx = new Map([[0, [[33, 41, 49, 255] as [number, number, number, number], [1, 2, 3, 255] as [number, number, number, number]]]]) // prettier-ignore
    const out = checkPalette(new Set([0]), staticColors, animByIdx, c)
    expect(out).toEqual([{ table: 'palette', cell: hex(0), expected: '255,255,255', actual: '8,16,24' }]) // prettier-ignore
  })

  it('passes a color that matches one of its ROM-animated frames, not the static value', () => {
    const frameW = 4 | (5 << 5) | (6 << 10) // widens to (33,41,49)
    const animByIdx = new Map([[0, [[33, 41, 49, 255] as [number, number, number, number]]]])
    expect(checkPalette(new Set([0]), staticColors, animByIdx, cgram(0, frameW))).toEqual([])
  })

  it("does not accept a match from a DIFFERENT cgram index's animation frames", () => {
    const frameW = 4 | (5 << 5) | (6 << 10)
    const animByIdx = new Map([[5, [[33, 41, 49, 255] as [number, number, number, number]]]]) // idx 5, not 0
    const out = checkPalette(new Set([0]), staticColors, animByIdx, cgram(0, frameW))
    expect(out).toHaveLength(1)
  })

  it('M26: cited words spanning 2+ rows - a wrong color in the SECOND row is still caught', () => {
    const good = cgram(-1, STATIC_W) // -1: no override, every row/col matches staticColors
    const bad = cgram(1 * 16 + 3, 0x7fff) // row 1, col 3 wrong
    expect(checkPalette(new Set([0]), staticColors, new Map(), good)).toEqual([])
    const out = checkPalette(new Set([0, 1]), staticColors, new Map(), bad)
    expect(out).toEqual([{ table: 'palette', cell: hex(1 * 16 + 3), expected: '255,255,255', actual: '8,16,24' }]) // prettier-ignore
  })
})
