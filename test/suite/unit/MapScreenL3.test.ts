/**
 * Layer 3 on the map tab (#561, #562): the gate (`buildL3Verdict`), the drawing
 * (`drawL3Planes`), the per-screen plane lists and the wire. Synthetic ROMs
 * and inputs throughout, so CI needs no cart; the corpus sweep at the end
 * compares every vanilla map's verdict with a straight decode of its header
 * and the mode tables.
 */
import { describe, it, expect } from 'vitest'
import type { RgbaColor } from '../../../src/rom/GraphicsDecoder'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { withCrusher } from '../../../src/rom/L3CodeGate'
import { buildL3Verdict, type L3Inputs, type L3Verdict } from '../../../src/rom/model/L3Model'
import {
  drawL3Planes,
  screenResult,
  type MapInputs,
} from '../../../theia/extension/src/node/map-screen'
import { MAP_PLANE_KEYS } from '../../../theia/extension/src/common/project-protocol'
import { composeScreen } from '../../../src/rom/model/ColorMath'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { COLORS, hGrid, inputs, px, sub, tile } from '../support/mapInputs'
import { modeTablesRom, STANDARD_MODES, sweepLayouts, withLayer3 } from '../support/l3Rom'
import type { ModeLayout } from '../../../src/rom/LevelScreenTables'
import {
  FALLBACK_SCREENS,
  screenPlanes,
  type ScreenPlanes,
} from '../../../src/rom/model/ScreenPlanes'

const BG_OK = { ok: true as const, mode: 1 }
const GATE_OK = { ok: true as const }
const chars = () => [0, 1, 2, 3].map(() => Array.from({ length: 128 }, (_, i) => new Uint8Array(64).fill(i % 4))) // prettier-ignore
/** Char 2 in palette 1: BG3's color index 6, [6, 100, 200]. L1's tile 1 top-left is color 1, L2's palette-2 char 3 is 35. */
const L3_WORD = (high: boolean) => (high ? 0x2000 : 0) | (1 << 10) | 2
const headerOf = (mode: number, tileset: number, priority: boolean) => parseLevelHeader([0, mode, priority ? 0x80 : 0, 0, tileset]) // prettier-ignore
const l1Of = (mode: number, tileset: number, priority: boolean) => ({ ...inputs(hGrid(1), false, 1, tileset), header: headerOf(mode, tileset, priority) }) // prettier-ignore
const decode = (b64: string | null) => (b64 === null ? null : new Uint8ClampedArray(Buffer.from(b64, 'base64'))) // prettier-ignore
const word = (row: number, col: number, w: number): [number, number, number] => [row, col, w]

/** An L3 whose tiles are given as [row, col, word]; row 8 at Layer3YPos $40 is level Y 0. */
const l3Of = (words: [number, number, number][], o: Partial<L3Inputs> = {}): L3Inputs => {
  const tilemap = new Uint16Array(64 * 64)
  for (const [r, c, w] of words) tilemap[r * 64 + c] = w
  return { tilemap, chars: chars(), colors: COLORS, yPx: 0x40, camYPx: 0, tide: false, ...o }
}
const verdict = (priority: boolean, l3: L3Inputs | null, screens: ScreenPlanes = screenPlanes(0x15, 0x02, priority)): L3Verdict => ({ screens, cgadsub: 0x20, layer2Interactive: false, priority, l3, reason: l3 ? null : 'none' }) // prettier-ignore
const wireOf = (m: MapInputs, screen = 0) => {
  const w = screenResult(m, screen)
  if (w.status !== 'ok') throw new Error(w.status)
  return w
}
/** What the view shows at a pixel: the payload's lists and math through composeScreen, as the widget runs it. Red channel, or null where nothing shows. */
const shown = (m: MapInputs, x = 3, y = 3): number | null => {
  const w = wireOf(m)
  const planes = Object.fromEntries(MAP_PLANE_KEYS.map(k => [k, decode(w.planes[k])]))
  const out = composeScreen({ width: w.width, height: w.height, planes, lists: w.screens, math: w.math }) // prettier-ignore
  const p = px(out, w.width, x, y)
  return p[3] === 255 ? p[0]! : null
}
const L1_COLOR = 1
const L3_COLOR = 6
/** Layer 2's color after the 5-bit round trip the math stage applies to a sub-screen pixel. */
const L2_COLOR = ((35 >> 3) << 3) | (35 >> 5)
const solid2 = (priority: boolean) => tile(2, [sub(3, 2, priority), sub(3, 2, priority), sub(3, 2, priority), sub(3, 2, priority)]) // prettier-ignore
const rom5 = () => withLayer3(modeTablesRom(sweepLayouts()), { level: 5, tileset: 0, setting: 2, settingsByte: 2, word: L3_WORD(true) }) // prettier-ignore

