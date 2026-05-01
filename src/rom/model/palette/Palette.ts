import type { RgbaColor } from '../../GraphicsDecoder'
import type { Color } from './Color'

const ROWS = 16
const COLS = 16

/**
 * A 16×16 grid of Color cells plus a back-area color.
 *
 * Every cell is addressable and carries its own behavior, so any cell
 * can be animated or transformed without touching its neighbors or
 * introducing a palette-level wrapper. `row(idx)` materializes an
 * entire row by asking each cell for its RGBA; a scratch buffer is
 * reused across calls so the hot path is allocation-free. Cells that
 * cycle (CyclingColorBehavior) read `editorStore.palAnimFrame` directly.
 *
 * The scratch pattern means callers must consume the returned row
 * before the next `row()` call with the same index — in practice
 * SubTile.render reads the row and passes it straight to the
 * RenderTarget's blit, so the constraint is met naturally.
 */
export class Palette {
  private readonly scratch: RgbaColor[][]

  constructor(
    readonly cells: readonly (readonly Color[])[],
    readonly backAreaColor: Color,
  ) {
    this.scratch = Array.from({ length: ROWS }, () => new Array(COLS))
  }

  row(idx: number): RgbaColor[] {
    const out = this.scratch[idx]
    const cells = this.cells[idx]
    for (let c = 0; c < COLS; c++) out[c] = cells[c].rgba()
    return out
  }

  color(row: number, col: number): RgbaColor {
    return this.cells[row][col].rgba()
  }
}
