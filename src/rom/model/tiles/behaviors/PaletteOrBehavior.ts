// Consumes: nothing (delegates inner behavior)
import type { CellBox, RenderTarget } from '../../RenderTarget'
import type { MapStore } from '../../stores/mapStore'
import { SubTile } from '../SubTile'
import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

/**
 * TileBehavior decorator that ORs every subtile's palette field with a
 * fixed mask. Used to mirror SMW's L2 strip-render mutation at
 * `bank_05.asm:1387-1391` and `1503-1507`:
 *
 *     LDA.W ObjectTileset
 *     CMP.B #$03
 *     BNE +
 *     LDY.W #$1000               ; OR mask = bit 12 = palette index += 4
 *   + STY.B _3
 *     ...
 *     LDA.B [_A],Y               ; raw subtile attribute from Map16 atlas
 *     ORA.B _3                   ; force high palette bit when tileset 3
 *     STA.W Layer2VramBuffer,X
 *
 * For object-stream L2 in tileset-3 levels (e.g. `$009`, `$115`, `$1e2`)
 * the ROM atlas encodes L2 tiles with palette 2, but the strip uploader
 * OR's `$1000` (palette bit 2 = +4) so they end up in the 4-7 palette
 * range — typically palette 6 (CGRAM row 6, StandardColors). Tilesets
 * other than 3 don't OR; L2 there uses whatever the atlas encodes.
 *
 * The mask is a value to OR with the 3-bit palette index (not a bit
 * position into the full subtile word).
 */
export class PaletteOrBehavior implements TileBehavior {
  // Conditional optional methods: only forward to `inner` when it actually
  // implements them. Re-creating the closures lets TS see the matching
  // narrow signatures without our forwarder having to widen the return type.
  selectAlpha?: (cell: CellBox, mapStore: MapStore) => number
  renderOverlay?: (target: RenderTarget, cell: CellBox, mapStore: MapStore) => void

  constructor(
    readonly inner: TileBehavior,
    /** Value OR'd with each subtile's `palette` (0..7). Typically `4`. */
    readonly mask: number,
  ) {
    if (inner.selectAlpha) {
      this.selectAlpha = (cell, mapStore) => inner.selectAlpha!(cell, mapStore)
    }
    if (inner.renderOverlay) {
      this.renderOverlay = (target, cell, mapStore) => inner.renderOverlay!(target, cell, mapStore)
    }
  }

  selectQuad(cell: CellBox, mapStore: MapStore): SubtileQuad {
    const quad = this.inner.selectQuad(cell, mapStore)
    return [
      this.shiftPalette(quad[0]),
      this.shiftPalette(quad[1]),
      this.shiftPalette(quad[2]),
      this.shiftPalette(quad[3]),
    ]
  }

  private shiftPalette(sub: SubTile): SubTile {
    const newPal = (sub.palette | this.mask) & 0x7
    if (newPal === sub.palette) return sub
    return new SubTile(sub.char, newPal, sub.flipX, sub.flipY, sub.priority)
  }
}