describe('layer 3 gate, every level mode (synthetic header and mode tables)', () => {
  it('draws layer 3 iff the special setting is zero; otherwise a reason, no pixels, no math', () => {
    const rom = rom5()
    const layouts = sweepLayouts()
    const drawn: number[] = []
    for (let mode = 0; mode < 32; mode++) {
      const v = buildL3Verdict(rom, 5, l1Of(mode, 0, true), BG_OK, chars, GATE_OK)
      if (v.l3) drawn.push(mode)
      else expect(v.reason, `mode ${mode}`).toMatch(/Layer 3 not drawn/)
      const w = wireOf({ ...l1Of(mode, 0, true), l3: v })
      expect([w.planes.l3Low, w.planes.l3High].some(p => p !== null), `mode ${mode} pixels`).toBe(v.l3 !== null) // prettier-ignore
    }
    expect(drawn).toEqual(layouts.flatMap((l, m) => (l.special === 0 ? [m] : [])))
    expect(drawn.length).toBeGreaterThan(STANDARD_MODES.length) // non-standard layouts draw now
  })

  it('names the reason: Mode 7 room, no layer 3 on the map, an unverified BG mode', () => {
    const rom = rom5()
    const special = sweepLayouts().findIndex(l => l.special !== 0)
    expect(buildL3Verdict(rom, 5, l1Of(special, 0, false), BG_OK, chars, GATE_OK).reason).toMatch(/Mode 7/) // prettier-ignore
    expect(buildL3Verdict(rom, 6, l1Of(0, 0, false), BG_OK, chars, GATE_OK)).toMatchObject({ l3: null, reason: 'This map has no layer 3' }) // prettier-ignore
    const bg = buildL3Verdict(rom, 5, l1Of(0, 0, false), { ok: false, reason: 'hooked' }, chars, GATE_OK) // prettier-ignore
    expect(bg).toMatchObject({ l3: null, reason: 'Layer 3 not drawn: hooked', cgadsub: null })
  })

  it('the header bit is carried as read, never forced', () => {
    const bits = [true, false].map(b => buildL3Verdict(rom5(), 5, l1Of(0, 0, b), BG_OK, chars, GATE_OK).priority) // prettier-ignore
    expect(bits).toEqual([true, false])
  })
})

