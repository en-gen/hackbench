// Consumes: (none)

import type { Char } from '../../chars/Char'
import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { SpriteBehavior } from '../SpriteBehavior'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'
import { COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH, drawApexLine, rgba } from '../../overlays/primitives'

// ASM source: WoodSpikeGfx (bank_03.asm:2669)
//   WoodSpikeTiles:   db $6A,$6A,$6A,$6A,$4A,$6A,$6A,$6A,$6A,$4A
//   WoodSpikeDispY:   db $00,$10,$20,$30,$40,$40,$30,$20,$10,$00
//   WoodSpikeGfxProp: db $81,$81,$81,$81,$81,$01,$01,$01,$01,$01
//
// charHigh = prop bit 0 = 1 always → $100.
// palette  = prop bits[3:1] = 0 always → CGRAM row 8.
//
// State machine (bank_03.asm:2559):
//   State 0: speed $F0 (-1 px/fr) until timer=0 → set $30, state 1
//   State 1: wait 48 frames → set $18, state 2
//   State 2: speed $20 (+2 px/fr) until timer=0 → set $30, state 3
//   State 3: wait 48 frames → set $2F, state 0
//
// SpriteMisc151C (CODE_039475): negates speed when non-zero.
//   $AC: always 0 → state 2 speed $20 = +2 px/fr (DOWN); extendDir = +1.
//   $AD odd  col (spriteMisc151C≠0): state 2 negated to -2 px/fr (UP); extendDir = -1.
//   $AD even col (spriteMisc151C=0): state 2 not negated, +2 px/fr (DOWN, underground retract);
//     extendDir = +1.  The spike goes underground first, returns to surface in state 0.
//   All variants start fully retracted (cycleTick = 0, dyMove = 0).
//
// Editor animation — 21-tick cycle (125 ms/tick ≈ 7.5 game frames/tick):
//   ticks  0-5:  hold retracted  (dyMove =  0)
//   ticks  6-8:  extend          (dyMove = 16, 32, 48)
//   ticks  9-14: hold extended   (dyMove = 48)
//   ticks 15-20: retract         (dyMove = 40, 32, 24, 16, 8, 0)
// extendDir: +1 = DOWN ($AC ceiling / $AD even-col underground), -1 = UP ($AD odd-col floor spike).

const OBJ_BASE = 0x400

const CYCLE_TICKS   = 21
const HOLD_RETRACT  = 6
const EXTEND_TICKS  = 3
const HOLD_EXTENDED = 6
const RETRACT_TICKS = CYCLE_TICKS - HOLD_RETRACT - EXTEND_TICKS - HOLD_EXTENDED  // 6

export const WOOD_SPIKE_CHAR_HIGH  = 0x100
export const WOOD_SPIKE_PALETTE    = 8
export const WOOD_SPIKE_BODY_TILE  = 0x6A   // indices 0-3, 5-8
export const WOOD_SPIKE_TIP_TILE   = 0x4A   // indices 4, 9
export const WOOD_SPIKE_EXTEND_PX  = 48

const EXTEND_STEP  = WOOD_SPIKE_EXTEND_PX / EXTEND_TICKS   // 16
const RETRACT_STEP = WOOD_SPIKE_EXTEND_PX / RETRACT_TICKS  // 8

function make16(
  chars: Map<number, Char>,
  placeholder: Char,
  tileBase: number,
  dx: number,
  dy: number,
  flipV: boolean,
): SpritePart[] {
  const c = (off: number) =>
    chars.get(OBJ_BASE + WOOD_SPIKE_CHAR_HIGH + tileBase + off) ?? placeholder
  const pal = WOOD_SPIKE_PALETTE
  if (flipV) {
    // V-flip: rows swap and each 8×8 is individually V-flipped.
    // Bottom row (BL/BR) draws at the top, top row (TL/TR) at the bottom.
    return [
      { char: c(0x10), palette: pal, flipX: false, flipY: true, dx: dx,     dy: dy     },
      { char: c(0x11), palette: pal, flipX: false, flipY: true, dx: dx + 8, dy: dy     },
      { char: c(0x00), palette: pal, flipX: false, flipY: true, dx: dx,     dy: dy + 8 },
      { char: c(0x01), palette: pal, flipX: false, flipY: true, dx: dx + 8, dy: dy + 8 },
    ]
  }
  return [
    { char: c(0x00), palette: pal, flipX: false, flipY: false, dx: dx,     dy: dy     },
    { char: c(0x01), palette: pal, flipX: false, flipY: false, dx: dx + 8, dy: dy     },
    { char: c(0x10), palette: pal, flipX: false, flipY: false, dx: dx,     dy: dy + 8 },
    { char: c(0x11), palette: pal, flipX: false, flipY: false, dx: dx + 8, dy: dy + 8 },
  ]
}

function dyMoveAt(tick: number): number {
  if (tick < HOLD_RETRACT) return 0
  if (tick < HOLD_RETRACT + EXTEND_TICKS) return (tick - HOLD_RETRACT + 1) * EXTEND_STEP
  if (tick < HOLD_RETRACT + EXTEND_TICKS + HOLD_EXTENDED) return WOOD_SPIKE_EXTEND_PX
  const rt = tick - HOLD_RETRACT - EXTEND_TICKS - HOLD_EXTENDED
  return WOOD_SPIKE_EXTEND_PX - (rt + 1) * RETRACT_STEP
}

