// Consumes: (none directly — palette via mapStore)

import type { Char } from '../../chars/Char'
import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'

// ASM source: WigglerGfx aka CODE_02F110 (bank_02.asm:14987).
//
// H-flip is direction-dependent via SpriteTableC2 (bank_02.asm:14945-14948):
//   SpriteTableC2 = (SpriteTableC2 << 1) | misc157C  (every 8 frames)
// At steady state all bits equal misc157C (0=face-right, 1=face-left).
// The GFX loop LSRs one bit per segment: bit=0 → ORA #$40 (H-flip); bit=1 →
// skip. So face-right → H-flip on every segment; face-left → no H-flip.
// The eye attribute AND#$F1 preserves bit 6 (H-flip) from the head slot.
//
// Per-segment loop draws 5 16×16 OAM big-tiles (head + 4 body). Head
// (segIdx 0) is forced to tile $8C; segIdx 1-4 read WigglerTiles[
// ((misc1570>>3) + segIdx) & 3] = $C4/$C6/$C8/$C6. Each segment is bobbed
// up by DATA_02F108[(misc1570>>3 + segIdx)&3] = [0,1,2,1] px.
//
// After the body, an 8×8 eye (tile $98) is emitted, attached to the head's
// OAM slot. `AND $F1 / ORA $0A` (bank_02.asm:15108) forces palette row 13.
// Eye X = head.X + DATA_02F2D3[misc157C] (= +0 face-right, +8 face-left);
// eye Y = head.Y - 8.
//
// Editor pose: render a faithful 4-frame wiggle. Body laid out horizontally
// trailing the head, 8 px between segments (segments overlap by half their
// width, matching the compact worm-like in-game appearance) — the chain
// trails opposite the face direction (face-left → trail right, face-right
// → trail left). One editor tick (ANIM_INTERVAL_MS ≈ 133 ms ≈ 8 game
// frames) advances the frame index, matching the in-game `misc1570>>3`
// cadence exactly.
//
// Palette: SpriteOBJAttribute = Sprite166EVals[$86] & $0F = $05 →
//   bodyPalette = 8 + (5>>1) = 10, charHigh = (5 & 1) ? 0x100 : 0 = 0x100.
//   eyePalette = 13 (forced; ASM mask preserves charHigh).

export const WIGGLER_HEAD_TILE         = 0x8C
export const WIGGLER_BODY_TILES        = [0xC4, 0xC6, 0xC8, 0xC6] as const
export const WIGGLER_EYE_TILE          = 0x98
export const WIGGLER_EYE_PALETTE       = 13
export const WIGGLER_BOB_OFFSETS       = [0, 1, 2, 1] as const // DATA_02F108
export const WIGGLER_SEGMENT_DX        = 8
export const WIGGLER_FRAME_COUNT       = WIGGLER_BODY_TILES.length // 4
export const WIGGLER_BODY_SEGMENT_COUNT = 4 // segIdx 1..4

const OBJ_BASE = 0x400

// Build a 16×16 big-tile as four 8×8 SpriteParts, respecting H-flip.
// H-flip (face-right): SNES OAM swaps columns and flips each 8×8 char →
//   TL←char[$01] flipX, TR←char[$00] flipX, BL←char[$11] flipX, BR←char[$10] flipX
// No flip (face-left): standard big-tile expansion →
//   TL←char[$00], TR←char[$01], BL←char[$10], BR←char[$11]
function makeBigTileParts(
  chars: Map<number, Char>,
  baseTile: number,
  charHigh: number,
  palette: number,
  hFlip: boolean,
  placeholder: Char,
): [SpritePart, SpritePart, SpritePart, SpritePart] {
  const c = (off: number) =>
    chars.get(OBJ_BASE + charHigh + ((baseTile + off) & 0x1FF)) ?? placeholder
  return hFlip
    ? [
        { char: c(0x01), palette, flipX: true,  flipY: false, dx: 0, dy: 0 },
        { char: c(0x00), palette, flipX: true,  flipY: false, dx: 8, dy: 0 },
        { char: c(0x11), palette, flipX: true,  flipY: false, dx: 0, dy: 8 },
        { char: c(0x10), palette, flipX: true,  flipY: false, dx: 8, dy: 8 },
      ]
    : [
        { char: c(0x00), palette, flipX: false, flipY: false, dx: 0, dy: 0 },
        { char: c(0x01), palette, flipX: false, flipY: false, dx: 8, dy: 0 },
        { char: c(0x10), palette, flipX: false, flipY: false, dx: 0, dy: 8 },
        { char: c(0x11), palette, flipX: false, flipY: false, dx: 8, dy: 8 },
      ]
}

/**
 * Sprite $86 (Wiggler). 5-segment chain (head + 4 body) plus an 8×8 eye
 * attached to the head. See top-of-file ASM commentary.
 */
