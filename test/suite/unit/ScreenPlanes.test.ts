/**
 * Per-screen plane lists (#562). The expected lists come from a hand-written
 * copy of the mode 1 table (strings, not `ppuDrawOrder`), so the oracle is
 * independent of the code under test.
 */
import { describe, it, expect } from 'vitest'
import {
  screenPlanes,
  FALLBACK_SCREENS,
  type ScreenPlanes,
} from '../../../src/rom/model/ScreenPlanes'
import { readModeLayouts } from '../../../src/rom/LevelScreenTables'
import { modeTablesRom } from '../support/l3Rom'

// docs/snes-superfamicom-selected.md:501-518, back to front, BG layers only.
const SET = ['l3Low', 'l2Low', 'l1Low', 'l2High', 'l1High', 'l3High']
const CLEAR = ['l3Low', 'l3High', 'l2Low', 'l1Low', 'l2High', 'l1High']
const BITS: Record<string, number> = { l1: 1, l2: 2, l3: 4 }
const on = (order: string[], mask: number) => order.filter(k => mask & BITS[k.slice(0, 2)]!)
const expected = (main: number, sub: number, pri: boolean) => ({
  main: on(pri ? SET : CLEAR, main),
  sub: on(pri ? SET : CLEAR, sub),
})

/** 32 modes with distinct, deliberately odd designations (bits 3 and 4 set on some). */
const layouts = Array.from({ length: 32 }, (_, m) => ({
  main: (m * 5 + 1) & 0x1f,
  sub: (m * 11 + 3) & 0x1f,
  cgadsub: 0x24,
  special: 0,
  vertical: 0,
}))

/** The modes (and priority bits) a candidate gets wrong, read from synthetic tables. */
const wrong = (impl: typeof screenPlanes) => {
  const r = readModeLayouts(modeTablesRom(layouts))
  if (!r.ok) throw new Error(r.reason)
  return r.layouts.flatMap((l, m) =>
    [true, false]
      .filter(
        p => JSON.stringify(impl(l.main, l.sub, p)) !== JSON.stringify(expected(l.main, l.sub, p)),
      )
      .map(p => `${m}:${p}`),
  )
}

describe('screenPlanes: all 32 modes, both priority bits', () => {
  it('matches the hand table for every mode read from synthetic tables', () => {
    expect(wrong(screenPlanes)).toEqual([])
  })
  it('the #561 standard layout is the case main $15, sub $02', () => {
    expect(screenPlanes(0x15, 0x02, true)).toEqual<ScreenPlanes>({
      main: ['l3Low', 'l1Low', 'l1High', 'l3High'],
      sub: ['l2Low', 'l2High'],
    })
    expect(screenPlanes(0x15, 0x02, false)).toEqual<ScreenPlanes>({
      main: ['l3Low', 'l3High', 'l1Low', 'l1High'],
      sub: ['l2Low', 'l2High'],
    })
  })
  it('BG3 on the sub screen follows the priority bit (modes 1E, 1F style)', () => {
    expect(screenPlanes(0x01, 0x04, true).sub).toEqual(['l3Low', 'l3High'])
    expect(screenPlanes(0x02, 0x16, false).sub).toEqual(['l3Low', 'l3High', 'l2Low', 'l2High'])
    expect(screenPlanes(0x02, 0x16, true).sub).toEqual(['l3Low', 'l2Low', 'l2High', 'l3High'])
  })
  it('fallback is the old BG1/BG2 order', () => {
    expect(FALLBACK_SCREENS).toEqual({ main: ['l2Low', 'l1Low', 'l2High', 'l1High'], sub: [] })
  })
})

describe('the per-mode oracle can fail (planted defects, a smoke test)', () => {
  it('catches BG3 high in the wrong slot, a sub list read from main, and BG4 not ignored', () => {
    const swapHigh: typeof screenPlanes = (m, s, p) => {
      const r = screenPlanes(m, s, p)
      return { ...r, main: r.main.map(k => (k === 'l3High' ? 'l3Low' : k)) as ScreenPlanes['main'] }
    }
    const subFromMain: typeof screenPlanes = (m, _s, p) => screenPlanes(m, m, p)
    // A BG4 bit that changes the answer.
    const bg4Breaks: typeof screenPlanes = (m, s, p) =>
      m & 8 ? { main: [], sub: [] } : screenPlanes(m, s, p)
    for (const bad of [swapHigh, subFromMain, bg4Breaks]) {
      expect(wrong(bad).length).toBeGreaterThan(0)
    }
  })
})