describe('layer 3 against layers 1 and 2 (synthetic)', () => {
  /** L1 tile 1 at cell (0,0), or with `l2` L2's tile 2 there instead and L1 empty. */
  const mapOf = (v: L3Verdict, l2?: boolean): MapInputs => {
    const m: MapInputs = {
      ...inputs(hGrid(1), false, 1),
      header: headerOf(0, 0, v.priority),
      l3: v,
    }
    m.grid[0]![0] = 1
    if (l2) {
      m.map16.tiles[2] = solid2(false)
      const g = hGrid(1).map(r => r.map(() => null as number | null))
      g[0]![0] = 2
      m.l2 = { ok: true, l2: { kind: 'objects', grid: g, tiles: m.map16.tiles, dy: 0 } }
      m.grid[0]![0] = 0
    }
    return m
  }
  const tileAt = (high: boolean) => l3Of([word(8, 0, L3_WORD(high))])

  it('priority bit set: a high-priority layer 3 tile covers the layer 1 tile under it', () => {
    expect(shown(mapOf(verdict(true, tileAt(true))))).toBe(L3_COLOR)
  })

  it('priority bit clear: the layer 1 tile covers a high-priority layer 3 tile', () => {
    expect(shown(mapOf(verdict(false, tileAt(true))))).toBe(L1_COLOR)
  })

  it('a low-priority layer 3 tile is under layer 1 whichever way the bit is set', () => {
    for (const bit of [true, false]) expect(shown(mapOf(verdict(bit, tileAt(false)))), `bit ${bit}`).toBe(L1_COLOR) // prettier-ignore
  })

  it('on the standard layout an opaque low-priority layer 3 pixel covers layer 2, whatever layer 2 priority', () => {
    const m = mapOf(verdict(false, tileAt(false)), true)
    expect(shown(m)).toBe(L3_COLOR)
    m.l2 = { ok: true, l2: { ...(m.l2 as { ok: true; l2: never }).l2, tiles: [undefined, undefined, solid2(true)] } } // prettier-ignore
    expect(shown(m)).toBe(L3_COLOR)
    expect(shown(m, 100, 100), 'nothing where no layer draws').toBeNull()
  })

  it('layer 2 shows where layer 3 and layer 1 are clear, and is under layer 1 even with its priority bit set', () => {
    const m = mapOf(verdict(false, l3Of([word(8, 1, L3_WORD(false))])), true) // layer 3 one tile right
    expect(shown(m)).toBe(L2_COLOR)
    m.grid[0]![0] = 1
    m.l2 = { ok: true, l2: { ...(m.l2 as { ok: true; l2: never }).l2, tiles: [undefined, undefined, solid2(true)] } } // prettier-ignore
    expect(shown(m)).toBe(L1_COLOR)
  })

  it('mode 0C (CGADSUB $70) with a non-black back area: layer 2 halved, the back area where nothing draws', () => {
    const l3 = { ...verdict(false, null), cgadsub: 0x70 }
    const m = mapOf(l3, true) // layer 2 at (3, 3); the fixture's back area is not black
    expect(m.backArea.slice(0, 3)).not.toEqual([0, 0, 0])
    expect(shown(m)).toBe(((35 >> 3) >> 1) * 8) // 4 halved is 2, expanded: (2 << 3) | (2 >> 2)
    expect(shown(m, 100, 100)).toBeNull() // transparent: the view's back area layer shows
  })

  it('no verdict (unverified tables) keeps the old order: layer 2 high over layer 1 low', () => {
    const m = mapOf(verdict(false, null, FALLBACK_SCREENS), true)
    m.grid[0]![0] = 1
    m.l2 = { ok: true, l2: { ...(m.l2 as { ok: true; l2: never }).l2, tiles: [undefined, undefined, solid2(true)] } } // prettier-ignore
    expect(shown(m)).toBe(35) // no math: the plane's own pixel, not re-quantized
  })
})

describe('the wire: screens, math, layer 2 role (synthetic)', () => {
  it('carries both plane lists, the math and the layer 2 role', () => {
    const l3 = { ...verdict(false, l3Of([word(8, 0, L3_WORD(true))]), screenPlanes(0x04, 0x13, false)), cgadsub: 0x20, layer2Interactive: true } // prettier-ignore
    const m = { ...l1Of(0, 0, false), l3 }
    const w = wireOf(m)
    expect(w.screens).toEqual(screenPlanes(0x04, 0x13, false))
    // The fixed color is the back area: the same BackAreaColors entry (bank_00.asm:5623-5628).
    expect(m.backArea.slice(0, 3)).not.toEqual([0, 0, 0])
    expect(w.math).toEqual({ cgadsub: 0x20, fixed: m.backArea.slice(0, 3) })
    expect(w.layer2Interactive).toBe(true)
    expect('layout' in w.layer3).toBe(false)
  })
  it('no verdict: fallback lists and math null, the pre-#561 stacking', () => {
    const w = wireOf({ ...l1Of(0, 0, false), l3: undefined })
    expect(w).toMatchObject({ screens: FALLBACK_SCREENS, math: null, layer2Interactive: false })
  })
  it('a verdict with no math sends none even when it has lists', () => {
    const l3 = { ...verdict(false, null), cgadsub: null }
    expect(wireOf({ ...l1Of(0, 0, false), l3 }).math).toBeNull()
  })
  it('the standard layout keeps the #561 sub list for both priority bits', () => {
    for (const pri of [true, false]) {
      expect(wireOf({ ...l1Of(0, 0, pri), l3: verdict(pri, null) }).screens.sub).toEqual(['l2Low', 'l2High']) // prettier-ignore
    }
  })
})

