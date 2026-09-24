/**
 * MagikoopaAppearance - sprite $1F, SubSprGfx1 (16x32) + 8x8 wand.
 *
 * Test tree
 *   misc1602ForTimer      sweeps the state-2 countdown, and its domain guard
 *   topTileBobs           bank_01.asm:8530-8539 SBC/CMP/LSR branch
 *   wandVisible           bank_01.asm:8545-8547 CMP #$04 branch
 *   fromTables            tile selection, tile count, dy, flip, palette, wand
 *   render/tickAnimation  the rendered pose follows the $70 countdown tick by
 *                         tick, at exactly 7.5 ROM frames per tick
 *   palette               MagiKoopaPals spliced over CGRAM row 15 cols 0-7
 *   round-trip            serialize -> rehydrate keeps the runtime palette
 *   ROM                   the literal expectations above still match the cart
 *
 * Derivation lives in docs/sprites/sprite-1f-magikoopa.md. The short version: idx =
 * SprTilemapOffset[$1F] + SpriteMisc1602 * 2, top at (_0, _1) and bottom at
 * (_0, _1 + $10) (SubSprGfx1, bank_01.asm:3920); Magikoopa does NOT pre-shift
 * SpriteYPos, so dy is 0 / +16, not -16 / 0.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import {
  MagikoopaAppearance,
  misc1602ForTimer,
  topTileBobs,
  wandVisible,
  STATE2_MISC1602_VALUES,
  STATE2_TIMER_START,
} from '../../../../src/rom/model/sprites/appearances/MagikoopaAppearance'
import { SPRITE_ANIM_FRAME_STRIDE as ROM_FRAMES_PER_TICK } from '../../../../src/rom/timing'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { RenderTarget } from '../../../../src/rom/model/RenderTarget'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import type { SpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import { Sprite } from '../../../../src/rom/model/sprites/Sprite'
import { serializeSprite } from '../../../../src/rom/model/serialize'
import { buildSprite } from '../../../../src/rom/model/rehydrate'
import { MAGIKOOPA_PALS } from '../../../../src/rom/model/palette/DynSpritePalette'
import { makeTestMapStore } from '../fixtures/stores'
import { VANILLA, hasRom, romPath } from '../../support/corpus'

const STUB_BEHAVIOR: SpriteBehavior = { displayName: 'stub', spawns: false } as never

// ── ROM ground truth ─────────────────────────────────────────────────────────
// Every literal below was read out of the vanilla cart; the ROM-guarded block
// at the bottom re-reads each one and fails if the cart disagrees.

const TILEMAP_OFFSET_1F = 0x73 // SprTilemapOffset[$1F], ROM $01:9C9E
const ATTR_1F = 0x0f // Sprite166EVals[$1F] & $0F, ROM $07:F41D ($4F)
const PALETTE = 8 + ((ATTR_1F >> 1) & 0x07) // 15
const CHAR_HIGH = 0x100
const OBJ_BASE = 0x400
const BASE = OBJ_BASE + CHAR_HIGH // 0x500

/** SprTilemap[$73 + m*2] pairs for SpriteMisc1602 m = 0..5, ROM $01:9BF6+. */
const TILE_PAIRS: readonly (readonly [number, number])[] = [
  [0xa0, 0xc0], // m=0  (state 1, fade-in)
  [0xa0, 0xc0], // m=1  (unreachable)
  [0xa4, 0xc4], // m=2  wind-up
  [0xa4, 0xc4], // m=3  wind-up
  [0xa0, 0xc0], // m=4  cast
  [0xa0, 0xc0], // m=5  cast, top tile bobbed
]

const POSE_BASE_ROM = [0x04, 0x02, 0x00] // DATA_01BE69, ROM $01:BE69
const WAND_DX_ROM = [0x10, 0xf8] // DATA_01BE6C, ROM $01:BE6C (raw bytes)
const WAND_TILE = 0x99 // LDA #$99, bank_01.asm:8570, ROM $01:BF04

