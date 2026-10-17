/**
 * Line-guided travel and TrueFrame parity (#1029). CODE_01D768 (SMWDisX bank_01.asm:11863-11882) dispatches on
 * $157C (11866-11867) to the forward walk (index +1) or the reverse walk CODE_01D792 (11884-11899, $1570 -1);
 * with $187B nonzero both take one more step on an odd TrueFrame, so the sprite covers 10 or 11 px between two
 * samples depending on the parity the run starts at. This file pins the runner's TrueFrame feed to a walk of
 * that shape (generic, not one ROM branch): the synthetic MAIN below copies the forward walk's INC pair. The
 * witnessed $65-$68 records all run $157C=1 (the reverse walk) and only $62 reaches the forward walk, so the
 * replay file is what ties the feed to the reverse walk. The map view keeps its third-pass policy frame (no
 * render change). Synthetic cart: ids 34 (INIT sets $187B) and 35 (INIT is RTS) share a hand-written MAIN. No
 * ROM, no vanilla bytes.
 */
import { describe, expect, it } from 'vitest'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

/** Where the routines go (free bank-1 space), and the INIT / MAIN pointer-table cells of ids 34 and 35. */
const INIT_AT = 0x019700
const MAIN_AT = 0x019720
const INIT_PTR = (id: number) => 0x01817b + 2 * id
const MAIN_PTR = (id: number) => 0x018329 + 2 * id

// prettier-ignore
const ROUTINES: readonly (readonly [number, readonly number[]])[] = [
  [INIT_AT, [0xfe, 0x7b, 0x18, 0x60]], // INC $187B,X / RTS
  [MAIN_AT, [
    0xbd, 0x34, 0x15,       // LDA $1534,X: the track index
    0x18, 0x69, 0x80,       // CLC / ADC #$80
    0x95, 0xe4,             // STA $E4,X: X follows the index
    0xfe, 0x34, 0x15,       // INC $1534,X
    0xbd, 0x7b, 0x18,       // LDA $187B,X: nonzero for a line-guided id (1 here)
    0x25, 0x13,             // AND $13: TrueFrame
    0x29, 0x01,             // AND #$01: odd frame, and $187B set
    0xf0, 0x03,             // BEQ done
    0xfe, 0x34, 0x15,       // INC $1534,X: one more on an odd frame
    0x60,                   // done: RTS
  ]],
  [INIT_PTR(34), [INIT_AT & 0xff, (INIT_AT >> 8) & 0xff]],
  [MAIN_PTR(34), [MAIN_AT & 0xff, (MAIN_AT >> 8) & 0xff]],
  [MAIN_PTR(35), [MAIN_AT & 0xff, (MAIN_AT >> 8) & 0xff]],
]

function cart() {
  const rom = buildSyntheticRom()
  for (const [at, bytes] of ROUTINES) rom.writeAt(at, [...bytes])
  return rom
}

/** X offset from $80 after each of `passes` MAIN passes, for a run whose INIT frame sees TrueFrame `tf`. */
function track(id: number, tf: number, passes = 9): number[] {
  const seed = withSeed({ slot: 3, sprite: { x: 0x80, y: 0x80 }, trueFrame: tf, mainPasses: passes }, SPRITE_SEED) // prettier-ignore
  const m = runOnce(cart(), id, seed)
  expect(m.refusal).toBeUndefined()
  return m.passes.map(p => p.pos.x - 0x80)
}

describe('line-guided travel rides on the TrueFrame the runner seeds', () => {
  it('advances 1 or 2 per frame by parity: exact track for both starting parities', () => {
    // Pass p sees TrueFrame seed + 1 + p; the index is read before the step, so pass 0 reports index 0.
    expect(track(34, 0)).toEqual([0, 2, 3, 5, 6, 8, 9, 11, 12])
    expect(track(34, 1)).toEqual([0, 1, 3, 4, 6, 7, 9, 10, 12])
  })

  it('covers 10 px between pass 1 and pass 8 from an even start and 11 from an odd one', () => {
    const [even, odd] = [track(34, 0), track(34, 1)]
    expect([even[8]! - even[1]!, odd[8]! - odd[1]!]).toEqual([10, 11])
    // The parity moves X itself: the two starts differ at the sampled passes, not only in the total.
    expect(even.map((x, i) => x - odd[i]!)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0])
  })

  it('depends on the parity only: every starting TrueFrame 0-255 gives one of the two tracks', () => {
    const want = [
      [0, 2, 3, 5, 6, 8, 9, 11, 12],
      [0, 1, 3, 4, 6, 7, 9, 10, 12],
    ]
    const wrong: number[] = []
    for (let tf = 0; tf < 256; tf++) {
      if (JSON.stringify(track(34, tf, 9)) !== JSON.stringify(want[tf & 1])) wrong.push(tf)
    }
    expect(wrong).toEqual([])
  })

  it('moves 1 per frame whatever the parity when $187B is zero', () => {
    const want = Array.from({ length: 9 }, (_, i) => i) // one step per pass: index i after i passes
    expect([track(35, 0), track(35, 1)]).toEqual([want, want])
  })
})

/** The safety rule: no routine this file adds shares an 8-byte window (3+ distinct values) with the vanilla ROM. */
describe('the added routines carry no vanilla bytes', () => {
  const W = 8
  const key = (w: Uint8Array) => Buffer.from(w).toString('latin1')
  const windows = (b: Uint8Array) =>
    Array.from({ length: Math.max(0, b.length - W + 1) }, (_, i) => b.subarray(i, i + W)).filter(w => new Set(w).size >= 3) // prettier-ignore
  const shared = (b: Uint8Array, set: Set<string>) => windows(b).filter(w => set.has(key(w))).length

  describe.skipIf(!hasRom(VANILLA))('against the vanilla ROM', () => {
    // Read lazily: a skipped describe still runs its body, and there is no ROM to read then.
    const load = () => {
      const rom = freshRom()
      const vb = rom.buffer.subarray(rom.hasHeader ? 512 : 0)
      const set = new Set<string>()
      for (let i = 0; i + W <= vb.length; i++) set.add(key(vb.subarray(i, i + W)))
      return { vb, set }
    }

    it('shares no window, in any routine or pointer cell', () => {
      const { set: vanilla } = load()
      const per = ROUTINES.map(([, bytes]) => shared(Uint8Array.from(bytes), vanilla))
      expect(per).toEqual(ROUTINES.map(() => 0))
    })

    it('reports a planted copy: 8 bytes read from the vanilla ROM at run time', () => {
      const { vb, set: vanilla } = load()
      let at = 0x10000
      while (new Set(vb.subarray(at, at + W)).size < 3) at++
      expect(shared(Uint8Array.from(vb.subarray(at, at + W)), vanilla)).toBe(1)
      const withCopy = Uint8Array.from([...ROUTINES[1]![1], ...vb.subarray(at, at + W)])
      expect(shared(withCopy, vanilla)).toBeGreaterThanOrEqual(1)
      expect(shared(Uint8Array.from(ROUTINES[1]![1]), vanilla)).toBe(0)
    })
  })

  // Only the 24-byte MAIN holds 8-byte windows; INIT (4 bytes) and the pointer cells (2) are too short to,
  // so this control is what proves the scan above is not vacuous.
  it('has windows to scan: the routines are long enough to hold at least one', () => {
    expect(windows(Uint8Array.from(ROUTINES[1]![1])).length).toBeGreaterThan(0)
  })
})
