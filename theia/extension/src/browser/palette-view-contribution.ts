/**
 * Reaches the palette view from a command (View menu, activity bar), and
 * opens it in the MAIN editor area rather than the sidebar: the content
 * needs the width, and there is only one widget, no separate navigator.
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

@injectable()
export class PaletteViewContribution extends AbstractViewContribution<PaletteViewWidget> {
  constructor() {
    super({
      widgetId: PALETTE_VIEW_ID,
      widgetName: 'Palettes',
      defaultWidgetOptions: { area: 'main' },
      toggleCommandId: ShowPaletteViewCommand.id,
    })
  }

  /** Present but not focused on first launch, matching Maps' openView call for the sidebar. */
  async initializeLayout(): Promise<void> {
    await this.openView({ activate: false, reveal: true })
  }
}