// ── helpers ──────────────────────────────────────────────────────────────────

function namedChar(fill: number): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64).fill(fill)))
}

/** Char map covering every charNum any frame can touch, fingerprinted by charNum. */
function makeChars(): Map<number, Char> {
  const chars = new Map<number, Char>()
  for (let t = 0; t < 0x200; t++) chars.set(BASE + t, namedChar(t & 0xff))
  return chars
}

function makeTables(): SpriteTileTables {
  const tilemap = new Uint8Array(0xfc)
  const tilemapOffset = new Uint8Array(0x54)
  const spriteAttr = new Uint8Array(0x100)
  tilemapOffset[0x1f] = TILEMAP_OFFSET_1F
  spriteAttr[0x1f] = ATTR_1F
  TILE_PAIRS.forEach(([top, bottom], m) => {
    const idx = TILEMAP_OFFSET_1F + m * 2
    tilemap[idx] = top
    tilemap[idx + 1] = bottom
  })
  return {
    tilemap,
    tilemapOffset,
    dispX: [0, 8, 0, 8],
    dispY: [0, 0, 8, 8],
    gfxProp: new Array(24).fill(0),
    spriteAttr,
    spr0to13Prop: new Uint8Array(0x14),
  }
}

function build(faceRight: boolean, dynColors: readonly number[] = []): MagikoopaAppearance {
  return MagikoopaAppearance.fromTables(
    makeChars(),
    makeTables(),
    namedChar(0xff),
    faceRight,
    dynColors,
  )
}

/** charNum recovered from a part's fingerprint fill value. */
function charNumOf(part: { char: Char }): number {
  return BASE + part.char.getPixels()[0]
}

function stubMapStore() {
  const palette = {
    row: () => [] as RgbaColor[],
    color: () => [0, 0, 0, 0] as RgbaColor,
    cells: [] as never,
    backAreaColor: null as never,
  } as unknown as Palette
  return makeTestMapStore({ palette })
}

function spyTarget(): {
  blit8x8: RenderTarget['blit8x8']
  fillRect: RenderTarget['fillRect']
  fills: number[]
} {
  const fills: number[] = []
  return {
    fills,
    blit8x8(pixels: Uint8Array) {
      fills.push(pixels[0])
    },
    fillRect() {},
  } as unknown as {
    blit8x8: RenderTarget['blit8x8']
    fillRect: RenderTarget['fillRect']
    fills: number[]
  }
}

/**
 * Records part count and per-part Y, rendered at (0, 0) so each Y is the
 * part's dy. That is everything the pose is observable through.
 */
function posSpyTarget(): { target: RenderTarget; signature: () => string } {
  const ys: number[] = []
  const target = {
    blit8x8(_pixels: Uint8Array, pos: { x: number; y: number }) {
      ys.push(pos.y)
    },
    fillRect() {},
  } as unknown as RenderTarget
  return { target, signature: () => `${ys.length}|${ys.join(',')}` }
}

/**
 * The observable render signature of each state-2 pose, written from the ROM
 * rules rather than captured from the code: body is two stacked 16x16 entries
 * at dy 0 and dy +$10 with no Y pre-shift; the wand is an extra 8x8 at dy
 * +$10, emitted first, for Misc1602 >= $04 (bank_01.asm:8545-8547); the top
 * entry alone is nudged down one pixel on $05 (bank_01.asm:8530-8539).
 *
 * $02 and $03 share a signature: SprTilemap gives them the same tile pair and
 * neither bobs, so the ROM really does render them identically.
 */
const SIGNATURE: Record<number, string> = {
  0x02: '8|0,0,8,8,16,16,24,24',
  0x03: '8|0,0,8,8,16,16,24,24',
  0x04: '9|16,0,0,8,8,16,16,24,24',
  0x05: '9|16,1,1,9,9,16,16,24,24',
}

// ── selectors ────────────────────────────────────────────────────────────────

