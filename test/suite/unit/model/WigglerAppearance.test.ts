/**
 * WigglerAppearance - locks the multi-segment OAM expansion for sprite $86.
 *
 * WigglerGfx (bank_02.asm:14987) draws 5 16×16 big-tiles + an 8×8 eye:
 *   WigglerTiles  (bank_02.asm:14984): db $C4,$C6,$C8,$C6  (body indices 0..3)
 *   Head tile:                          $8C (segIdx 0, forced via CPX #$00)
 *   Eye tile:                           $98 (8×8, palette forced to row 13)
 *   DATA_02F108   (bank_02.asm:14982): db $00,$01,$02,$01  (Y-bob, SBC'd)
 *   DATA_02F2D3   (bank_02.asm:15227): db $00,$08          (eye dx by face)
 *
 * H-flip is direction-dependent (bank_02.asm:14945-14948):
 *   SpriteTableC2 = (SpriteTableC2 << 1) | misc157C  (every 8 frames)
 *   Settled state: face-right → all bits 0 → H-flip on; face-left → all bits 1 → no H-flip.
 *   H-flip uses swapped corner chars [0x01,0x00,0x11,0x10].
 *   No-flip uses standard corners    [0x00,0x01,0x10,0x11].
 *   Eye inherits flip from head (AND #$F1 preserves bit 6).
 *
 * Animation: editor frame counter matches in-game `misc1570>>3` (one editor
 * tick = 8 game frames = ANIM_INTERVAL_MS). For each segIdx in [0..4] at
 * frame F, the body tile-table index and bob-offset index is `_6 = (F + segIdx) & 3`.
 * Head still bobs via _6 even though its tile is fixed at $8C.
 *
 * Test tree
 * ---------
 *   constructor - head/body/eye structure
 *     - head big-tile (faceLeft): 4 corners, standard layout, flipX=false
 *     - body big-tiles (faceLeft): 4 entries indexed by WigglerTiles ($C4/$C6/$C8/$C6)
 *     - eye: 1 part, tile $98, palette 13
 *       - faceLeft → flipX=false, dx=+8, dy=-8
 *       - faceRight → flipX=true, dx=+0
 *   render - body trail direction
 *     - faceLeft → segIdx i drawn at +i*8
 *     - faceRight → segIdx i drawn at -i*8
 *   tickAnimation - 4-frame wiggle cycle
 *     - frame F → segIdx 1 uses bodyBigTiles[(F+1) & 3]
 *     - cycle wraps every 4 ticks
 *   bob offsets
 *     - per-segment Y bob = -DATA_02F108[(frame + segIdx) & 3]
 */
import { describe, it, expect } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { PixelPos, RenderTarget } from '../../../../src/rom/model/RenderTarget'
import {
  WIGGLER_BODY_TILES,
  WIGGLER_BOB_OFFSETS,
  WIGGLER_EYE_PALETTE,
  WIGGLER_EYE_TILE,
  WIGGLER_FRAME_COUNT,
  WIGGLER_HEAD_TILE,
  WIGGLER_SEGMENT_DX,
  WigglerAppearance,
} from '../../../../src/rom/model/sprites/appearances/WigglerAppearance'
import { makeTestMapStore } from '../fixtures/stores'

const OBJ_BASE = 0x400
const CHAR_HIGH = 0x100 // Sprite166EVals[$86] & $0F = $05; bit 0 = 1.
const PALETTE = 10 // 8 + (5>>1) = 10

// face-right: H-flip swaps column pairs → TL=$01, TR=$00, BL=$11, BR=$10.
const H_FLIP_CORNERS = [0x01, 0x00, 0x11, 0x10] as const
// face-left: no H-flip, standard SNES big-tile expansion → TL=$00, TR=$01, BL=$10, BR=$11.
const NO_FLIP_CORNERS = [0x00, 0x01, 0x10, 0x11] as const

const TRANSPARENT_ROW: RgbaColor[] = Array(16).fill([0, 0, 0, 0] as RgbaColor)
const stubPalette = {
  row: () => TRANSPARENT_ROW,
  color: () => [0, 0, 0, 0] as RgbaColor,
  cells: [] as never,
  backAreaColor: null as never,
} as unknown as Palette
const mapStore = makeTestMapStore({ palette: stubPalette })

// Each char's pixel buffer is a stable instance from StaticPixelsBehavior, so
// we can recover the char id via the Char→id map below when intercepting
// blit8x8 calls. This lets render-time tests assert the right tile is at the
// right (x, y) coordinate.
const PIXEL_BUFFER_TO_CHAR_ID = new WeakMap<Uint8Array, number>()

