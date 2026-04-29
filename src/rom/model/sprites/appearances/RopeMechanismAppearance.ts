import type { Char } from '../../chars/Char'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpritePart } from './StaticSpriteAppearance'

const OBJ_CHAR_BASE = 0x400

/**
 * RopeMotorTiles (bank_01.asm:12557): db $C0,$C2,$E0,$C2 — 4-frame animation.
 * ROM frame index: ((slotIndex * 4) XOR effFrame) >> 3 & 3, where effFrame is
 * the raw game frame counter (not the tile-animation heartbeat). The editor maps
 * ctx.animFrame directly to the 4-frame cycle via % 4.
 */
const MOTOR_TILES = [0xC0, 0xC2, 0xE0, 0xC2] as const
const BODY_TILE   = 0xCE
const KNOT_TILE   = 0xDE

/**
 * Rope smoke routes through the dispatcher at CODE_0296C0 (bank_02.asm:2960).
 * Sprite $64 spawns smoke with SmokeSpriteNumber=$03 (CODE_018063, bank_01.asm:11098),
 * which dispatches to CODE_029927 — NOT the generic CODE_0296E3 path. The rope-specific
 * tile table is DATA_029922 (bank_02.asm:3277): db $66,$66,$64,$62,$62.
 *
 * Lifecycle (timer 19→0, indexed by timer>>2):
 *   timer 19..12 (age 0-7)   → $62 (newest, just spawned)
 *   timer 11..8  (age 8-11)  → $64 (middle)
 *   timer 7..0   (age 12-19) → $66 (oldest, fading)
 *
 * Size: 8×8 — CODE_029927:3338 writes #$00 (small) to OAMTileSize.
 * Rises 1 px every 8 frames (DEC SmokeSpriteYPos at line 3298).
 */
const SMOKE_TILES = [0x62, 0x64, 0x66] as const

function bigTileParts(tile: number, palette: number, c: (n: number) => Char): SpritePart[] {
  return [
    { char: c(tile),        palette, flipX: false, flipY: false, dx: 0, dy: 0 },
    { char: c(tile + 1),    palette, flipX: false, flipY: false, dx: 8, dy: 0 },
    { char: c(tile + 0x10), palette, flipX: false, flipY: false, dx: 0, dy: 8 },
    { char: c(tile + 0x11), palette, flipX: false, flipY: false, dx: 8, dy: 8 },
  ]
}

/**
 * Sprite $64 (Rope Mechanism) — animated motor + fixed body + knot + smoke puffs.
 *
 * CODE_01DC54 (bank_01.asm:12564) draws N segments stacked vertically:
 *   seg 0:     motor, animated from RopeMotorTiles[animFrame]
 *   seg 1..N-2: body tile $CE
 *   seg N-1:   knot tile $DE (overwrites last segment, bank_01.asm:12620)
 *
 * Smoke puffs (SmokeSpriteNumber subsystem) are spawned above the motor and
 * rendered as a single 8×8 tile cycling through $60→$62→$64→$66.
 *
 * Templates (bodyTemplate, knotTemplate) store parts at dy=0;
 * render() adds seg*16 to position each segment below the previous.
 */
export class RopeMechanismAppearance implements SpriteAppearance {
  readonly hitRect: HitRect

  constructor(
    readonly motorFrames:     readonly (readonly SpritePart[])[],
    readonly bodyTemplate:    readonly SpritePart[],
    readonly knotTemplate:    readonly SpritePart[],
    readonly smokePuffFrames: readonly (readonly SpritePart[])[],
    readonly segmentCount:    number,
  ) {
    this.hitRect = { dx: 0, dy: 0, w: 16, h: segmentCount * 16 }
  }

  static fromTables(
    chars:        Map<number, Char>,
    motorPalette: number,
    bodyPalette:  number,
    charHigh:     number,
    placeholder:  Char,
    segmentCount  = 5,
  ): RopeMechanismAppearance {
    const c  = (n: number): Char => chars.get(OBJ_CHAR_BASE + charHigh + (n & 0x1FF)) ?? placeholder
    const c0 = (n: number): Char => chars.get(OBJ_CHAR_BASE + (n & 0x1FF))            ?? placeholder
    return new RopeMechanismAppearance(
      MOTOR_TILES.map(t => bigTileParts(t, motorPalette, c)),
      bigTileParts(BODY_TILE, bodyPalette, c),
      bigTileParts(KNOT_TILE, bodyPalette, c),
      SMOKE_TILES.map(t => [{ char: c0(t), palette: bodyPalette, flipX: false, flipY: false, dx: 0, dy: 0 }]),
      segmentCount,
    )
  }

  render(ctx: RenderContext, target: RenderTarget, x: number, y: number): void {
    const animFrame = ctx.animFrame.value % 4
    for (let seg = 0; seg < this.segmentCount; seg++) {
      const isMotor = seg === 0
      const isKnot  = seg === this.segmentCount - 1 && !isMotor
      const parts   = isMotor ? this.motorFrames[animFrame]
                    : isKnot  ? this.knotTemplate
                    :           this.bodyTemplate
      const segDy   = seg * 16
      for (const part of parts) {
        target.blit8x8(
          part.char.getPixels(ctx),
          { x: x + part.dx, y: y + part.dy + segDy },
          ctx.palette.row(part.palette, ctx),
          part.flipX, part.flipY,
        )
      }
    }
    // CODE_018063 spawns puffs every 8 frames, alternating X positions
    // (DATA_01D717: db $F8,$00 → spriteX−8 or spriteX). Each puff lives 20
    // frames, so up to 3 are alive at once at different lifecycle stages.
    // X pattern at any moment: dx=0 (newest), dx=8 (mid), dx=0 (oldest).
    // Y rises 1 px per 8 frames of age (DEC SmokeSpriteYPos, bank_02.asm:3298).
    // Anchor places newest puff at (anchorX + puffDx, anchorY−6).
    const phase3 = animFrame % 3
    const renderPuff = (frameIdx: number, puffDx: number, ageRise: number): void => {
      for (const part of this.smokePuffFrames[frameIdx]) {
        target.blit8x8(
          part.char.getPixels(ctx),
          { x: x + part.dx + puffDx, y: y + part.dy - 6 - ageRise },
          ctx.palette.row(part.palette, ctx),
          part.flipX, part.flipY,
        )
      }
    }
    renderPuff( phase3              , 0, 0)  // newest: $62
    renderPuff((phase3 + 1) % 3     , 8, 1)  // middle: $64, +1px up
    renderPuff((phase3 + 2) % 3     , 0, 2)  // oldest: $66, +2px up
  }
}