describe('buildL3Verdict: screens, math and the layer 2 role', () => {
  const rom = (layout: Partial<ModeLayout>, mode = 5) =>
    withLayer3(
      modeTablesRom(sweepLayouts().map((l, m) => (m === mode ? { ...l, ...layout } : l))),
      { level: 5, tileset: 0, setting: 2, settingsByte: 0x02, word: L3_WORD(false) },
    )
  const v = (r: RomFile, mode = 5, pri = false) =>
    buildL3Verdict(r, 5, l1Of(mode, 0, pri), BG_OK, chars, GATE_OK)
  const MODE_0E_SCREENS = { main: ['l3Low', 'l3High'], sub: ['l2Low', 'l1Low', 'l2High', 'l1High'] }

  it('mode 0E style: BG3 alone on main, BG1 and BG2 on sub, CGADSUB minus BG3', () => {
    const r = v(rom({ main: 0x04, sub: 0x13, cgadsub: 0x24, special: 0, vertical: 0 }))
    expect(r.screens).toEqual(MODE_0E_SCREENS)
    expect(r.cgadsub).toBe(0x20)
    expect(r.l3).not.toBeNull()
  })
  it('an interactive mode draws layer 3 (the #561 refusal is gone) and reports layer 2 interactive', () => {
    const r = v(rom({ main: 0x17, sub: 0x00, special: 0, vertical: 0x80 }))
    expect(r).toMatchObject({ reason: null, layer2Interactive: true })
    expect(r.screens.main).toEqual(['l3Low', 'l3High', 'l2Low', 'l1Low', 'l2High', 'l1High'])
  })
  it('mode 11 style: BG2 on main but not interactive, math kept minus BG3', () => {
    const r = v(rom({ main: 0x17, sub: 0x00, cgadsub: 0xff, special: 0, vertical: 0 }))
    expect(r.layer2Interactive).toBe(false)
    expect(r.cgadsub).toBe(0xfb)
  })
  it('a special-setting (Mode 7) mode: refused, old order, no math, role not claimed', () => {
    const r = v(rom({ special: 0xc0, vertical: 0x80 }))
    expect(r).toMatchObject({ l3: null, cgadsub: null, screens: FALLBACK_SCREENS })
    expect(r.layer2Interactive).toBe(false)
    expect(r.reason).toMatch(/Layer 3 not drawn/)
  })
  it('layer 2 role does not depend on layer 3 drawing (no layer 3 on the map)', () => {
    const r = buildL3Verdict(
      rom({ main: 0x17, sub: 0x00, vertical: 0x80 }),
      6,
      l1Of(5, 0, false),
      BG_OK,
      chars,
      GATE_OK,
    )
    expect(r).toMatchObject({ l3: null, layer2Interactive: true, cgadsub: 0x20 })
  })
  it('unreadable mode tables (a hooked loader): fallback order, no math, no throw', () => {
    const blank = new RomFile('x.sfc', Buffer.alloc(0x80000))
    const r = buildL3Verdict(blank, 5, l1Of(0, 0, false), BG_OK, chars, GATE_OK)
    expect(r).toMatchObject({ cgadsub: null, screens: FALLBACK_SCREENS, layer2Interactive: false })
  })
  it('camera-locked layer 3 keeps BG3 in CGADSUB (not drawn; #563 inherits this)', () => {
    const locked = withLayer3(modeTablesRom(sweepLayouts()), { level: 5, tileset: 0, setting: 2, settingsByte: 0x81, word: L3_WORD(false) }) // prettier-ignore
    const r = buildL3Verdict(locked, 5, l1Of(0, 0, false), BG_OK, chars, GATE_OK)
    expect(r.reason).toMatch(/camera-locked/)
    expect(r.cgadsub! & 0x04).toBe(0x04)
  })
  it('settings byte $00 off tilesets 1 and 3 is camera-locked but BG3 is still cleared (CODE_00A01B)', () => {
    const rom0 = withLayer3(modeTablesRom(sweepLayouts()), { level: 5, tileset: 0, setting: 2, settingsByte: 0x00, word: L3_WORD(false) }) // prettier-ignore
    const r = buildL3Verdict(rom0, 5, l1Of(0, 0, false), BG_OK, chars, GATE_OK)
    expect(r.reason).toMatch(/camera-locked/)
    expect(r.cgadsub! & 0x04).toBe(0)
  })
  it('planted defect: tables read with main and sub swapped fail the mode 0E assertions', () => {
    const swapped = rom({ main: 0x13, sub: 0x04, cgadsub: 0x24, special: 0, vertical: 0 })
    expect(v(swapped).screens).not.toEqual(MODE_0E_SCREENS)
  })
})

