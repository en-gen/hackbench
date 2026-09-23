/**
 * Keeps Theia's Outline view out of the default layout, without removing it.
 *
 * It arrives only because @theia/monaco depends on @theia/outline-view, and
 * lists the document symbols a Monaco language provider reports. No HackBench
 * editor is a Monaco text editor yet, so on first launch it was an always-empty
 * panel in the right activity bar. Its command, View menu entry and keybinding
 * stay, so it can be reopened, and a future editor that feeds it symbols can
 * bring it back into the layout.
 */
import { injectable } from '@theia/core/shared/inversify'
import { OutlineViewContribution } from '@theia/outline-view/lib/browser/outline-view-contribution'

@injectable()
export class HiddenOutlineViewContribution extends OutlineViewContribution {
  override async initializeLayout(): Promise<void> {}
}