describe('misc1602ForTimer - bank_01.asm:8513-8528', () => {
  it('yields only the four state-2 values across the whole $70..$00 countdown', () => {
    const seen = new Set<number>()
    for (let t = 0x70; t >= 0; t--) seen.add(misc1602ForTimer(t))
    expect([...seen].sort((a, b) => a - b)).toEqual([...STATE2_MISC1602_VALUES])
  })

  it('switches pose base at timer $40 - the frame that also spawns the magic', () => {
    // `timer >> 6` is 1 at and above $40 (pose base DATA_01BE69[1] = $02) and
    // 0 below it (DATA_01BE69[0] = $04).
    expect(misc1602ForTimer(0x40) & 0x06).toBe(0x02)
    expect(misc1602ForTimer(0x3f) & 0x06).toBe(0x04)
  })

  it('toggles the low bit every 8 game frames', () => {
    expect(misc1602ForTimer(0x70) & 1).toBe(0)
    expect(misc1602ForTimer(0x68) & 1).toBe(1)
    expect(misc1602ForTimer(0x60) & 1).toBe(0)
  })

  it('is defined across the whole $00..$BF domain DATA_01BE69 covers', () => {
    // Three pose bases indexed by `timer >> 6`, so $BF is the last timer
    // value the table describes.
    for (let t = 0; t <= 0xbf; t++) expect(() => misc1602ForTimer(t)).not.toThrow()
  })

  it('rejects a timer past the end of DATA_01BE69 instead of coercing undefined', () => {
    // POSE_BASE[3] is undefined and `undefined | bit` is `bit`, which would
    // silently yield pose $00 or $01 - values no state-2 timer produces.
    expect(() => misc1602ForTimer(0xc0)).toThrow(RangeError)
    expect(() => misc1602ForTimer(-1)).toThrow(RangeError)
  })
})

describe('topTileBobs - bank_01.asm:8530-8539', () => {
  it.each([
    [0x02, false],
    [0x03, false],
    [0x04, false],
    [0x05, true],
  ])('Misc1602 $%s → %s', (v, expected) => {
    expect(topTileBobs(v as number)).toBe(expected)
  })
})

describe('wandVisible - bank_01.asm:8545-8547', () => {
  it.each([
    [0x02, false],
    [0x03, false],
    [0x04, true],
    [0x05, true],
  ])('Misc1602 $%s → %s', (v, expected) => {
    expect(wandVisible(v as number)).toBe(expected)
  })
})

// ── fromTables ───────────────────────────────────────────────────────────────

