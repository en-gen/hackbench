/**
 * Puts Palettes in the left activity bar and routes a row to its tab.
 * Same shape as GfxExplorerContribution, including wiring an explorer that
 * Theia restored with the saved layout before this contribution started.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command } from '@theia/core/lib/common'
import {
  PaletteExplorerWidget,
  PaletteOpenRequest,
  PALETTE_EXPLORER_ID,
} from './palette-explorer-widget'
import { PaletteGroupViewWidget } from './palette-group-view-widget'
import { PALETTE_GROUP_VIEW_ID } from './palette-view-model'
import { PreviewTabs } from './preview-tabs'

export const ShowPaletteExplorerCommand: Command = {
  id: 'hackbench.palettes.focus',
  label: 'Palettes',
  category: 'HackBench',
}

@injectable()
export class PaletteExplorerContribution extends AbstractViewContribution<PaletteExplorerWidget> {
  @inject(PreviewTabs) protected readonly previews!: PreviewTabs

  constructor() {
    super({
      widgetId: PALETTE_EXPLORER_ID,
      widgetName: 'Palettes',
      defaultWidgetOptions: { area: 'left', rank: 300 },
      toggleCommandId: ShowPaletteExplorerCommand.id,
    })
  }

  async onStart(): Promise<void> {
    this.widgetManager.onDidCreateWidget(({ factoryId, widget }) => {
      if (factoryId === PALETTE_EXPLORER_ID) this.wire(widget as PaletteExplorerWidget)
    })
    // Theia restores saved-layout widgets BEFORE contributions start, so an
    // explorer that came back with the layout predates the subscription above
    // and would never be wired. Its rows render and its clicks do nothing.
    for (const existing of this.widgetManager.getWidgets(PALETTE_EXPLORER_ID)) {
      this.wire(existing as PaletteExplorerWidget)
    }
    await this.openView({ activate: false, reveal: false })
  }

  protected wire(explorer: PaletteExplorerWidget): void {
    explorer.onOpen(req => void this.openGroup(req))
  }

  /** Public so Playwright can open a tab without synthesising tree clicks. */
  async openGroup(req: PaletteOpenRequest): Promise<PaletteGroupViewWidget> {
    const opts = { manifestPath: req.manifestPath, groupId: req.groupId, variant: req.variant }
    const apply = (w: PaletteGroupViewWidget) => w.open(opts)
    if (req.pinned) {
      return this.previews.pin<PaletteGroupViewWidget>(
        PALETTE_GROUP_VIEW_ID,
        { groupId: req.groupId, variant: req.variant ?? null },
        apply,
        p => p.shows(opts),
      )
    }
    return this.previews.preview<PaletteGroupViewWidget>(PALETTE_GROUP_VIEW_ID, apply)
  }
}
