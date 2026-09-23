// Consumes: (none)

import type { RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'
import type { Char } from '../../chars/Char'
import type { SpriteLayout } from '../../../SpriteTileLoader'

/**
 * Sprite appearance for any sprite with 2-frame animated wings. Frame
 * state is owned internally and advanced once per sprite-animation tick.
 *
 * Wing frames are two arrays of SpritePart indexed by animFrame % 2:
 *   frame 0 -- wings down (8x8 tile $5D)
 *   frame 1 -- wings up   (16x16 tile $C6, expanded to four 8x8 parts)
 *
 * Wing offsets for ? blocks ($83/$84) come from CODE_019E95 (bank_01.asm:4083)
 * pre-adjustments. Para-koopa wing offsets ($0A/$0B/$0C) come from the raw
 * KoopaWingGfxRt tables (bank_01.asm:4006) with no pre-adjustment.
 *
 * wingsInFront controls draw order:
 *   false (default) -- wings before body (wings behind, used for ? blocks)
 *   true            -- body before wings  (wings in front, used for para-koopas)
 *
 * The behavior-driven movement annotation this class used to draw was
 * removed; see docs/sprites/sprite-overlay-removal.md.
 */

export class WingedSpriteAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private frame = 0

  constructor(
    readonly bodyParts: readonly SpritePart[],
    readonly wingFrames: readonly [readonly SpritePart[], readonly SpritePart[]],
    readonly wingsInFront: boolean = false,
  ) {
    this.hitRect = partsHitRect([...bodyParts, ...wingFrames[0], ...wingFrames[1]])
  }

  tickAnimation(): void {
    this.frame = (this.frame + 1) % this.wingFrames.length
  }

  render(
    target: RenderTarget,
    x: number,
    y: number,
    _behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void {
    const wingParts = this.wingFrames[this.frame]
    const blit = (part: SpritePart) => {
      const pixels = part.char.getPixels()
      const row = mapStore.palette.row(part.palette)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
    if (this.wingsInFront) {
      for (const part of this.bodyParts) blit(part)
      for (const part of wingParts) blit(part)
    } else {
      for (const part of wingParts) blit(part)
      for (const part of this.bodyParts) blit(part)
    }
  }

  private static layoutToBodyParts(
    layout: SpriteLayout | null,
    chars: Map<number, Char>,
    placeholder: Char,
  ): SpritePart[] {
    return (layout?.tiles ?? []).map(t => ({
      char: chars.get(t.charNum) ?? placeholder,
      palette: t.palette,
      flipX: t.flipX,
      flipY: t.flipY,
      dx: t.dx,
      dy: t.dy,
    }))
  }

  /**
   * Para-koopa wing frames from KoopaWingGfxRt (bank_01.asm:4006).
   * Shows right wing (SpriteMisc157C=1 -> right-facing body by default).
   * Frame 0: 16x16 right wing open (tile $C6, table index 3).
   * Frame 1: 8x8 right wing closed (tile $5D, table index 2).
   */
  private static buildKoopaWingFrames(
    chars: Map<number, Char>,
    placeholder: Char,
  ): [SpritePart[], SpritePart[]] {
    const WING_PAL = 11
    const BASE = 0x400
    const c = (n: number) => chars.get(BASE + n) ?? placeholder
    const p = (n: number, dx: number, dy: number, flipX: boolean): SpritePart => ({
      char: c(n),
      palette: WING_PAL,
      flipX,
      flipY: false,
      dx,
      dy,
    })
    const wf0: SpritePart[] = [
      p(0xc6, 9, -12, false),
      p(0xc7, 17, -12, false),
      p(0xd6, 9, -4, false),
      p(0xd7, 17, -4, false),
    ]
    const wf1: SpritePart[] = [p(0x5d, 9, -4, false)]
    return [wf0, wf1]
  }

  /**
   * $08/$09 (Green Para-Koopa) and $0A/$0B/$0C (Red/Yellow Para-Koopa).
   * All share the Spr0to13Gfx -> KoopaWingGfxRt path with wingsInFront=true.
   */
  static fromParaKoopa(
    chars: Map<number, Char>,
    placeholder: Char,
    layout: SpriteLayout | null,
  ): WingedSpriteAppearance {
    const bodyParts = WingedSpriteAppearance.layoutToBodyParts(layout, chars, placeholder)
    const [wf0, wf1] = WingedSpriteAppearance.buildKoopaWingFrames(chars, placeholder)
    return new WingedSpriteAppearance(bodyParts, [wf0, wf1], true)
  }

  /**
   * $10 Para-Goomba. GoombaWingGfxRt (bank_01.asm:2022).
   * Frame 0: 16x16 wings open ($C6). Frame 1: 8x8 wings closed ($5D).
   * Left wing is H-flipped; right wing is not (GoombaWingGfxProp $46/$06 + EOR $40).
   * wingsInFront=false (wings behind goomba body).
   */
  static fromParaGoomba(
    chars: Map<number, Char>,
    placeholder: Char,
    layout: SpriteLayout | null,
  ): WingedSpriteAppearance {
    const gBody = WingedSpriteAppearance.layoutToBodyParts(layout, chars, placeholder)
    const GPAL = 11
    const GBASE = 0x400
    const gc = (n: number) => chars.get(GBASE + n) ?? placeholder
    const gp = (n: number, dx: number, dy: number, flipX: boolean): SpritePart => ({
      char: gc(n),
      palette: GPAL,
      flipX,
      flipY: false,
      dx,
      dy,
    })
    // GoombaWingGfxRt (bank_01.asm:2022):
    // iter=1 → GoombaWingGfxProp[1]=$06 EOR $40=$46 → left wing is H-flipped.
    // iter=0 → GoombaWingGfxProp[0]=$46 EOR $40=$06 → right wing is not flipped.
    // X offsets: DATA_018DC7 with _4=0 adds 8; left=index9=$F5=-11, right=index8=$0B=+11.
    // Frame-1 X: left=index13=$FC=-4, right=index12=$0B=+11. Y always+1 (DATA_018DD7[4/5]).
    const gwf0: SpritePart[] = [
      // Left wing: H-flipped 16x16 $C6 at (-11, -9) - col order swaps for H-flip
      gp(0xc7, -11, -9, true),
      gp(0xc6, -3, -9, true),
      gp(0xd7, -11, -1, true),
      gp(0xd6, -3, -1, true),
      // Right wing: no-flip 16x16 $C6 at (+11, -9)
      gp(0xc6, 11, -9, false),
      gp(0xc7, 19, -9, false),
      gp(0xd6, 11, -1, false),
      gp(0xd7, 19, -1, false),
    ]
    const gwf1: SpritePart[] = [
      gp(0x5d, -4, 1, true), // left wing: H-flipped, X=DATA_018DC7[13]=-4
      gp(0x5d, 11, 1, false), // right wing: no-flip, X=DATA_018DC7[12]=+11
    ]
    return new WingedSpriteAppearance(gBody, [gwf0, gwf1])
  }

  /**
   * $83/$84 (Left/Right Flying ? Block). Wing offsets from CODE_019E95
   * (bank_01.asm:4083) pre-adjustment path; para-koopas skip that path.
   * Frame 0: 8x8 tile $5D per wing (small).
   * Frame 1: 16x16 tile $C6 per wing (large), split into four 8x8 parts.
   * wingsInFront=false (wings behind block body).
   */
  static fromFlyingQBlock(
    chars: Map<number, Char>,
    placeholder: Char,
    layout: SpriteLayout | null,
  ): WingedSpriteAppearance {
    const bodyParts = WingedSpriteAppearance.layoutToBodyParts(layout, chars, placeholder)
    const WING_PAL = 11
    const BASE = 0x400
    const c = (n: number) => chars.get(BASE + n) ?? placeholder
    const p = (n: number, dx: number, dy: number, flipX: boolean): SpritePart => ({
      char: c(n),
      palette: WING_PAL,
      flipX,
      flipY: false,
      dx,
      dy,
    })
    const wf0: SpritePart[] = [p(0x5d, -3, -2, true), p(0x5d, 11, -2, false)]
    const wf1: SpritePart[] = [
      p(0xc7, -11, -10, true),
      p(0xc6, -3, -10, true),
      p(0xd7, -11, -2, true),
      p(0xd6, -3, -2, true),
      p(0xc6, 11, -10, false),
      p(0xc7, 19, -10, false),
      p(0xd6, 11, -2, false),
      p(0xd7, 19, -2, false),
    ]
    return new WingedSpriteAppearance(bodyParts, [wf0, wf1])
  }
}
