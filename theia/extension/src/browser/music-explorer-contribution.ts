/**
 * Puts the music explorer in the shell's left sidebar and on the View menu.
 *
 * A widget bound to the container but never contributed to a menu is
 * registered and unreachable (#379), so the view command is menu-contributed
 * rather than only bound, same as MapExplorerContribution.
 *
 * Also owns opening a track's detail view on row click: HackBenchContribution
 * centralises that for maps, but this view is deliberately its own module
 * (see the "avoiding merge conflicts" note in the feature brief), so it wires
 * itself instead of reaching into that file.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command } from '@theia/core/lib/common'
import { MusicExplorerWidget, MUSIC_EXPLORER_ID } from './music-explorer-widget'
import { PreviewTabs } from './preview-tabs'
import { MusicViewWidget, MUSIC_VIEW_ID } from './music-view-widget'

export const ShowMusicExplorerCommand: Command = {
  id: 'hackbench.music.focus',
  label: 'Music',
  category: 'HackBench',
}

@injectable()
export class MusicExplorerContribution extends AbstractViewContribution<MusicExplorerWidget> {
  @inject(PreviewTabs) protected readonly previews!: PreviewTabs

  // `shell` and `widgetManager` are already provided by AbstractViewContribution.

  constructor() {
    super({
      widgetId: MUSIC_EXPLORER_ID,
      widgetName: 'Music',
      defaultWidgetOptions: { area: 'left', rank: 101 },
      toggleCommandId: ShowMusicExplorerCommand.id,
    })
  }

  /**
   * Added on first launch, but only REVEALED, not activated: Maps already
   * claims initial focus, and both views calling openView with `activate`
   * would fight over it. Reveal alone is enough to put a real icon in the
   * shell, which is the thing #379 shipped without.
   */
  async initializeLayout(): Promise<void> {
    await this.openView({ reveal: true })
  }

  /**
   * Wired per widget INSTANCE, not once: the explorer is closable, and a
   * closed widget is disposed and evicted from WidgetManager, so reopening it
   * (the toggle command, or the activity-bar icon) builds a fresh instance
   * with its own onTrackOpened emitter. A one-time subscription here would
   * silently stop wiring clicks the moment the first instance ever closes.
   */
  async onStart(): Promise<void> {
    this.widgetManager.onDidCreateWidget(({ factoryId, widget }) => {
      if (factoryId !== MUSIC_EXPLORER_ID) return
      const explorer = widget as MusicExplorerWidget
      explorer.onTrackOpened(({ manifestPath, bgmCommand, pinned }) => {
        void this.openTrack(manifestPath, bgmCommand, pinned)
      })
    })
  }

  protected async openTrack(
    manifestPath: string,
    bgmCommand: number,
    pinned: boolean,
  ): Promise<void> {
    const apply = (w: MusicViewWidget) => w.open({ manifestPath, bgmCommand })
    if (pinned) {
      await this.previews.pin<MusicViewWidget>(MUSIC_VIEW_ID, { bgmCommand }, apply, p =>
        p.shows(bgmCommand),
      )
    } else {
      await this.previews.preview<MusicViewWidget>(MUSIC_VIEW_ID, apply)
    }
  }
}