export class WoodSpikeAppearance extends StaticSpriteAppearance {
  readonly spriteId:       0xAC | 0xAD
  readonly spriteMisc151C: number
  /**
   * +1 = tip moves DOWN when extending ($AC ceiling spike extends out of ceiling).
   * -1 = tip moves UP when extending ($AD floor spike extends out of floor).
   */
  readonly extendDir: 1 | -1
  cycleTick: number
  dyMove:    number

  constructor(
    parts: readonly SpritePart[],
    spriteId: 0xAC | 0xAD,
    spriteMisc151C: number,
    extendDir: 1 | -1,
    initialCycleTick = 0,
  ) {
    super(parts)
    this.spriteId        = spriteId
    this.spriteMisc151C  = spriteMisc151C
    this.extendDir       = extendDir
    this.cycleTick       = initialCycleTick
    this.dyMove          = dyMoveAt(initialCycleTick)
  }

  override render(target: RenderTarget, x: number, y: number, _behavior: SpriteBehavior, mapStore: MapStore): void {
    const yOff = this.dyMove * this.extendDir
    for (const part of this.parts) {
      const pixels = part.char.getPixels()
      const row = mapStore.palette.row(part.palette)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy + yOff }, row, part.flipX, part.flipY)
    }
  }

  override tickAnimation(): void {
    this.cycleTick = (this.cycleTick + 1) % CYCLE_TICKS
    this.dyMove    = dyMoveAt(this.cycleTick)
  }

  override renderOverlay(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    _getL1:     GetL1Tile,
    _levelCols: number,
    _levelRows: number,
    _behavior:  SpriteBehavior | undefined,
    _mapStore:  MapStore,
  ): void {
    if (!isActive) return
    const color   = COLORS.patrolPath
    const centerX = x + 8
    // $AC uses V-flip: the sharp tip faces DOWN and sits at the bottom of the
    // 16×16 tip tile (y+16). $AD has no flip: sharp tip faces UP at the top (y).
    const anchorY = this.spriteId === 0xAC ? y + 16 : y
    const extY    = anchorY + WOOD_SPIKE_EXTEND_PX * this.extendDir

    ctx.save()
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()
    ctx.moveTo(centerX, anchorY)
    ctx.lineTo(centerX, extY)
    ctx.stroke()
    ctx.setLineDash([])
    drawApexLine(ctx, x, x + 16, extY, color)
    ctx.restore()
  }

  /**
   * Build the 5-tile appearance from the VRAM char map.
   *
   * $AC — InitWoodSpike (bank_01.asm:488) subtracts $40 from sprite Y before
   * the first draw, so the spawn position sits at the tip (dy=0) and the body
   * extends 64 px upward (dy=-64..-16). All five tiles use V-flip (prop $81).
   *
   * $AD — InitMontyMole (bank_01.asm:730) leaves Y unchanged, so the tip sits
   * at dy=0 and the body extends 64 px downward (dy=16..64). No flip (prop $01).
   *
   * spriteMisc151C = SpriteXPosLow & $10 (CODE_039475). Non-zero negates the
   * Y speed, so odd-column $AD spikes (spriteMisc151C≠0) extend upward out of
   * the floor (extendDir=-1) and even-column ones (spriteMisc151C=0) retract
   * underground first (extendDir=+1, DOWN). Both start at cycleTick=0 (retracted).
   */
  static fromTables(
    chars: Map<number, Char>,
    id: 0xAC | 0xAD,
    placeholder: Char,
    spriteMisc151C = 0,
  ): WoodSpikeAppearance {
    const extendDir: 1 | -1 = (id === 0xAD && spriteMisc151C !== 0) ? -1 : 1
    const initialTick = 0
    const parts: SpritePart[] = id === 0xAC
      ? [
          ...make16(chars, placeholder, WOOD_SPIKE_BODY_TILE, 0, -64, true),
          ...make16(chars, placeholder, WOOD_SPIKE_BODY_TILE, 0, -48, true),
          ...make16(chars, placeholder, WOOD_SPIKE_BODY_TILE, 0, -32, true),
          ...make16(chars, placeholder, WOOD_SPIKE_BODY_TILE, 0, -16, true),
          ...make16(chars, placeholder, WOOD_SPIKE_TIP_TILE,  0,   0, true),
        ]
      : [
          ...make16(chars, placeholder, WOOD_SPIKE_TIP_TILE,  0,   0, false),
          ...make16(chars, placeholder, WOOD_SPIKE_BODY_TILE, 0,  16, false),
          ...make16(chars, placeholder, WOOD_SPIKE_BODY_TILE, 0,  32, false),
          ...make16(chars, placeholder, WOOD_SPIKE_BODY_TILE, 0,  48, false),
          ...make16(chars, placeholder, WOOD_SPIKE_BODY_TILE, 0,  64, false),
        ]
    return new WoodSpikeAppearance(parts, id, spriteMisc151C, extendDir, initialTick)
  }
}
