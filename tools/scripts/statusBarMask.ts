/**
 * The one place that says which rows of a layer 3 (BG3) capture are the
 * status bar and not map content (#880). Every BG3-vs-capture comparison
 * asks statusBarRows(); no test or comparison keeps its own number.
 *
 * Trace (SMWDisX, hand-read 2026-10-11):
 * - constants.asm:57 !StatusBarHeight = 36 scanlines.
 * - bank_00.asm:329-334 loads the V-timer with that height and enables V-IRQ.
 * - bank_00.asm:338-341 sets BG3 scroll to 0 in vblank: the bar's scroll.
 * - bank_00.asm:455-462 (I_IRQ) writes the playfield Layer3 scroll when the
 *   IRQ fires, so scanline V and above show the bar's scroll.
 * - bank_00.asm:423-432: with IRQNMICommand bit 6 set (a boss room), an
 *   ActiveBoss whose BossCeilingHeights entry equals !RoyMortonCeilingHeight
 *   (constants.asm:138 = 42, the Morton and Roy rooms) raises the V-timer to
 *   !StatusBarHeight+9 = 45. Any other room keeps 36.
 *
 * Picture line y shows scanline y + 1 (docs/capture-viewer.md, Status bar
 * band), so a timer V masks lines 0..V, V + 1 rows.
 *
 * Prefer the capture's own statusBar.irqLine (the V-timer the game really
 * wrote, so it already carries the Morton/Roy 45); fall back to the constant
 * when a capture has none. A capture cannot say Morton/Roy any other way
 * than that line, so the fallback takes an explicit flag.
 */
export const STATUS_BAR_HEIGHT = 36
export const MORTON_ROY_EXTRA = 9

/** Number of BG3 rows (from line 0) that are the status bar. */
export function statusBarRows(irqLine?: number | null, mortonRoy = false): number {
  const v =
    irqLine != null && irqLine >= 0
      ? irqLine
      : STATUS_BAR_HEIGHT + (mortonRoy ? MORTON_ROY_EXTRA : 0)
  return v + 1
}

/** Mark the status-bar rows of a width x height picture as not compared. */
export function maskStatusBar(skip: Uint8Array, width: number, height: number, rows: number): void {
  skip.fill(1, 0, Math.min(height, rows) * width)
}