export class WigglerAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private frame = 0

  constructor(
    readonly headBigTile: readonly [SpritePart, SpritePart, SpritePart, SpritePart],
    readonly bodyBigTiles: readonly [
      readonly [SpritePart, SpritePart, SpritePart, SpritePart],
      readonly [SpritePart, SpritePart, SpritePart, SpritePart],
      readonly [SpritePart, SpritePart, SpritePart, SpritePart],
      readonly [SpritePart, SpritePart, SpritePart, SpritePart],
    ],
    readonly eye: SpritePart,
    readonly faceLeft: boolean,
    readonly palette: number,
    readonly charHigh: number,
  ) {
    // Build a synthetic full-extent layout for hitRect: include all 5
    // segments at their resting positions plus the eye 8 px above the head.
    const trailDir = faceLeft ? +1 : -1
    const allParts: SpritePart[] = []
    for (let seg = 0; seg < 5; seg++) {
      const segDx = trailDir * seg * WIGGLER_SEGMENT_DX
      // Bob up to 2 px (max of WIGGLER_BOB_OFFSETS) to widen the rect.
      const bigTile = seg === 0 ? headBigTile : bodyBigTiles[seg - 1]
      for (const p of bigTile) {
        allParts.push({ ...p, dx: p.dx + segDx, dy: p.dy - 2 })
      }
    }
    allParts.push(eye)
    this.hitRect = partsHitRect(allParts)
  }

  tickAnimation(): void {
    this.frame = (this.frame + 1) % WIGGLER_FRAME_COUNT
  }

  render(target: RenderTarget, x: number, y: number, _behavior: SpriteBehavior, mapStore: MapStore): void {
    const trailDir = this.faceLeft ? +1 : -1
    // SNES OAM priority: eye=slot0 (front), head=slot1, seg4=slot5 (back).
    // Lower OAM index = higher priority = draws in front. Iterate back-to-front
    // so later blit8x8 calls paint over earlier ones correctly.
    for (let seg = 4; seg >= 0; seg--) {
      const tableIdx = (this.frame + seg) & 3
      const bigTile  = seg === 0 ? this.headBigTile : this.bodyBigTiles[tableIdx]
      const segDx    = trailDir * seg * WIGGLER_SEGMENT_DX
      const segDy    = -WIGGLER_BOB_OFFSETS[tableIdx]
      for (const p of bigTile) {
        target.blit8x8(
          p.char.getPixels(),
          { x: x + segDx + p.dx, y: y + segDy + p.dy },
          mapStore.palette.row(p.palette),
          p.flipX,
          p.flipY,
        )
      }
    }
    // Eye occupies OAM slot 0 (front of everything). Drawn last so it
    // paints over the head. Not shifted with trail; face direction selects dx.
    target.blit8x8(
      this.eye.char.getPixels(),
      { x: x + this.eye.dx, y: y + this.eye.dy },
      mapStore.palette.row(this.eye.palette),
      this.eye.flipX,
      this.eye.flipY,
    )
  }

  static fromTables(
    chars: Map<number, Char>,
    palette: number,
    charHigh: number,
    faceLeft: boolean,
    placeholder: Char,
  ): WigglerAppearance {
    // face-right → H-flip (SpriteTableC2 settled to 0x00 → bit=0 per segment)
    // face-left  → no flip (SpriteTableC2 settled to 0xFF → bit=1 per segment)
    const hFlip = !faceLeft
    const headBigTile  = makeBigTileParts(chars, WIGGLER_HEAD_TILE, charHigh, palette, hFlip, placeholder)
    const bodyBigTiles = WIGGLER_BODY_TILES.map(t =>
      makeBigTileParts(chars, t, charHigh, palette, hFlip, placeholder),
    ) as unknown as readonly [
      readonly [SpritePart, SpritePart, SpritePart, SpritePart],
      readonly [SpritePart, SpritePart, SpritePart, SpritePart],
      readonly [SpritePart, SpritePart, SpritePart, SpritePart],
      readonly [SpritePart, SpritePart, SpritePart, SpritePart],
    ]

    // DATA_02F2D3[misc157C]: eye at head.X+0 (face-right) or head.X+8 (face-left).
    // Eye attribute inherits H-flip from head (AND #$F1 preserves bit 6).
    const eyeDx = faceLeft ? 8 : 0
    const eye: SpritePart = {
      char:    chars.get(OBJ_BASE + charHigh + WIGGLER_EYE_TILE) ?? placeholder,
      palette: WIGGLER_EYE_PALETTE,
      flipX:   hFlip,
      flipY:   false,
      dx:      eyeDx,
      dy:      -8,
    }

    return new WigglerAppearance(headBigTile, bodyBigTiles, eye, faceLeft, palette, charHigh)
  }
}
