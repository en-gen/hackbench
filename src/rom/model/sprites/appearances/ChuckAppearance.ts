import type { Char } from '../../chars/Char'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Shared base class for the chuck-family sprite appearances ($91–$98).
 *
 * Why a base class: every chuck variant resolves OAM tiles through the same
 * `OBJ_BASE = $400` indexing, derives its body palette / charHigh from the
 * shared Sprite166EVals format (bit 0 = char-high select, bits 3–1 = OBJ
 * palette N), and mirrors its silhouette based on chuck-vs-Mario starting
 * position via the same FaceMario semantics
 * (`bank_01.asm:847` → `SubHorizPos:6124`: Y = 0 when
 * `PlayerXPosNow >= SpriteXPosLow,X`, i.e. Mario right of the chuck →
 * chuck face-right). Each subclass extends this base and uses the
 * provided builders / helpers, so we have one source of truth for the
 * chuck-family conventions and `SpriteFactory` no longer repeats the
 * palette / faceRight derivation per chuck dispatch.
 *
 * The base class deliberately stays in the appearance layer
 * (`src/rom/model/sprites/appearances/`) because face direction in the
 * editor is a render-time concern - `marioStartPx` is read once at sprite
 * construction and frozen into the parts list, no per-frame movement
 * simulation involved. Per `src/rom/model/sprites/CLAUDE.md`, behavior
 * classes are reserved for movement physics and overlay data.
 *
 * ## Naming convention
 *
 * Every concrete subclass MUST be named `<Variant>ChuckAppearance` - i.e.
 * keep the `*Appearance` suffix that all sprite-appearance classes use
 * (mirroring `StaticSpriteAppearance`, `KoopaAppearance`, etc.). Current
 * subclasses:
 *
 *   - `CharginChuckAppearance`   sprite $91
 *   - `SplittinChuckAppearance`  sprite $92
 *   - `BouncinChuckAppearance`   sprite $93
 *   - `WhistlinChuckAppearance`  sprite $94
 *   - `ClappinChuckAppearance`   sprite $95
 *   - `PuntinChuckAppearance`    sprite $97
 *   - `PitchinChuckAppearance`   sprite $98
 *
 * If new chuck variants surface (e.g. the unused $96 Chargin' Chuck clone),
 * register them under the same `<Variant>ChuckAppearance` shape.
 */
export abstract class ChuckAppearance extends StaticSpriteAppearance {
  /** SMW OAM char-base offset for sprite tiles. */
  static readonly OBJ_BASE = 0x400

  /** Build a 16x16 big-tile expansion: 4 8x8 chars at the four quadrants of
   *  a 16x16 cell. flipX picks the SMW chuck-draw tile-order convention so
   *  the left/right halves swap when the parent silhouette is hflipped. */
  static bigTile(
    chars: Map<number, Char>,
    placeholder: Char,
    baseTile: number,
    bdx: number,
    bdy: number,
    flipX: boolean,
    palette: number,
    charHigh: number,
  ): SpritePart[] {
    const co = flipX ? [0x01, 0x00, 0x11, 0x10] : [0x00, 0x01, 0x10, 0x11]
    return co.map((off, i) => ({
      char:
        chars.get(ChuckAppearance.OBJ_BASE + charHigh + ((baseTile + off) & 0x1ff)) ?? placeholder,
      palette,
      flipX,
      flipY: false,
      dx: bdx + [0, 8, 0, 8][i],
      dy: bdy + [0, 0, 8, 8][i],
    }))
  }

  /** Single 8x8 tile lookup with placeholder fallback. */
  static smallTile(
    chars: Map<number, Char>,
    placeholder: Char,
    tile: number,
    dx: number,
    dy: number,
    flipX: boolean,
    palette: number,
    charHigh: number,
  ): SpritePart {
    return {
      char: chars.get(ChuckAppearance.OBJ_BASE + charHigh + (tile & 0x1ff)) ?? placeholder,
      palette,
      flipX,
      flipY: false,
      dx,
      dy,
    }
  }

  /** Curried builder pair - the typical pattern in chuck `fromTables` methods.
   *  Saves boilerplate when many calls share the same chars/placeholder. */
  static builders(chars: Map<number, Char>, placeholder: Char) {
    return {
      bigTile: (
        baseTile: number,
        bdx: number,
        bdy: number,
        flipX: boolean,
        palette: number,
        charHigh: number,
      ) =>
        ChuckAppearance.bigTile(chars, placeholder, baseTile, bdx, bdy, flipX, palette, charHigh),
      smallTile: (
        tile: number,
        dx: number,
        dy: number,
        flipX: boolean,
        palette: number,
        charHigh: number,
      ) => ChuckAppearance.smallTile(chars, placeholder, tile, dx, dy, flipX, palette, charHigh),
    }
  }

  /** Decode a Sprite166EVals attr byte into OBJ palette + charHigh.
   *
   *  Format (bank_07.asm Sprite166EVals): `vhopppcc`
   *    bit 0     = charHigh select ($100 when set, $000 otherwise)
   *    bits 3-1  = OBJ palette index N → CGRAM row 8+N
   *  bits 6-4 are priority/X/V flags - not consumed here; that lives on
   *  the renderer side in mapStore.palette.row().
   */
  static bodyAttrs(attr: number): { palette: number; charHigh: number } {
    return {
      palette: 8 + ((attr >> 1) & 0x07),
      charHigh: (attr & 0x01) !== 0 ? 0x100 : 0,
    }
  }

  /** FaceMario semantics for static editor rendering: chuck faces right
   *  (toward Mario) when Mario's spawn X is at or right of the chuck's
   *  spawn X. Mirrors `SubHorizPos` (bank_01.asm:6124) returning Y = 0 in
   *  that case, which subsequent chuck inits store as the face direction. */
  static facesMario(spritePx: number, marioStartPx: number): boolean {
    return marioStartPx >= spritePx
  }
}
