/**
 * Pass-list acceptance sweep over all 512 level ids.
 *
 * A single level would not catch an order bug that only shows up when a
 * level happens to occupy an unusual set of passes, so this builds every
 * slot on the cart and checks the pass list structurally, then locks the
 * measured shape.
 *
 * Evidence scope: "Super Mario World (USA)", one cart, 512 of 512 slots
 * built, 0 failures. Every number below is measured, not predicted.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'fs'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildMap } from '../../../../src/rom/model/MapBuilder'
import { ppuDrawOrder, type RenderPass } from '../../../../src/rom/model/RenderPass'
import { resetEditorStore } from '../fixtures/stores'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

const key = (p: RenderPass): string => `${p.layer}.${p.priority}`

/** Levels ranked by Layer-1 priority cell count: 923, 630 and 462 cells. */
const DENSE_L1_PRIORITY = [0x10a, 0x1ec, 0x11e]

describe.skipIf(!existsSync(ROM_PATH))('pass list over all 512 level ids', () => {
  beforeEach(resetEditorStore)

  const sweep = (): { id: number; passes: RenderPass[]; bg3: boolean }[] => {
    const rom = SmwRom.open(ROM_PATH)
    return Array.from({ length: 512 }, (_, id) => {
      const map = buildMap(rom, id)
      return { id, passes: map.passes(), bg3: map.header.layer3Priority ?? false }
    })
  }

  it('every level emits a duplicate-free subsequence of the PPU order', () => {
    // The structural invariant that matters: the compositor may drop
    // passes a level does not occupy, never reorder or repeat them.
    for (const { id, passes, bg3 } of sweep()) {
      const full = ppuDrawOrder(bg3).map(key)
      const got = passes.map(key)
      expect(new Set(got).size, `level $${id.toString(16)}`).toBe(got.length)
      let at = -1
      for (const k of got) {
        const next = full.indexOf(k)
        expect(next, `level $${id.toString(16)} pass ${k}`).toBeGreaterThan(at)
        at = next
      }
    }
  })

  it('the three densest Layer-1 priority levels each split Layer 1 in two', () => {
    // 666 vanilla cells mix priority and non-priority subtiles inside one
    // 16x16, which is what genuinely forces two L1 passes at one grid
    // position. These are the levels with the most such cells.
    const byId = new Map(sweep().map(s => [s.id, s.passes.map(key)]))
    for (const id of DENSE_L1_PRIORITY) {
      expect(byId.get(id), `level $${id.toString(16)}`).toContain('l1.0')
      expect(byId.get(id), `level $${id.toString(16)}`).toContain('l1.1')
    }
  })

  it('level $10A puts its OBJ.1 sprites behind both Layer-1 phases', () => {
    // $10A is both the densest L1-priority level and one of the 17 that
    // carry an OBJ.1 sprite, so it exercises the bug on real level data:
    // the old fixed order drew those sprites after l1.0.
    const passes = sweep()
      .find(s => s.id === 0x10a)!
      .passes.map(key)
    expect(passes).toContain('sprites.1')
    expect(passes.indexOf('sprites.1')).toBeLessThan(passes.indexOf('l1.0'))
    expect(passes.indexOf('sprites.1')).toBeLessThan(passes.indexOf('l2.0'))
  })

  it('locks the measured live-pass histogram', () => {
    // 2 passes on 294 levels, 3 on 83, 4 on 112, 5 on 19, 6 on 3, 7 on one
    // ($1E2). The ceiling is 7, not 5: BG3's two phases are separate
    // passes at separate stack positions rather than two positions for one
    // layer, and sprites split three ways.
    const hist = new Map<number, number>()
    for (const { passes } of sweep()) hist.set(passes.length, (hist.get(passes.length) ?? 0) + 1)
    expect([...hist.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [2, 294],
      [3, 83],
      [4, 112],
      [5, 19],
      [6, 3],
      [7, 1],
    ])
  })

  it('every sprite on the cart resolves to a priority in 0..3', () => {
    const rom = SmwRom.open(ROM_PATH)
    const sources = new Map<string, number>()
    for (let id = 0; id < 512; id++) {
      for (const s of buildMap(rom, id).sprites) {
        expect(
          s.priority.value,
          `level $${id.toString(16)} sprite $${s.id.toString(16)}`,
        ).toBeGreaterThanOrEqual(0)
        expect(s.priority.value).toBeLessThanOrEqual(3)
        sources.set(s.priority.source, (sources.get(s.priority.source) ?? 0) + 1)
      }
    }
    // No placement on the vanilla cart lands on the runtimeGated path; see
    // docs/rom/obj-priority.md section 3 for why, and the synthetic cover.
    expect(sources.get('runtimeGated')).toBeUndefined()
    expect(sources.get('handler')).toBe(24)
    expect(sources.get('level')).toBe(3252)
  })
})
