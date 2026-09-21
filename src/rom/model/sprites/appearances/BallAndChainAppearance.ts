import type { Char } from '../../chars/Char'
import type { HitRect } from '../SpriteAppearance'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $9E - Ball and Chain.
 *
 * Handler: BanzaiBnCGrayPlat trampoline → Banzai_Rotating (bank_02.asm:11365),
 * $9E/$A3 branch → CODE_02D62A (rotation, OAM emit).
 *
 * Init: InitBallNChain (bank_01.asm:531) sets SpriteMisc187B=$38 (radius=56 px).
 *
 * Both chain link ($E8) and sphere quadrant ($EA) OAM entries are 16×16 large
 * sprites (OAM table 2 size bit set via LDA #$05 / JMP CODE_02B7A7). Each
 * 16×16 entry expands to 4 × 8×8 SpriteParts here.
 *
 * Chain - CODE_02D750 (bank_02.asm:11566-11613):
 *   Tile $E8, attr $33 (no flip, palette 9, charHigh=$100). Two 16×16 entries.
 *   CODE_02D870 normalises pivot→sphere delta to $20=32 px (step).
 *   Link 1: TL at (0, +16) - half-step (CODE_02D750 halving: ASL+ROR)
 *   Link 2: TL at (0, +32) - full-step
 *   → 8 SpriteParts total.
 *
 * Sphere - CODE_02D813 (bank_02.asm:11620-11660):
 *   Tile $EA (the 6 NOPs at CODE_02D800 = $EA bytes on 65816, read as tile
 *   numbers - intentional dual-use of the SNES HW multiply delay loop).
 *   Attr DATA_02D80F = $33/$73/$B3/$F3 (no/X/Y/XY-flip, palette 9).
 *   DATA_02D807/80B offsets from sphere centre (0, +56):
 *     entry 0: (−8, −8) → TL at (−8, +48)  attr $33 no flip
 *     entry 1: (+8, −8) → TL at (+8, +48)   attr $73 X-flip
 *     entry 2: (−8, +8) → TL at (−8, +64)   attr $B3 Y-flip
 *     entry 3: (+8, +8) → TL at (+8, +64)    attr $F3 XY-flip
 *   → 16 SpriteParts total.
 */
export class BallAndChainAppearance extends StaticSpriteAppearance {
  // All parts start at dy≥16 (first chain link), so partsHitRect gives dy=16
  // and misses the anchor/pivot tile at dy=0..16. Redeclare hitRect here to
  // force dy=0, keeping the same lateral extent from the parts AABB.
  override readonly hitRect: HitRect

  private constructor(parts: readonly SpritePart[]) {
    super(parts)
    // Lateral: sphere Q0/Q2 start at dx=−8; Q1/Q3 end at dx+8=24 → w=32.
    // Vertical: anchor tile needs dy=0; sphere BR ends at dy=72+8=80 → h=80.
    this.hitRect = { dx: -8, dy: 0, w: 32, h: 80 }
  }

  /** Reconstruct from pre-serialised SpriteParts on the webview rehydrate path. */
  static fromParts(parts: readonly SpritePart[]): BallAndChainAppearance {
    return new BallAndChainAppearance(parts)
  }

  static fromTables(chars: Map<number, Char>, placeholder: Char): BallAndChainAppearance {
    const OBJ_BASE = 0x400
    const CHAR_HIGH = 0x100
    // OAM attr $33: bits 3-1 = OBJ palette 1 → CGRAM 8+1=9; bit 0 = charHigh=1
    const palette = 9

    // SNES 16×16 large-sprite expansion.
    // For a base tile N at TL corner, the 4 constituent 8×8 chars by flip state:
    //   none:  TL=N+$00  TR=N+$01  BL=N+$10  BR=N+$11
    //   flipX: TL=N+$01  TR=N+$00  BL=N+$11  BR=N+$10  (each also flipX'd)
    //   flipY: TL=N+$10  TR=N+$11  BL=N+$00  BR=N+$01  (each also flipY'd)
    //   both:  TL=N+$11  TR=N+$10  BL=N+$01  BR=N+$00  (each also flipX+flipY'd)
    // Index order: [visual-TL, visual-TR, visual-BL, visual-BR].
    const CORNER_OFF: Record<string, readonly number[]> = {
      none: [0x00, 0x01, 0x10, 0x11],
      flipX: [0x01, 0x00, 0x11, 0x10],
      flipY: [0x10, 0x11, 0x00, 0x01],
      both: [0x11, 0x10, 0x01, 0x00],
    }
    const SUB_DX = [0, 8, 0, 8] as const
    const SUB_DY = [0, 0, 8, 8] as const

    const bigTile = (
      baseTile: number,
      tlDx: number,
      tlDy: number,
      flipX: boolean,
      flipY: boolean,
    ): SpritePart[] => {
      const key = flipX && flipY ? 'both' : flipX ? 'flipX' : flipY ? 'flipY' : 'none'
      const offs = CORNER_OFF[key]!
      return Array.from({ length: 4 }, (_, i): SpritePart => ({
        char: chars.get(OBJ_BASE + CHAR_HIGH + baseTile + offs[i]!) ?? placeholder,
        palette,
        flipX,
        flipY,
        dx: tlDx + SUB_DX[i]!,
        dy: tlDy + SUB_DY[i]!,
      }))
    }

    // CODE_02D62A / CODE_02D750: chain tile $E8, 16×16, no flip.
    const CHAIN = 0xe8
    // CODE_02D813: sphere tile $EA (NOP opcode; read from CODE_02D800 delay NOPs).
    const SPHERE = 0xea

    const parts: SpritePart[] = [
      ...bigTile(CHAIN, 0, +16, false, false), // link 1: half-step 16 px
      ...bigTile(CHAIN, 0, +32, false, false), // link 2: full-step 32 px
      ...bigTile(SPHERE, -8, +48, false, false), // Q0 DATA_02D80F[0]=$33 no flip
      ...bigTile(SPHERE, +8, +48, true, false), // Q1 DATA_02D80F[1]=$73 X-flip
      ...bigTile(SPHERE, -8, +64, false, true), // Q2 DATA_02D80F[2]=$B3 Y-flip
      ...bigTile(SPHERE, +8, +64, true, true), // Q3 DATA_02D80F[3]=$F3 XY-flip
    ]
    return new BallAndChainAppearance(parts)
  }
}