describe('MagikoopaAppearance.fromTables', () => {
  it('builds one frame per reachable state-2 Misc1602 value', () => {
    expect(build(false).frames).toHaveLength(STATE2_MISC1602_VALUES.length)
  })

  it('draws 8 body subtiles in the wind-up poses and 9 with the wand in the cast poses', () => {
    const f = build(false).frames
    expect(f.map(frame => frame.length)).toEqual([8, 8, 9, 9])
  })

  it('selects tiles at SprTilemapOffset[$1F] + Misc1602 * 2, top then bottom', () => {
    const f = build(false).frames
    STATE2_MISC1602_VALUES.forEach((m, i) => {
      const [top, bottom] = TILE_PAIRS[m]
      const body = f[i].slice(f[i].length - 8) // wand, when present, is first
      expect(body.slice(0, 4).map(charNumOf)).toEqual(
        [top, top + 1, top + 0x10, top + 0x11].map(t => BASE + t),
      )
      expect(body.slice(4).map(charNumOf)).toEqual(
        [bottom, bottom + 1, bottom + 0x10, bottom + 0x11].map(t => BASE + t),
      )
    })
  })

  it('puts the top big-tile on the spawn row and the bottom 16px below it', () => {
    // Magikoopa does not pre-shift SpriteYPos the way Spr0to13Gfx does
    // (CODE_018BEC, bank_01.asm:1772-1774), so the body spans y..y+32,
    // not y-16..y+16.
    const body = build(false).frames[0]
    expect(body.slice(0, 4).map(p => p.dy)).toEqual([0, 0, 8, 8])
    expect(body.slice(4).map(p => p.dy)).toEqual([16, 16, 24, 24])
  })

  it('nudges only the top big-tile down one pixel on Misc1602 $05', () => {
    const f = build(false).frames
    const cast = f[STATE2_MISC1602_VALUES.indexOf(0x04)].slice(1)
    const castBob = f[STATE2_MISC1602_VALUES.indexOf(0x05)].slice(1)
    expect(castBob.slice(0, 4).map(p => p.dy)).toEqual(cast.slice(0, 4).map(p => p.dy + 1))
    expect(castBob.slice(4).map(p => p.dy)).toEqual(cast.slice(4).map(p => p.dy))
  })

  it('applies the sprite OBJ attribute to every part', () => {
    for (const frame of build(false).frames) {
      for (const p of frame) {
        expect(p.palette).toBe(PALETTE)
        expect(charNumOf(p)).toBeGreaterThanOrEqual(BASE)
      }
    }
  })

  it('places the wand first so the body blits over it, matching OAM slot order', () => {
    // Body goes to OAM +$100/+$104, wand to +$108 - a higher OAM index is
    // drawn behind, and this renderer blits in array order.
    const castFrame = build(false).frames[STATE2_MISC1602_VALUES.indexOf(0x04)]
    expect(charNumOf(castFrame[0])).toBe(BASE + WAND_TILE)
    expect(castFrame[0].dy).toBe(0x10)
  })

  it('faces Mario: no flip and wand on the left when Mario spawns to the left', () => {
    const frame = build(false).frames[STATE2_MISC1602_VALUES.indexOf(0x04)]
    expect(frame.every(p => p.flipX === false)).toBe(true)
    expect(frame[0].dx).toBe(-8)
  })

  it('faces Mario: X-flip and wand on the right when Mario spawns to the right', () => {
    const frame = build(true).frames[STATE2_MISC1602_VALUES.indexOf(0x04)]
    expect(frame.every(p => p.flipX === true)).toBe(true)
    expect(frame[0].dx).toBe(16)
    // An X-flipped 16x16 OAM entry swaps the columns as well as mirroring each char.
    const [top] = TILE_PAIRS[0x04]
    expect(frame.slice(1, 5).map(charNumOf)).toEqual(
      [top + 1, top, top + 0x11, top + 0x10].map(t => BASE + t),
    )
  })
})

// ── animation ────────────────────────────────────────────────────────────────

