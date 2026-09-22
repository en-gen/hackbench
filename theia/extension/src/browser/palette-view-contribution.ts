/**
 * Reaches the palette view from a command (View menu, activity bar), and
 * docks it in the RIGHT sidebar beside Outline.
 *
 * It keeps its own group list rather than contributing a tree to the left
 * bar: the five groups render differently from one another (8 variants over
 * two CGRAM rows for the backgrounds, 1 over ten rows for the shared sprite
 * colours, 4 named variants on one row for the players), so the selector and
 * the content belong to the same widget.
 */
import { injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command } from '@theia/core/lib/common'
import { PaletteViewWidget, PALETTE_VIEW_ID } from './palette-view-widget'

export const ShowPaletteViewCommand: Command = {
  id: 'hackbench.palettes.focus',
  label: 'Palettes',
  category: 'HackBench',
}

/**
 * Sixteen swatches plus a CGRAM row label do not fit the shell's default
 * right panel. Widest case is the shared sprite group, 16 columns over 10
 * rows.
 */
const DEFAULT_RIGHT_PANEL_WIDTH = 520

@injectable()
export class PaletteViewContribution extends AbstractViewContribution<PaletteViewWidget> {
  constructor() {
    super({
      widgetId: PALETTE_VIEW_ID,
      widgetName: 'Palettes',
      defaultWidgetOptions: { area: 'right', rank: 200 },
      toggleCommandId: ShowPaletteViewCommand.id,
    })
  }

  /** Present but not focused on first launch, matching Maps' openView call. */
  async initializeLayout(): Promise<void> {
    await this.openView({ activate: false, reveal: true })
    // Only a FIRST-RUN default: Theia persists the layout, so a width the
    // user sets themselves is never overwritten by this.
    this.shell.rightPanelHandler.resize(DEFAULT_RIGHT_PANEL_WIDTH)
  }
}
