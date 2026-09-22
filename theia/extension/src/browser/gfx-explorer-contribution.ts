/**
 * Puts the Graphics view in the shell's left sidebar and on the View menu.
 *
 * Also wires a row click to opening its tile sheet. For Maps that wiring
 * lives in HackBenchContribution.show(), called each time a project opens;
 * that file is out of scope for this change, so it lives here instead.
 *
 * The view is user-closable, and its WidgetFactory builds a fresh instance
 * (with its own onFileOpened emitter) on every reopen, so wiring is done
 * from widgetManager.onDidCreateWidget rather than once in onStart: a
 * one-shot subscription there only ever reaches the instance that existed
 * at startup, and goes silently dead the first time the user closes and
 * reopens the view. Music's explorer contribution uses the same shape.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command } from '@theia/core/lib/common'
import { GfxExplorerWidget, GFX_EXPLORER_ID } from './gfx-explorer-widget'
import { GfxViewWidget, GFX_VIEW_ID } from './gfx-view-widget'
import { PreviewTabs } from './preview-tabs'

export const ShowGfxExplorerCommand: Command = {
  id: 'hackbench.gfx.focus',
  label: 'Graphics',
  category: 'HackBench',
}

@injectable()
export class GfxExplorerContribution extends AbstractViewContribution<GfxExplorerWidget> {
  @inject(PreviewTabs) protected readonly previews!: PreviewTabs

  constructor() {
    super({
      widgetId: GFX_EXPLORER_ID,
      widgetName: 'Graphics',
      defaultWidgetOptions: { area: 'left', rank: 200 },
      toggleCommandId: ShowGfxExplorerCommand.id,
    })
  }

  async onStart(): Promise<void> {
    this.widgetManager.onDidCreateWidget(({ factoryId, widget }) => {
      if (factoryId === GFX_EXPLORER_ID) this.wireExplorer(widget as GfxExplorerWidget)
    })
    // Theia restores saved-layout widgets BEFORE contributions start, so an
    // explorer that came back with the layout predates the subscription above
    // and would never be wired. Its rows render and its clicks do nothing.
    for (const existing of this.widgetManager.getWidgets(GFX_EXPLORER_ID)) {
      this.wireExplorer(existing as GfxExplorerWidget)
    }
    // Attach immediately so the rail icon is reachable before any project
    // opens; this also creates the first instance, which the subscription
    // above (already registered) picks up like any later one.
    await this.openView({ activate: false, reveal: false })
  }

  protected wireExplorer(explorer: GfxExplorerWidget): void {
    explorer.onFileOpened(async ({ manifestPath, index, label, pinned }) => {
      const apply = (w: GfxViewWidget) => w.open({ manifestPath, index, label })
      if (pinned) {
        await this.previews.pin<GfxViewWidget>(GFX_VIEW_ID, { index }, apply, p => p.shows(index))
      } else {
        await this.previews.preview<GfxViewWidget>(GFX_VIEW_ID, apply)
      }
    })
  }
}
