/**
 * The map tab's sprite layer draws from the interpreter (#585, step 3 of
 * #582): `interpParts` / `modelResult` / `cameraFor` are synthetic (CI has no
 * ROM); the corpus block runs the real thing over vanilla maps and lays it
 * beside the table engine, which stays only as that oracle until step 4.
 */
import { describe, it, expect } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { parseLevelSprites } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { readMarioStartPos } from '../../../src/rom/L3Loader'
import type { SpriteModel, SpritePart } from '../../../src/rom/sprites/interp/SpriteRunner'
import {
  cameraFor,
  drawSprites,
  engineDrawer,
  interpDrawer,
  interpParts,
  mapSprites,
  modelResult,
  partKey,
  type SpriteDrawer,
} from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { COLORS } from '../support/mapInputs'

const part = (o: Partial<SpritePart>): SpritePart => ({ oam: 0, char: 0, size: 8, palette: 9, priority: 2, flipX: false, flipY: false, dx: 0, dy: 0, attr: 0, ox: 0, oy: 0, ...o }) // prettier-ignore
const model = (o: Partial<SpriteModel>): SpriteModel => ({ id: 1, passes: [], dependsOn: [], steps: [], ...o }) // prettier-ignore

describe('interpParts', () => {
  it('draws a 16 x 16 entry as four chars (tile, +1, +$10, +$11) and an 8 x 8 as one, at $400 + char', () => {
    const got = interpParts([part({ char: 0x20, size: 16, dx: -4, dy: -8 }), part({ oam: 1, char: 0x7, dx: 3, dy: 1 })]) // prettier-ignore
    const key = (c: number, dx: number, dy: number) => ({ charNum: c, dx, dy })
    expect(got.map(p => key(p.charNum, p.dx, p.dy))).toEqual([
      key(0x407, 3, 1),
      key(0x420, -4, -8),
      key(0x421, 4, -8),
      key(0x430, -4, 0),
      key(0x431, 4, 0),
    ])
  })

  it('a flip swaps which char of a 16 x 16 entry lands where, and the name table bit reaches $500', () => {
    const got = interpParts([part({ char: 0x100, size: 16, flipX: true, flipY: true })])
    const at = (dx: number, dy: number) => got.find(p => p.dx === dx && p.dy === dy)!.charNum
    // flipX + flipY: the bottom-right char sits top-left.
    expect([at(0, 0), at(8, 0), at(0, 8), at(8, 8)]).toEqual([0x511, 0x510, 0x501, 0x500])
    expect(got.every(p => p.flipX && p.flipY)).toBe(true)
  })

  it('puts the lower OAM index last, so it wins an overlap when blitted in order', () => {
    expect(interpParts([part({ oam: 2, char: 1 }), part({ oam: 0, char: 2 })]).map(p => p.charNum)).toEqual([0x401, 0x402]) // prettier-ignore
  })
})

describe('modelResult', () => {
  it('serves the chosen pass at the anchor INIT left, and says why when there is nothing to draw', () => {
    const passes = [
      { pass: 0, pos: { x: 0, y: 0 }, parts: [], uploads: [] },
      { pass: 1, pos: { x: 0, y: 0 }, parts: [part({ char: 5, dx: 2 })], uploads: [] },
      { pass: 2, pos: { x: 0, y: 0 }, parts: [part({ char: 9 })], uploads: [] },
    ]
    const r = modelResult(
      model({ anchor: { x: 104, y: 51, rawX: 96, rawY: 52 }, passes, chosen: 1 }),
    )
    expect(r).toMatchObject({ ok: true, anchor: { x: 104, y: 51 } })
    expect(r.ok && r.parts.map(p => p.charNum)).toEqual([0x405])
    expect(modelResult(model({ refusal: 'step budget spent' }))).toEqual({ ok: false, reason: 'refused: step budget spent' }) // prettier-ignore
    expect(modelResult(model({ emptyReason: 'drew no OAM tile' }))).toEqual({ ok: false, reason: 'drew no OAM tile' }) // prettier-ignore
  })
})

