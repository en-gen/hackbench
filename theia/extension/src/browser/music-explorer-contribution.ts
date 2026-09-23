/**
 * Puts the audio explorer in the shell's activity bar and on the View menu.
 *
 * Left, at rank 400, so it sits after Maps (100), Graphics (200) and
 * Palettes (300) as another explorer over the ROM's contents rather than as
 * a side panel you consult while editing something else. 300 was taken by
 * Palettes in #462, which landed while this branch was in flight; two views
 * sharing a rank leaves their order undefined.
 *
 * A widget bound to the container but never contributed to a menu is
 * registered and unreachable (#379), so the view command is menu-contributed
 * rather than only bound, same as MapExplorerContribution.
 *
 * Unlike the map and graphics explorers, this one wires NOTHING to a row
 * click. A track is a row of facts plus a transport, both of which live in
 * the panel, so there is no tab to open and no PreviewTabs involvement. A
 * deliberate divergence from the preview-tab pattern the other explorers
 * use, not an omission.
 */
import { injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command, CommandRegistry } from '@theia/core/lib/common'
import { MusicExplorerWidget, MUSIC_EXPLORER_ID } from './music-explorer-widget'

export const ShowMusicExplorerCommand: Command = {
  id: 'hackbench.music.focus',
  label: 'Audio',
  category: 'HackBench',
}

export const RenameMusicTrackCommand: Command = {
  id: 'hackbench.music.rename',
  label: 'Name Music Track',
  category: 'HackBench',
}

@injectable()
export class MusicExplorerContribution extends AbstractViewContribution<MusicExplorerWidget> {
  constructor() {
    super({
      widgetId: MUSIC_EXPLORER_ID,
      widgetName: 'Audio',
      defaultWidgetOptions: { area: 'left', rank: 400 },
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
   * A command as well as a double click, so naming a track is reachable from
   * the palette and bindable to a key. Enabled only while the panel is
   * visible, so the palette does not offer it from an unrelated view.
   */
  override registerCommands(registry: CommandRegistry): void {
    super.registerCommands(registry)
    registry.registerCommand(RenameMusicTrackCommand, {
      isEnabled: () => this.tryGetWidget()?.isVisible === true,
      execute: () => {
        const widget = this.tryGetWidget()
        if (widget) void widget.renameSelected()
      },
    })
  }
}