describe('MagikoopaAppearance animation', () => {
  it('starts in the wind-up pose and reaches every frame within one countdown', () => {
    const app = build(false)
    const store = stubMapStore()
    const counts = new Set<number>()
    for (let i = 0; i < 16; i++) {
      const t = spyTarget()
      app.render(t, 0, 0, STUB_BEHAVIOR, store)
      counts.add(t.fills.length)
      app.tickAnimation()
    }
    expect([...counts].sort()).toEqual([8, 9])
  })

  it('advances the ROM timer by exactly 8 game frames per tick', () => {
    // SetAnimationFrame's per-frame counter, SMWDisX bank_01.asm:2089-2096.
    // Was 7.5, back-derived from an uncited 125 ms editor interval; the
    // shared frame clock realises 8 frames exactly at any refresh rate.
    expect(ROM_FRAMES_PER_TICK).toBe(8)
  })

  it('walks the $70 countdown pose by pose, tick by tick', () => {
    // floor(SpriteMisc1540) after k ticks from STATE2_TIMER_START at 8 per
    // tick: 112 down to 0, then -8 wraps by +$71 to 105.
    //
    // NOTE: this list is pose-sensitive, not timer-sensitive. It passed
    // unchanged when the cadence moved from 7.5 to 8, because
    // misc1602ForTimer reads only two bits of the timer. The comment it
    // replaced claimed "any other cadence fails here", which is false.
    // Making it actually cadence-sensitive belongs with #327, not here.
    const TIMERS = [112, 104, 96, 88, 80, 72, 64, 56, 48, 40, 32, 24, 16, 8, 0, 105]
    const EXPECTED = TIMERS.map(t => SIGNATURE[misc1602ForTimer(t)])

    const app = build(false)
    const store = paletteMapStore()
    const seen: string[] = []
    for (let k = 0; k < TIMERS.length; k++) {
      const t = posSpyTarget()
      app.render(t.target, 0, 0, STUB_BEHAVIOR, store)
      seen.push(t.signature())
      app.tickAnimation()
    }
    expect(seen).toEqual(EXPECTED)
    // The countdown must visit both halves, or this sequence could agree
    // with a wrong cadence by being constant.
    expect(new Set(seen).size).toBeGreaterThan(1)
  })

  it('reaches the first cast pose on the 8th rendered frame', () => {
    // `timer >> 6` drops from 1 to 0 at $3F; from $70 at 8 per tick that is
    // tick 7 (56). A doubled cadence would reach it at tick 3.
    const app = build(false)
    const store = stubMapStore()
    let firstCast = -1
    for (let k = 0; k < 16 && firstCast < 0; k++) {
      const t = spyTarget()
      app.render(t, 0, 0, STUB_BEHAVIOR, store)
      if (t.fills.length === 9) firstCast = k
      app.tickAnimation()
    }
    expect(firstCast).toBe(7)
  })

  it('never renders a pose outside the four state-2 values', () => {
    const app = build(false)
    const store = paletteMapStore()
    const valid = new Set(STATE2_MISC1602_VALUES.map(v => SIGNATURE[v]))
    for (let k = 0; k < 200; k++) {
      const t = posSpyTarget()
      app.render(t.target, 0, 0, STUB_BEHAVIOR, store)
      expect(valid.has(t.signature())).toBe(true)
      app.tickAnimation()
    }
  })

  it('refuses to render a pose it has no frame for', () => {
    // A silent fallback to frames[0] would hide a frames array not built
    // from STATE2_MISC1602_VALUES - which is what a wrong
    // STATE2_TIMER_START produces, via a negative index.
    const short = new MagikoopaAppearance(build(false).frames.slice(0, 1))
    const store = stubMapStore()
    short.render(spyTarget(), 0, 0, STUB_BEHAVIOR, store) // $70 -> $02 -> index 0
    short.tickAnimation() // -> $03 -> index 1, absent
    expect(() => short.render(spyTarget(), 0, 0, STUB_BEHAVIOR, store)).toThrow(RangeError)
  })
})

// -- palette -----------------------------------------------------------------

/**
 * Synthetic BGR555 stand-ins for MagiKoopaPals entry 7, chosen so each channel
 * is exercised alone. The expected RGBA below is spelled out rather than run
 * through the converter, so a swapped R/B would fail here too.
 */
const DYN_WORDS = [0x0000, 0x001f, 0x03e0, 0x7c00, 0x7fff, 0x0400, 0x0020, 0x0001]
const DYN_RGBA: RgbaColor[] = [
  [0, 0, 0, 255],
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 255, 255],
  [0, 0, 8, 255],
  [0, 8, 0, 255],
  [8, 0, 0, 255],
]

/** A level palette whose every row is distinguishable from DYN_RGBA. */
const levelRow = (idx: number): RgbaColor[] =>
  Array.from({ length: 16 }, (_, c) => [0x40 + idx, 0x40 + c, 0x7f, 255] as RgbaColor)

function paletteMapStore(rowsSeen?: RgbaColor[][][]) {
  const palette = {
    row: (idx: number) => {
      const r = levelRow(idx)
      rowsSeen?.push([r])
      return r
    },
    color: () => [0, 0, 0, 0] as RgbaColor,
    cells: [] as never,
    backAreaColor: null as never,
  } as unknown as Palette
  return makeTestMapStore({ palette })
}