function buildChars(): Map<number, Char> {
  const map = new Map<number, Char>()
  for (let id = 0; id < 0xc00; id++) {
    const buf = new Uint8Array(64)
    PIXEL_BUFFER_TO_CHAR_ID.set(buf, id)
    map.set(id, new Char(id, new StaticPixelsBehavior(buf)))
  }
  return map
}

function charId(tileBase: number, cornerOffset: number): number {
  return OBJ_BASE + CHAR_HIGH + tileBase + cornerOffset
}

interface BlitCall {
  x: number
  y: number
  charId: number
  flipX: boolean
  flipY: boolean
}

function capturingTarget(): { target: RenderTarget; calls: BlitCall[] } {
  const calls: BlitCall[] = []
  const target: RenderTarget = {
    blit8x8(pixels: Uint8Array, pos: PixelPos, _row, flipX, flipY) {
      calls.push({
        x: pos.x,
        y: pos.y,
        charId: PIXEL_BUFFER_TO_CHAR_ID.get(pixels) ?? -1,
        flipX,
        flipY,
      })
    },
    fillRect() {},
  }
  return { target, calls }
}

const placeholder = new Char(-1, new StaticPixelsBehavior(new Uint8Array(64)))

// ── Constructor / part shape ──────────────────────────────────────────────

describe('WigglerAppearance - head big-tile (faceLeft)', () => {
  const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, true, placeholder)

  it('exposes 4 standard-corner parts using head tile $8C, flipX=false', () => {
    expect(a.headBigTile).toHaveLength(4)
    a.headBigTile.forEach((p, i) => {
      expect(p.char.id).toBe(charId(WIGGLER_HEAD_TILE, NO_FLIP_CORNERS[i]))
      expect(p.flipX).toBe(false)
      expect(p.flipY).toBe(false)
      expect(p.palette).toBe(PALETTE)
    })
  })
})

describe('WigglerAppearance - head big-tile (faceRight)', () => {
  const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, false, placeholder)

  it('exposes 4 H-flipped corners using head tile $8C, flipX=true', () => {
    expect(a.headBigTile).toHaveLength(4)
    a.headBigTile.forEach((p, i) => {
      expect(p.char.id).toBe(charId(WIGGLER_HEAD_TILE, H_FLIP_CORNERS[i]))
      expect(p.flipX).toBe(true)
      expect(p.flipY).toBe(false)
      expect(p.palette).toBe(PALETTE)
    })
  })
})

describe('WigglerAppearance - body big-tiles (faceLeft)', () => {
  const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, true, placeholder)

  it('exposes 4 big-tiles indexed by WigglerTiles = [$C4,$C6,$C8,$C6], flipX=false', () => {
    expect(a.bodyBigTiles).toHaveLength(WIGGLER_FRAME_COUNT)
    WIGGLER_BODY_TILES.forEach((tileBase, frameIdx) => {
      const big = a.bodyBigTiles[frameIdx]
      expect(big).toHaveLength(4)
      big.forEach((p, corner) => {
        expect(p.char.id).toBe(charId(tileBase, NO_FLIP_CORNERS[corner]))
        expect(p.flipX).toBe(false)
        expect(p.flipY).toBe(false)
        expect(p.palette).toBe(PALETTE)
      })
    })
  })
})

describe('WigglerAppearance - eye', () => {
  it('faceLeft → eye dx=+8, dy=-8, palette 13, flipX=false', () => {
    const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, true, placeholder)
    expect(a.eye.char.id).toBe(OBJ_BASE + CHAR_HIGH + WIGGLER_EYE_TILE)
    expect(a.eye.palette).toBe(WIGGLER_EYE_PALETTE)
    expect(a.eye.flipX).toBe(false)
    expect(a.eye.flipY).toBe(false)
    expect(a.eye.dx).toBe(8)
    expect(a.eye.dy).toBe(-8)
  })

  it('faceRight → eye dx=+0, flipX=true', () => {
    const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, false, placeholder)
    expect(a.eye.dx).toBe(0)
    expect(a.eye.flipX).toBe(true)
  })
})

// ── Render-time positional checks ─────────────────────────────────────────

describe('WigglerAppearance.render - body trail direction', () => {
  it('faceLeft trails to the right: tail TL char appears at +32', () => {
    const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, true, placeholder)
    const { target, calls } = capturingTarget()
    a.render(target, 0, 0, undefined as never, mapStore)

    const tailTL = calls.find(
      c =>
        c.x === 4 * WIGGLER_SEGMENT_DX &&
        c.charId === charId(WIGGLER_BODY_TILES[(0 + 4) & 3], NO_FLIP_CORNERS[0]),
    )
    expect(tailTL, 'tail TL at +32').toBeDefined()
  })

  it('faceRight trails to the left: tail TL char appears at -32', () => {
    const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, false, placeholder)
    const { target, calls } = capturingTarget()
    a.render(target, 0, 0, undefined as never, mapStore)

    const tailTL = calls.find(
      c =>
        c.x === -4 * WIGGLER_SEGMENT_DX &&
        c.charId === charId(WIGGLER_BODY_TILES[(0 + 4) & 3], H_FLIP_CORNERS[0]),
    )
    expect(tailTL, 'tail TL at -32').toBeDefined()
  })
})

