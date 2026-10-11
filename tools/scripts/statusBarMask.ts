/**
 * The one place that says which rows of a layer 3 (BG3) capture are the
 * status bar and not map content (#880). Every BG3-vs-capture comparison
 * asks statusBarRows(); no test or comparison keeps its own number.
 *
 * Trace (SMWDisX, hand-read 2026-10-11):
 * - constants.asm:57 !StatusBarHeight = 36 scanlines.
 * - bank_00.asm:329-334 loads the V-timer with that height and enables V-IRQ.
 * - bank_00.asm:338-341 sets BG3 scroll to 0 in vblank: the bar's scroll.
 * - bank_00.asm:455-462 (I_IRQ, normal rooms) writes the playfield Layer3
 *   scroll when the IRQ fires, so scanline V and above show the bar's scroll.
 * - Morton and Roy rooms: the selector at bank_00.asm:423-432 (IRQNMICommand
 *   bit 6, ActiveBoss whose BossCeilingHeights entry equals
 *   !RoyMortonCeilingHeight, constants.asm:138 = 42) raises the V-timer to
 *   !StatusBarHeight+9 = 45. Those rooms also set IRQNMICommand bit 7, so the
 *   IRQ branches to CODE_0083BA (bank_00.asm:449-450) and the bar's IRQ never
 *   writes the playfield layer 3 scroll. CODE_0083F3 (:505-511) switches to
 *   mode 7 from line 45 on, which hides layer 3; a second IRQ at the floor
 *   (CODE_0083D0, :489-496) follows. So the 46-row mask there is "layer 3 is
 *   the bar down to line 45, then not displayed", not a scroll handoff.
 * - Bowser's room skips the IRQ (bank_00.asm:415-421) and is mode 7 the whole
 *   frame: layer 3 is never displayed, so the 36-line fallback hides nothing
 *   that is on screen.
 *
 * Picture line y shows scanline y + 1 (docs/capture-viewer.md, Status bar
 * band), so a timer V masks lines 0..V, V + 1 rows. Prefer the capture's own
 * statusBar.irqLine, which already carries the Morton/Roy 45; the constant is
 * the fallback when no line was recorded (absent or -1).
 */
export const STATUS_BAR_HEIGHT = 36

/** Number of BG3 rows (from line 0) that are the status bar. */
export function statusBarRows(irqLine?: number | null): number {
  return (irqLine != null && irqLine >= 0 ? irqLine : STATUS_BAR_HEIGHT) + 1
}

/** Mark the status-bar rows of a width x height picture as not compared. */
export function maskStatusBar(skip: Uint8Array, width: number, height: number, rows: number): void {
  skip.fill(1, 0, Math.min(height, rows) * width)
}