describe('camera-locked layer 3 (synthetic settings bytes)', () => {
  const romFor = (tileset: number, byte: number) =>
    withLayer3(modeTablesRom(sweepLayouts()), { level: 5, tileset, setting: 2, settingsByte: byte, word: L3_WORD(false), row: 24 }) // prettier-ignore

  it('$81 and $BF are skipped on a tileset other than Castle1 and Underground1', () => {
    for (const byte of [0x81, 0xbf]) {
      for (const ts of [0, 2, 4, 15]) {
        const v = buildL3Verdict(romFor(ts, byte), 5, l1Of(0, ts, false), BG_OK, chars, GATE_OK)
        expect(v, `byte ${byte} tileset ${ts}`).toMatchObject({ l3: null, reason: /camera-locked/ })
      }
    }
  })

  it('on Castle1 and Underground1 they are drawn at the fixed Y, $C0', () => {
    for (const byte of [0x81, 0xbf]) {
      for (const ts of [1, 3]) {
        const v = buildL3Verdict(romFor(ts, byte), 5, l1Of(0, ts, false), BG_OK, chars, GATE_OK)
        expect(v.l3?.yPx, `byte ${byte} tileset ${ts}`).toBe(0xc0)
        // Tile row 24 at Y $C0 is level Y 0: the tile's pixel is on screen at the top left.
        const m: MapInputs = {
          ...inputs(hGrid(1), false, 1, ts),
          header: headerOf(0, ts, false),
          l3: v,
        }
        expect(shown(m), `byte ${byte} tileset ${ts}`).toBe(L3_COLOR)
      }
    }
  })
})

describe('drawL3Planes (synthetic)', () => {
  const alpha = (b: Uint8ClampedArray | null, x: number, y: number, w = 256) => (b ? px(b, w, x, y)[3] : null) // prettier-ignore

  it('a tile word lands in the plane its priority bit names, at the tile row Y and the level X', () => {
    const p = drawL3Planes(l3Of([word(8, 0, L3_WORD(false)), word(10, 2, L3_WORD(true))]), 0)
    expect([alpha(p.l3Low, 3, 3), alpha(p.l3High, 3, 3)]).toEqual([255, 0]) // row 8 -> y 0
    expect([alpha(p.l3High, 19, 19), alpha(p.l3Low, 19, 19)]).toEqual([255, 0]) // row 10, col 2 -> (16, 16)
  })

  it('the status-bar rows are not drawn', () => {
    const p = drawL3Planes(l3Of([word(3, 0, L3_WORD(false))], { yPx: 0 }), 0)
    expect([p.l3Low, p.l3High]).toEqual([null, null])
  })

  it('a non-tide repeats every 512 px, a tide every 256 px over its first 32 columns', () => {
    const w = [word(8, 0, L3_WORD(false))]
    expect([2, 1, 4].map(s => drawL3Planes(l3Of(w), s).l3Low !== null)).toEqual([true, false, true]) // prettier-ignore
    expect([1, 2].map(s => drawL3Planes(l3Of(w, { tide: true }), s).l3Low !== null)).toEqual([true, true]) // prettier-ignore
  })

  it("a tide's second copy of its tilemap is not drawn", () => {
    // Rows 8-9 hold a pattern, rows 12-13 the same chars again: the copy starts at 12.
    const pair = (r: number) => [word(r, 0, L3_WORD(false)), word(r + 1, 1, L3_WORD(false))]
    const p = drawL3Planes(l3Of([...pair(8), ...pair(12)], { tide: true }), 0).l3Low!
    expect([alpha(p, 3, 3), alpha(p, 11, 8 + 3), alpha(p, 3, 4 * 8 + 3)]).toEqual([255, 255, 0])
  })

  it('Layer1YPos at load moves every row down, and the pixel keeps its own color', () => {
    const p = drawL3Planes(l3Of([word(8, 0, L3_WORD(false))], { camYPx: 0x30 }), 0).l3Low!
    expect([alpha(p, 3, 3), alpha(p, 3, 0x30 + 3), alpha(p, 3, 0x30 + 8)]).toEqual([0, 255, 0])
    expect(px(p, 256, 3, 0x30 + 3)[0]).toBe(L3_COLOR)
  })

  it('palettes above 3 select their own CGRAM colors (palette P is P*4 + color)', () => {
    for (const pal of [3, 4, 5, 7]) {
      const p = drawL3Planes(l3Of([word(8, 0, (pal << 10) | 2)]), 0).l3Low!
      expect(px(p, 256, 3, 3)[0], `palette ${pal}`).toBe(pal * 4 + 2)
    }
  })

  it('a pixel in palette 3 of a crusher level is the table color, not the level palette', () => {
    const crusher: RgbaColor[] = [
      [0, 0, 0, 0],
      [1, 2, 3, 255],
      [4, 5, 6, 255],
      [7, 8, 9, 255],
    ]
    for (const v of [1, 2, 3]) {
      const asym = chars()
      asym[0]![2] = new Uint8Array(64).fill(v)
      const l3 = l3Of([word(8, 0, (3 << 10) | 2)], {
        chars: asym,
        colors: withCrusher(COLORS, crusher),
      })
      expect(px(drawL3Planes(l3, 0).l3Low!, 256, 3, 3), `color ${v}`).toEqual(crusher[v])
    }
  })

  it('X and Y flips mirror the char', () => {
    const asym = chars()
    asym[0]![2] = Uint8Array.from({ length: 64 }, (_, i) => (i === 0 ? 2 : 0)) // only the top-left pixel
    const flipped = (flags: number) => drawL3Planes(l3Of([word(8, 0, L3_WORD(false) | flags)], { chars: asym }), 0).l3Low! // prettier-ignore
    expect([alpha(flipped(0), 0, 0), alpha(flipped(0x4000), 7, 0), alpha(flipped(0x8000), 0, 7), alpha(flipped(0xc000), 7, 7)]).toEqual([255, 255, 255, 255]) // prettier-ignore
    expect(alpha(flipped(0x4000), 0, 0)).toBe(0)
  })
})