describe('WigglerAppearance.render - head always uses $8C', () => {
  it.each([0, 1, 2, 3] as const)('frame %i: head TL at (0, bob) is tile $8C', ticks => {
    const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, true, placeholder)
    for (let i = 0; i < ticks; i++) a.tickAnimation()
    const { target, calls } = capturingTarget()
    a.render(target, 0, 0, undefined as never, mapStore)

    const expectedBobY = -WIGGLER_BOB_OFFSETS[(ticks + 0) & 3]
    const headTL = calls.find(
      c =>
        c.x === 0 &&
        c.y === expectedBobY &&
        c.charId === charId(WIGGLER_HEAD_TILE, NO_FLIP_CORNERS[0]),
    )
    expect(headTL, `head TL at frame ${ticks}`).toBeDefined()
  })
})

describe('WigglerAppearance.tickAnimation - 4-frame wiggle cycle', () => {
  // For each frame F, segIdx 1's body tile is WIGGLER_BODY_TILES[(F + 1) & 3].
  it.each([
    [0, 1], // frame 0 → table idx 1 → $C6
    [1, 2], // frame 1 → table idx 2 → $C8
    [2, 3], // frame 2 → table idx 3 → $C6
    [3, 0], // frame 3 → table idx 0 → $C4
  ] as const)(
    'after %i ticks, segIdx 1 uses body tile WigglerTiles[%i]',
    (ticks, expectedTableIdx) => {
      const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, true, placeholder)
      for (let i = 0; i < ticks; i++) a.tickAnimation()

      const { target, calls } = capturingTarget()
      a.render(target, 0, 0, undefined as never, mapStore)

      const expectedTile = WIGGLER_BODY_TILES[expectedTableIdx]
      const expectedX = WIGGLER_SEGMENT_DX
      const expectedY = -WIGGLER_BOB_OFFSETS[expectedTableIdx]
      const seg1TL = calls.find(
        c =>
          c.x === expectedX &&
          c.y === expectedY &&
          c.charId === charId(expectedTile, NO_FLIP_CORNERS[0]),
      )
      expect(seg1TL).toBeDefined()
    },
  )

  it('cycle wraps every 4 ticks', () => {
    const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, true, placeholder)
    const cap0 = capturingTarget()
    a.render(cap0.target, 0, 0, undefined as never, mapStore)

    for (let i = 0; i < WIGGLER_FRAME_COUNT; i++) a.tickAnimation()

    const cap4 = capturingTarget()
    a.render(cap4.target, 0, 0, undefined as never, mapStore)

    expect(cap4.calls).toEqual(cap0.calls)
  })
})

describe('WigglerAppearance.render - bob offsets follow DATA_02F108', () => {
  it('per-segment Y bob = -DATA_02F108[(frame + segIdx) & 3] at frame 0', () => {
    const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, true, placeholder)
    const { target, calls } = capturingTarget()
    a.render(target, 0, 0, undefined as never, mapStore)

    for (let segIdx = 0; segIdx < 5; segIdx++) {
      const tableIdx = (0 + segIdx) & 3
      const expectedBobY = -WIGGLER_BOB_OFFSETS[tableIdx]
      const expectedX = segIdx * WIGGLER_SEGMENT_DX
      const tileBase = segIdx === 0 ? WIGGLER_HEAD_TILE : WIGGLER_BODY_TILES[tableIdx]
      const tl = calls.find(
        c =>
          c.x === expectedX &&
          c.y === expectedBobY &&
          c.charId === charId(tileBase, NO_FLIP_CORNERS[0]),
      )
      expect(tl, `segIdx ${segIdx} TL at (${expectedX}, ${expectedBobY})`).toBeDefined()
    }
  })
})

// ── Eye render position ───────────────────────────────────────────────────

describe('WigglerAppearance.render - eye position', () => {
  it('faceLeft: eye drawn at (+8, -8) regardless of frame', () => {
    const a = WigglerAppearance.fromTables(buildChars(), PALETTE, CHAR_HIGH, true, placeholder)
    a.tickAnimation()
    a.tickAnimation()
    const { target, calls } = capturingTarget()
    a.render(target, 100, 200, undefined as never, mapStore)

    const eye = calls.find(c => c.charId === OBJ_BASE + CHAR_HIGH + WIGGLER_EYE_TILE)
    expect(eye).toBeDefined()
    expect(eye!.x).toBe(108) // 100 + 8
    expect(eye!.y).toBe(192) // 200 - 8
  })
})