describe('cameraFor', () => {
  it('centres the sprite and clamps to the scroll range, horizontal and vertical', () => {
    expect(cameraFor(1000, 300, false, 20)).toEqual({ x: 872, y: 188 })
    expect(cameraFor(10, 10, false, 20)).toEqual({ x: 0, y: 0 })
    expect(cameraFor(9000, 430, false, 20)).toEqual({ x: 4864, y: 208 })
    expect(cameraFor(500, 700, true, 3)).toEqual({ x: 256, y: 544 })
  })
})

describe('drawSprites with the interpreter', () => {
  it('draws at the anchor the drawer reports, not the stream position, and keeps the reason of a refusal', () => {
    const s = { index: 0, x: 2, y: 2, spriteId: 0x4f, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as LevelSprite // prettier-ignore
    const chars = { sp1: [new Uint8Array(64).fill(3)] }
    const ok: SpriteDrawer = () => ({ ok: true, anchor: { x: 40, y: 31 }, parts: [{ charNum: 0x400, palette: 9, flipX: false, flipY: false, dx: 0, dy: 0 }], identity: { spriteId: 0x4f, mainHandler: 0, initHandler: 0, status: 'vanilla' } }) // prettier-ignore
    const [a] = drawSprites([s], { vram: chars, colors: COLORS }, ok)
    expect(a).toMatchObject({
      x: 40,
      y: 31,
      status: 'drawn',
      box: { x0: 40, y0: 31, x1: 48, y1: 39 },
    })
    const [b] = drawSprites([s], { vram: chars, colors: COLORS }, () => ({
      ok: false,
      reason: 'refused: loop',
    }))
    expect(b).toMatchObject({ status: 'placeholder', reason: 'refused: loop', x: 32, y: 32 })
  })
})

/**
 * The known engine-vs-interpreter list over MAPS below (vanilla, one machine,
 * 62 sprites the engine draws): 25 agree exactly, 36 differ, 1 the interpreter
 * draws no tile for in 64 passes ($4D).
 */
const EXPECTED: Record<string, Record<string, number>> = {
  $00: { same: 1 },
  $01: { same: 1 },
  $02: { differ: 1 },
  $03: { differ: 1, same: 1 },
  $04: { differ: 3 },
  $05: { same: 9, differ: 12 },
  $06: { differ: 2, same: 3 },
  $0F: { same: 6 },
  $11: { differ: 5 },
  $13: { differ: 11 },
  $1F: { differ: 1 },
  $4D: { 'interp-miss': 1, same: 1 },
  $4E: { same: 3 },
}

describe.skipIf(!hasRom(VANILLA))('interpreter vs table engine on vanilla maps', () => {
  /** Maps holding every id the engine draws, plus the two the issue names. */
  const MAPS = [0x105, 0x106, 0x00f, 0x1c5, 0x008, 0x11b, 0x006, 0x1c2, 0x001, 0x11c]
  const bytes = () => new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)

  interface Row { map: number; id: number; at: string; verdict: 'same' | 'differ' | 'interp-miss'; e?: string; i?: string } // prettier-ignore

  /** Per sprite the engine draws: both sides' parts relative to their own anchor, order-free. */
  function compare(wrap: (d: SpriteDrawer) => SpriteDrawer = d => d): Row[] {
    const b = bytes()
    const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
    const rows: Row[] = []
    for (const map of MAPS) {
      const built = new L1ModelCache().get(b, romPath(VANILLA), map, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
      if (!built.ok) throw new Error(built.reason)
      const sprites = parseLevelSprites(rom.rom.readUpTo(rom.getLevelSpritePointer(map)!, 0x200)!, built.inputs.isVertical) // prettier-ignore
      const eng = engineDrawer(rom.rom, readMarioStartPos(rom.rom, map).x)!
      const interp = interpDrawer(rom.rom, map, built.inputs)
      if (typeof interp !== 'function') throw new Error(interp.reason)
      const both = wrap(interp)
      for (const s of sprites) {
        const e = eng(s)
        if (!e.ok || (s.raw[0]! & 8) !== 0) continue
        const g = both(s)
        const at = `${s.x * 16},${s.y * 16}`
        if (!g.ok) { rows.push({ map, id: s.spriteId, at, verdict: 'interp-miss' }); continue } // prettier-ignore
        const [ek, ik] = [
          e.parts.map(partKey).sort().join(';'),
          g.parts.map(partKey).sort().join(';'),
        ]
        rows.push({ map, id: s.spriteId, at, verdict: ek === ik ? 'same' : 'differ', e: ek, i: ik })
      }
    }
    return rows
  }

  const tally = (rows: Row[]) => {
    const out: Record<string, Record<string, number>> = {}
    for (const r of rows) {
      const k = `$${r.id.toString(16).toUpperCase().padStart(2, '0')}`
      out[k] ??= {}
      out[k]![r.verdict] = (out[k]![r.verdict] ?? 0) + 1
    }
    return out
  }

  it('lists where they disagree in parts relative to the anchor, and goes red when that list changes', () => {
    const rows = compare()
    const t = tally(rows)
    console.log(
      `engine vs interpreter over ${MAPS.length} maps, ${rows.length} sprites: ${JSON.stringify(t)}`,
    )
    for (const r of rows.filter(r => r.verdict !== 'same'))
      console.log(`${r.verdict} map ${r.map.toString(16)} id ${r.id.toString(16)} at ${r.at}\n  engine ${r.e}\n  interp ${r.i}`) // prettier-ignore
    // The known list. Every entry is the engine's still pose (frame 0) against the
    // interpreter's first drawing pass (a later walk-cycle frame or a facing), or
    // an id the interpreter draws nothing for. A new entry, or one that clears, fails here.
    expect(t).toEqual(EXPECTED)
  })

  it('goes red on a planted defect: one part shifted by a pixel is a disagreement', () => {
    const base = tally(compare())
    const planted = tally(
      compare(d => s => {
        const r = d(s)
        return r.ok ? { ...r, parts: r.parts.map(p => ({ ...p, dx: p.dx + 1 })) } : r
      }),
    )
    expect(planted).not.toEqual(base)
    expect(planted).not.toEqual(EXPECTED)
  })

  it('$4F on $105 is served at its stream position plus (8, -1): INIT moved it, not a table', () => {
    const b = bytes()
    const r = mapSprites(new L1ModelCache(), b, romPath(VANILLA), 0x105)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
    const raw = parseLevelSprites(rom.rom.readUpTo(rom.getLevelSpritePointer(0x105)!, 0x200)!, false).filter(s => s.spriteId === 0x4f) // prettier-ignore
    const served = r.sprites.filter(s => s.id === 0x4f)
    expect(served.map(s => [s.x, s.y])).toEqual([[1816, 335], [2232, 319], [4552, 319]]) // prettier-ignore
    expect(served.map(s => [s.x, s.y])).toEqual(raw.map(s => [s.x * 16 + 8, s.y * 16 - 1]))
    expect(served.every(s => s.status === 'drawn')).toBe(true)
  })

  it('counts drawn and marked sprites on $105 and $106, every marker with the interpreter reason', () => {
    const b = bytes()
    const got = [0x105, 0x106].map(m => {
      const r = mapSprites(new L1ModelCache(), b, romPath(VANILLA), m)
      if (r.status !== 'ok') throw new Error(JSON.stringify(r))
      for (const s of r.sprites.filter(s => s.status === 'placeholder')) expect(s.reason).toMatch(/^(refused: INIT: id \$[0-9a-f]+ is past|drew no OAM tile)/) // prettier-ignore
      return [r.sprites.filter(s => s.status === 'drawn').length, r.sprites.length]
    })
    expect(got).toEqual([
      [31, 34],
      [21, 25],
    ])
  })
})
