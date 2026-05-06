// Consumes: nothing
import type { Char } from '../../chars/Char'
import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import type { SpritePart } from './StaticSpriteAppearance'

const OBJ_CHAR_BASE = 0x400

/**
 * charHigh = 0x100: motor OAM attr $37 bit 0 = 1; chain OAM attr $33/$B3 bit 0 = 1.
 * ChainsawGfx (bank_03.asm:7685-7689) hardcodes these attrs; they do not come
 * from the per-sprite ROM attr table.
 */
const CHAR_HIGH = 0x100

/**
 * ChainsawMotorTiles (bank_03.asm:7622): db $E0,$C2,$C0,$C2 — 4-frame animation.
 * Index = (effFrame >> 2) & 3. Frame 0 shown at rest; all 4 rendered in the editor.
 */
const MOTOR_TILES = [0xE0, 0xC2, 0xC0, 0xC2] as const

/**
 * Chain link tiles (bank_03.asm:7682-7684):
 *   LDA #$AE → OAMTileNo+$104,Y  (first chain segment)
 *   LDA #$8E → OAMTileNo+$108,Y  (second chain segment)
 */
const CHAIN_TILE  = 0xAE
const CHAIN2_TILE = 0x8E

/** Motor OAM attr $37: ($37 >> 1) & 7 = 3 → CGRAM row 8+3 = 11. */
const MOTOR_PALETTE = 11
/** Chain OAM attr $33/$B3: ($33 >> 1) & 7 = 1 → CGRAM row 8+1 = 9. */
const CHAIN_PALETTE = 9

/**
 * Y offset from motor OAM entry to first chain segment.
 * DATA_03C25F (bank_03.asm:7626): db $F2,$0E.
 *   index 0 ($65): $F2 = −14 signed → chain extends above motor.
 *   index 1 ($66): $0E = +14 → chain extends below motor (upside-down).
 * ChainsawGfx adds this to the Y-8 base twice, yielding a second segment
 * at chainDy×2 from the motor.
 */
const CHAIN_DY_NORMAL = -14
const CHAIN_DY_INVERT = +14

/**
 * Expand a single OAM 16×16 tile into four 8×8 SpriteParts.
 * When flipY is true, sub-tiles are reordered and individually flipped to
 * replicate SNES hardware 16×16 vertical-flip behaviour.
 */
function bigTileParts(
  tile:    number,
  palette: number,
  flipY:   boolean,
  dx:      number,
  dy:      number,
  c: (n: number) => Char,
): SpritePart[] {
  const tl = tile
  const tr = tile + 1
  const bl = tile + 0x10
  const br = tile + 0x11
  if (!flipY) {
    return [
      { char: c(tl), palette, flipX: false, flipY: false, dx: dx,     dy: dy },
      { char: c(tr), palette, flipX: false, flipY: false, dx: dx + 8, dy: dy },
      { char: c(bl), palette, flipX: false, flipY: false, dx: dx,     dy: dy + 8 },
      { char: c(br), palette, flipX: false, flipY: false, dx: dx + 8, dy: dy + 8 },
    ]
  }
  // flipY: swap row order; flip each 8×8 tile vertically.
  return [
    { char: c(bl), palette, flipX: false, flipY: true, dx: dx,     dy: dy },
    { char: c(br), palette, flipX: false, flipY: true, dx: dx + 8, dy: dy },
    { char: c(tl), palette, flipX: false, flipY: true, dx: dx,     dy: dy + 8 },
    { char: c(tr), palette, flipX: false, flipY: true, dx: dx + 8, dy: dy + 8 },
  ]
}

/**
 * Sprite $65/$66 (Chainsaw, line-guided).
 *
 * ChainsawGfx (bank_03.asm:7639) writes three 16×16 OAM entries:
 *   [0] motor:  ChainsawMotorTiles[effFrame>>2 & 3], attr $37
 *               at OAM position (SprX−8, SprY−8)
 *   [1] chain:  tile $AE, attr $33 ($65) / $B3 ($66)
 *               at (SprX−8, SprY−8 + _3)
 *   [2] chain2: tile $8E, same attr
 *               at (SprX−8, SprY−8 + _3×2)
 *
 * _3 = DATA_03C25F[spriteId−$65]: $F2=−14 for $65, $0E=+14 for $66.
 *
 * SpriteFactory sets the sprite anchor at (trackTile.col×16−8, trackTile.row×16−8)
 * via lineGuideAnchor(drawOffset=−8,−8), so the motor renders at (0,0) and
 * the chain segments at (0, chainDy) and (0, chainDy×2) relative to anchor.
 */
export class ChainsawAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private motorFrame = 0

  constructor(
    readonly motorFrames: readonly (readonly SpritePart[])[],
    readonly chainParts:  readonly SpritePart[],
  ) {
    // Derive orientation from chain direction: chainParts[0].dy < 0 → chain above motor ($65).
    const chainDy = chainParts[0]?.dy ?? 0
    this.hitRect = chainDy < 0
      ? { dx: 0, dy: -28, w: 16, h: 44 }  // chain above: −28..15
      : { dx: 0, dy:  0,  w: 16, h: 44 }  // chain below: 0..43
  }

  static fromTables(
    chars:        Map<number, Char>,
    isUpsideDown: boolean,
    placeholder:  Char,
  ): ChainsawAppearance {
    const c = (n: number): Char => chars.get(OBJ_CHAR_BASE + CHAR_HIGH + n) ?? placeholder
    const chainDy = isUpsideDown ? CHAIN_DY_INVERT : CHAIN_DY_NORMAL
    const flipY   = isUpsideDown
    const motorFrames = MOTOR_TILES.map(t => bigTileParts(t, MOTOR_PALETTE, false, 0, 0, c))
    const chainParts: SpritePart[] = [
      ...bigTileParts(CHAIN_TILE,  CHAIN_PALETTE, flipY, 0, chainDy,     c),
      ...bigTileParts(CHAIN2_TILE, CHAIN_PALETTE, flipY, 0, chainDy * 2, c),
    ]
    return new ChainsawAppearance(motorFrames, chainParts)
  }

  tickAnimation(): void {
    this.motorFrame = (this.motorFrame + 1) & 3
  }

  render(target: RenderTarget, x: number, y: number, _behavior: SpriteBehavior, mapStore: MapStore): void {
    for (const part of this.motorFrames[this.motorFrame]) {
      target.blit8x8(
        part.char.getPixels(),
        { x: x + part.dx, y: y + part.dy },
        mapStore.palette.row(part.palette),
        part.flipX, part.flipY,
      )
    }
    for (const part of this.chainParts) {
      target.blit8x8(
        part.char.getPixels(),
        { x: x + part.dx, y: y + part.dy },
        mapStore.palette.row(part.palette),
        part.flipX, part.flipY,
      )
    }
  }
}