describe('maps layer 3 is not drawn on (synthetic)', () => {
  it('a vertical map says so, whatever else would draw', () => {
    const l1 = { ...l1Of(3, 0, false), isVertical: true } // mode 3: standard layout, vertical
    expect(buildL3Verdict(rom5(), 5, l1, BG_OK, chars, GATE_OK)).toMatchObject({ l3: null, reason: 'Layer 3 not drawn yet: vertical maps' }) // prettier-ignore
  })

  it('settings $00 follows the camera off Castle1 and Underground1, like $81', () => {
    const rom = (ts: number) => withLayer3(modeTablesRom(sweepLayouts()), { level: 5, tileset: ts, setting: 2, settingsByte: 0x00, word: L3_WORD(false) }) // prettier-ignore
    for (const ts of [0, 2, 5]) expect(buildL3Verdict(rom(ts), 5, l1Of(0, ts, false), BG_OK, chars, GATE_OK), `tileset ${ts}`).toMatchObject({ l3: null, reason: /camera-locked/ }) // prettier-ignore
    for (const ts of [1, 3]) expect(buildL3Verdict(rom(ts), 5, l1Of(0, ts, false), BG_OK, chars, GATE_OK).l3?.yPx, `tileset ${ts}`).toBe(0x70) // prettier-ignore
  })
})

describe('tide or not, by the settings byte (synthetic)', () => {
  const verdictFor = (byte: number, ts = 0) => buildL3Verdict(withLayer3(modeTablesRom(sweepLayouts()), { level: 5, tileset: ts, setting: 2, settingsByte: byte, word: L3_WORD(false), row: 30 }), 5, l1Of(0, ts, false), BG_OK, chars, GATE_OK) // prettier-ignore

  it('$02, $50 and $7F are tides (256 px repeat); $80 and $C0 are not (512 px)', () => {
    expect([0x02, 0x50, 0x7f, 0x80, 0xc0].map(b => verdictFor(b).l3?.tide)).toEqual([true, true, true, false, false]) // prettier-ignore
    const repeats = (b: number) =>
      [1, 2].map(sc => drawL3Planes(verdictFor(b).l3!, sc).l3Low !== null) // row 8, col 0
    expect(repeats(0x50)).toEqual([true, true])
    expect(repeats(0x80)).toEqual([false, true])
  })

  it('$00 is no tide: on Castle1 it repeats every 512 px and keeps its whole tilemap, like $80', () => {
    expect([1, 3].map(ts => verdictFor(0x00, ts).l3?.tide)).toEqual([false, false])
    expect([1, 2].map(sc => drawL3Planes(verdictFor(0x00, 1).l3!, sc).l3Low !== null)).toEqual([
      false,
      true,
    ]) // row 30 col 0
  })

  it('the wire carries the header priority bit as read, both ways', () => {
    for (const bit of [true, false]) {
      const l3 = verdict(bit, l3Of([word(8, 0, L3_WORD(true))]))
      expect(wireOf({ ...l1Of(0, 0, bit), l3 }).layer3.priority).toBe(bit)
    }
  })
})