/** Records the palette row handed to each blit. */
function rowSpyTarget(): { target: RenderTarget; rows: readonly RgbaColor[][] } {
  const rows: readonly RgbaColor[][] = []
  const target = {
    blit8x8(_pixels: Uint8Array, _pos: unknown, row: readonly RgbaColor[]) {
      ;(rows as RgbaColor[][]).push(row.map(c => [...c] as RgbaColor))
    },
    fillRect() {},
  } as unknown as RenderTarget
  return { target, rows }
}

describe('MagikoopaAppearance palette - CODE_01C028 (bank_01.asm:8733)', () => {
  it('splices the runtime colours over row 15 columns 0-7 and keeps 8-15', () => {
    // The entry header is $10 bytes at CGRAM $F0: 8 colours at row 15 col 0.
    // Columns 8-15 of that row are never written, so they stay level-supplied.
    const { target, rows } = rowSpyTarget()
    build(false, DYN_WORDS).render(target, 0, 0, STUB_BEHAVIOR, paletteMapStore())
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.slice(0, 8)).toEqual(DYN_RGBA)
      expect(row.slice(8)).toEqual(levelRow(PALETTE).slice(8))
    }
  })

  it('targets the row the CGRAM header names, which is the sprite OBJ palette', () => {
    expect(MAGIKOOPA_PALS.cgramStart >> 4).toBe(PALETTE)
  })

  it('does not draw the level row that the static palette would have supplied', () => {
    const { target, rows } = rowSpyTarget()
    build(false, DYN_WORDS).render(target, 0, 0, STUB_BEHAVIOR, paletteMapStore())
    expect(rows[0]).not.toEqual(levelRow(PALETTE))
  })

  it('falls back to the level row when the cart read produced nothing', () => {
    const { target, rows } = rowSpyTarget()
    build(false, []).render(target, 0, 0, STUB_BEHAVIOR, paletteMapStore())
    for (const row of rows) expect(row).toEqual(levelRow(PALETTE))
  })

  it('leaves parts on any other OBJ palette on the untouched level row', () => {
    // CODE_01C028 writes only CGRAM $F0..$F7, so only row 15 may be spliced.
    // fromTables puts every part on row 15, but `frames` is
    // constructor-supplied and rehydrate.ts carries a per-part palette, so a
    // part on another row is representable and must pass through.
    const OTHER = PALETTE - 1
    const source = build(false).frames
    const frames = source.map((f, i) =>
      i === 0 ? [{ ...f[0], palette: OTHER }, ...f.slice(1)] : f,
    )

    const { target, rows } = rowSpyTarget()
    new MagikoopaAppearance(frames, DYN_WORDS).render(
      target,
      0,
      0,
      STUB_BEHAVIOR,
      paletteMapStore(),
    )

    expect(rows[0]).toEqual(levelRow(OTHER))
    expect(rows[1].slice(0, 8)).toEqual(DYN_RGBA)
  })

  it('leaves the palette shared scratch buffer alone', () => {
    // Palette.row() hands back a reused array; compositing into it would
    // corrupt every other consumer of row 15 for the rest of the frame.
    const handed: RgbaColor[][][] = []
    const { target } = rowSpyTarget()
    build(false, DYN_WORDS).render(target, 0, 0, STUB_BEHAVIOR, paletteMapStore(handed))
    for (const [r] of handed) expect(r).toEqual(levelRow(PALETTE))
  })
})

// -- payload round-trip ------------------------------------------------------

