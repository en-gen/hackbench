/**
 * #840: the synthetic cart's companion routines are our own opcodes, not copies of the game's code.
 * Method: slide an 8-byte window over the whole vanilla ROM (any alignment, not just the routine's
 * own address) and require no span this branch writes to match. No ROM bytes are stored here.
 */
import { describe, expect, it } from 'vitest'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { putCompanionRoutines } from '../../support/syntheticCompanion'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const WINDOW = 8

/** Every span putCompanionRoutines writes: [snes, bytes]. */
function spans(): [number, number[]][] {
  const out: [number, number[]][] = []
  putCompanionRoutines((snes, bytes) => out.push([snes, bytes]))
  return out
}

/** Count of 8-byte windows in `routine` that occur anywhere in `hay`. */
function matches(hay: Uint8Array, routine: number[]): number {
  let n = 0
  for (let i = 0; i + WINDOW <= routine.length; i++) {
    const w = routine.slice(i, i + WINDOW)
    for (
      let p = hay.indexOf(w[0]);
      p !== -1 && p + WINDOW <= hay.length;
      p = hay.indexOf(w[0], p + 1)
    )
      if (w.every((v, k) => hay[p + k] === v)) n++
  }
  return n
}

describe('no vanilla code bytes in the companion routines', () => {
  it('the window check goes red on a planted copy, at any alignment, and green on a changed byte', () => {
    const hay = Uint8Array.from([9, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9])
    expect(matches(hay, [1, 2, 3, 4, 5, 6, 7, 8])).toBe(1)
    expect(matches(hay, [0, 1, 2, 3, 4, 5, 6, 7, 8])).toBe(1)
    expect(matches(hay, [1, 2, 3, 4, 5, 6, 7, 0])).toBe(0)
  })

  it('writes the four routines, each long enough to hold a window', () => {
    expect(spans().map(([, b]) => b.length >= WINDOW)).toEqual([true, true, true, true])
  })

  describe.skipIf(!hasRom(VANILLA))('against the vanilla ROM, ROM-wide', () => {
    it('no 8-byte window of any span this branch writes occurs anywhere in the ROM', () => {
      const rom = new Uint8Array(freshRom(VANILLA).buffer)
      expect(spans().flatMap(([at, b]) => (matches(rom, b) ? [at.toString(16)] : []))).toEqual([])
    })

    it('nor does a window of the assembled cart that touches one of those spans (zero padding beside a span is not code)', () => {
      const cart = new Uint8Array(buildSyntheticRom().buffer)
      const rom = new Uint8Array(freshRom(VANILLA).buffer)
      const off = (snes: number) => (snes >> 16) * 0x8000 + (snes & 0x7fff)
      let touching = 0
      const hits: string[] = []
      for (const [at, b] of spans()) {
        const s = off(at)
        for (let w = s - (WINDOW - 1); w < s + b.length; w++) {
          const win = Array.from(cart.subarray(w, w + WINDOW))
          const outside = win.filter((_, k) => w + k < s || w + k >= s + b.length)
          if (outside.length && outside.every(v => v === 0)) continue
          touching++
          if (matches(rom, win) > 0) hits.push(`${at.toString(16)}+${w - s}`)
        }
      }
      expect(touching).toBeGreaterThan(0)
      expect(hits).toEqual([])
    })
  })
})