/** Straight decode of the header and the vanilla tables by address, no gate between. */
describe.skipIf(!hasRom(VANILLA))(
  'every vanilla map: renderer verdict equals a straight decode (corpus)',
  () => {
    /** An independent mask-to-keys loop over the hand-written mode 1 order (not ScreenPlanes). */
    const keys = (mask: number, pri: boolean) =>
      (pri
        ? ['l3Low', 'l2Low', 'l1Low', 'l2High', 'l1High', 'l3High']
        : ['l3Low', 'l3High', 'l2Low', 'l1Low', 'l2High', 'l1High']
      ).filter(k => mask & ({ l1: 1, l2: 2, l3: 4 } as Record<string, number>)[k.slice(0, 2)]!)

    it('priority bit, plane lists, math and skip decision agree on every slot', () => {
      const rom = RomFile.load(romPath(VANILLA))
      const smw = new SmwRom(rom)
      const tbl = (a: number) => Array.from(rom.readAt(a, 32)!)
      const [main, sub2, cgadsub, special, vertical] = [0x058437, 0x058457, 0x058477, 0x058497, 0x058417].map(tbl) // prettier-ignore
      const seen = { checked: 0, drawn: 0, noLayer3: 0, locked: 0, special: 0 }
      const drew: Record<number, boolean> = {}
      for (let id = 0; id < 512; id++) {
        const raw = smw.getLevelRawData(id)
        if (!raw) continue
        const header = parseLevelHeader(raw)
        const mode = header.levelMode
        const setting = (rom.readByte(0x05f200 + id)! & 0xc0) >> 6
        const byte = setting ? rom.readByte(0x009f88 + header.objectTileset * 3 + setting - 1)! : 0
        const locked = setting > 0 && (byte & 0xc0) === 0x80 && (byte & 0x3f) !== 0 && header.objectTileset !== 1 && header.objectTileset !== 3 // prettier-ignore
        const v = buildL3Verdict(rom, id, { header, isVertical: false, colors: [] }, BG_OK)
        const pri = (raw[2]! & 0x80) !== 0
        expect([id, v.priority]).toEqual([id, pri])
        if (special![mode] !== 0) {
          expect([id, v.l3, v.cgadsub]).toEqual([id, null, null])
          seen.special++
        } else {
          expect([id, v.screens]).toEqual([id, { main: keys(main![mode]!, pri), sub: keys(sub2![mode]!, pri) }]) // prettier-ignore
          expect([id, v.layer2Interactive]).toEqual([id, (vertical![mode]! & 0x80) !== 0])
          expect([id, v.cgadsub! & 0x04]).toEqual([id, locked ? cgadsub![mode]! & 0x04 : 0])
          expect([id, v.cgadsub! & ~0x04]).toEqual([id, cgadsub![mode]! & ~0x04])
          expect([id, v.l3 !== null]).toEqual([id, setting > 0 && !locked])
          if (setting === 0) seen.noLayer3++
          else if (locked) seen.locked++
          else seen.drawn++
        }
        drew[id] = v.l3 !== null
        seen.checked++
      }
      expect(seen.checked).toBeGreaterThan(400)
      expect(seen.drawn + seen.noLayer3 + seen.locked + seen.special).toBe(seen.checked)
      expect(seen.drawn).toBeGreaterThan(0)
      // Named maps (vanilla, 2026-10-05 probe): $009, $0E7 and $1CE draw; $018 is camera-locked,
      // $10E and $1BD have no layer 3.
      for (const id of [0x009, 0x0e7, 0x1ce]) expect([id, drew[id]]).toEqual([id, true])
      for (const id of [0x018, 0x10e, 0x1bd]) expect([id, drew[id]]).toEqual([id, false])
      console.log('layer 3 corpus sweep', JSON.stringify(seen))
    }, 60_000)
  },
)