describe('MagikoopaAppearance payload round-trip', () => {
  const MOCK_BEH = { kind: 'mock' } as never

  it('serialize -> rehydrate keeps kind, frames and the runtime palette', () => {
    const d = serializeSprite(new Sprite(0x1f, 0, 0, build(false, DYN_WORDS), MOCK_BEH))
    expect(d.appearance.kind).toBe('magikoopa')

    const back = buildSprite(
      { ...d, behavior: { kind: 'mock' } } as never,
      makeChars(),
      namedChar(0xff),
    )
    expect(back.appearance).toBeInstanceOf(MagikoopaAppearance)
    const app = back.appearance as MagikoopaAppearance
    expect(app.dynColors).toEqual(DYN_WORDS)
    expect(app.frames.map(f => f.length)).toEqual([8, 8, 9, 9])
  })

  it('a rehydrated appearance composites the same row as the original', () => {
    const original = build(false, DYN_WORDS)
    const d = serializeSprite(new Sprite(0x1f, 0, 0, original, MOCK_BEH))
    const back = buildSprite(
      { ...d, behavior: { kind: 'mock' } } as never,
      makeChars(),
      namedChar(0xff),
    ).appearance

    const a = rowSpyTarget()
    original.render(a.target, 0, 0, STUB_BEHAVIOR, paletteMapStore())
    const b = rowSpyTarget()
    back.render(b.target, 0, 0, STUB_BEHAVIOR, paletteMapStore())
    expect(b.rows).toEqual(a.rows)
    expect(b.rows[0].slice(0, 8)).toEqual(DYN_RGBA)
  })
})

// ── ROM anchor ───────────────────────────────────────────────────────────────

const ROM_PATH = romPath(VANILLA)
const romPresent = hasRom(VANILLA)

/** LoROM SNES address → file offset, for a header-free 512KB cart. */
const lorom = (a: number) => ((a >>> 16) & 0x7f) * 0x8000 + (a & 0x7fff)

describe.skipIf(!romPresent)('sprite $1F ROM anchor (ROM-only)', () => {
  const rom = () => readFileSync(ROM_PATH)

  it('SprTilemapOffset[$1F] is still $73', () => {
    expect(rom()[lorom(0x019c7f) + 0x1f]).toBe(TILEMAP_OFFSET_1F)
  })

  it('Sprite166EVals[$1F] still yields OBJ palette 7 with the char-high bit set', () => {
    const raw = rom()[lorom(0x07f3fe) + 0x1f]
    expect(raw & 0x0f).toBe(ATTR_1F)
    expect(8 + (((raw & 0x0f) >> 1) & 0x07)).toBe(PALETTE)
    expect((raw & 0x01) !== 0).toBe(true)
  })

  it('SprTilemap still holds the six Misc1602 tile pairs used above', () => {
    const b = rom()
    const tm = lorom(0x019b83)
    TILE_PAIRS.forEach(([top, bottom], m) => {
      const idx = TILEMAP_OFFSET_1F + m * 2
      expect([b[tm + idx], b[tm + idx + 1]]).toEqual([top, bottom])
    })
  })

  it('the two poses really are distinct artwork', () => {
    // If this ever collapses, the wind-up/cast split is not a real animation.
    expect(TILE_PAIRS[0x02]).not.toEqual(TILE_PAIRS[0x04])
  })

  it('DATA_01BE69, DATA_01BE6C and the wand char match the constants in the source', () => {
    const b = rom()
    expect([...b.subarray(lorom(0x01be69), lorom(0x01be69) + 3)]).toEqual(POSE_BASE_ROM)
    expect([...b.subarray(lorom(0x01be6c), lorom(0x01be6c) + 2)]).toEqual(WAND_DX_ROM)
    // Read as the whole `LDA #imm`: $01:BF05 is followed by another $99
    // byte, so a single-byte anchor there cannot detect a one-byte drift.
    expect([...b.subarray(lorom(0x01bf04), lorom(0x01bf04) + 2)]).toEqual([0xa9, WAND_TILE])
  })

  it('STATE2_TIMER_START is the immediate the ROM loads on entry to state 2', () => {
    // `LDA #$70 : STA SpriteMisc1540,x` at $01:C022 (CODE_01C004,
    // bank_01.asm:8729). Compared against the constant, not a repeated
    // literal, so changing the constant fails here as well as in the
    // pose-sequence tests above.
    const b = rom()
    expect([...b.subarray(lorom(0x01c022), lorom(0x01c022) + 5)]).toEqual([
      0xa9,
      STATE2_TIMER_START,
      0x9d,
      0x40,
      0x15,
    ])
  })
})
