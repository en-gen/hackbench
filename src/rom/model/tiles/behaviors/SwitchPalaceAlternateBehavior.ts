// Consumes: editorStore.switchPalaceState

import { editorStore } from '../../stores/editorStore'
import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

/**
 * Switch-palace block: renders its uncleared variant when
 * `editorStore.switchPalaceState[color]` is false, cleared variant when
 * true. SMW's mechanism is a Map16-pointer rewrite
 * ($06A-$06D ↔ $16A-$16D); the editor models the observable effect
 * directly by swapping subtile quads.
 *
 * Tiles in both $06X (off by default) and $16X (on by default) pages
 * carry this behavior with the same off/on quad pair, matching the
 * existing editor convention where both ids respond to the toggle.
 */
export class SwitchPalaceAlternateBehavior implements TileBehavior {
  constructor(
    readonly off: SubtileQuad,
    readonly on: SubtileQuad,
    readonly color: 0 | 1 | 2 | 3,
  ) {}

  selectQuad(): SubtileQuad {
    return editorStore.switchPalaceState[this.color] ? this.on : this.off
  }
}
