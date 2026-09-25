/**
 * Puts the map explorer in the shell's left sidebar and on the View menu.
 *
 * A widget bound to the container but never contributed to a menu is
 * registered and unreachable, which this project has shipped before (#379),
 * so the view command is menu-contributed rather than only bound.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import {
  AbstractViewContribution,
  QuickInputService,
  SingleTextInputDialog,
} from '@theia/core/lib/browser'
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry,
} from '@theia/core/lib/browser/shell/tab-bar-toolbar'
import { Command, CommandRegistry, MenuModelRegistry, MenuPath } from '@theia/core/lib/common'
import {
  MapExplorerWidget,
  MAP_EXPLORER_CONTEXT_MENU,
  MAP_EXPLORER_ID,
} from './map-explorer-widget'

export const ShowMapExplorerCommand: Command = {
  id: 'hackbench.maps.focus',
  label: 'Maps',
  category: 'HackBench',
}

/**
 * Wide enough for the longest vanilla map name beside its slot, measured
 * rather than guessed: at the shell default of 196px, 15 of 55 visible rows
 * wrapped.
 */
const DEFAULT_SIDEBAR_WIDTH = 280

export const ExpandAllMapsCommand: Command = {
  id: 'hackbench.maps.expandAll',
  label: 'Expand All',
  category: 'HackBench',
  iconClass: 'codicon codicon-expand-all',
}

export const CollapseAllMapsCommand: Command = {
  id: 'hackbench.maps.collapseAll',
  label: 'Collapse All',
  category: 'HackBench',
  iconClass: 'codicon codicon-collapse-all',
}

export const AddToGroupCommand: Command = {
  id: 'hackbench.maps.addToGroup',
  label: 'Add to Group...',
}
export const RemoveFromGroupCommand: Command = {
  id: 'hackbench.maps.removeFromGroup',
  label: 'Remove from Group',
}
export const RenameGroupCommand: Command = {
  id: 'hackbench.maps.renameGroup',
  label: 'Rename Group...',
}
export const DeleteGroupCommand: Command = {
  id: 'hackbench.maps.deleteGroup',
  label: 'Delete Group',
}

/** Marks the QuickPick's own "New Group..." entry, distinct from any group actually named that. */
const NEW_GROUP = Symbol('new-group')

@injectable()
export class MapExplorerContribution
  extends AbstractViewContribution<MapExplorerWidget>
  implements TabBarToolbarContribution
{
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService

  constructor() {
    super({
      widgetId: MAP_EXPLORER_ID,
      widgetName: 'Maps',
      defaultWidgetOptions: { area: 'left', rank: 100 },
      toggleCommandId: ShowMapExplorerCommand.id,
    })
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands)

    for (const [command, run] of [
      [ExpandAllMapsCommand, (w: MapExplorerWidget) => w.expandAll()],
      [CollapseAllMapsCommand, (w: MapExplorerWidget) => w.collapseAll()],
    ] as const) {
      commands.registerCommand(command, {
        execute: () => this.withWidget(w => run(w)),
        // isVisible scopes the toolbar button to this view. isEnabled also has
        // to answer for the command palette and keybindings, which pass no
        // widget at all, so it falls back to whether the view exists.
        isEnabled: w => (w ? w instanceof MapExplorerWidget : !!this.tryGetWidget()),
        isVisible: w => w instanceof MapExplorerWidget,
      })
    }

    const when = (pred: (w: MapExplorerWidget) => boolean) => (): boolean => {
      const w = this.tryGetWidget()
      return !!w && pred(w)
    }

    commands.registerCommand(AddToGroupCommand, {
      execute: () => this.withWidget(w => this.promptAddToGroup(w)),
      isEnabled: when(w => w.canAddToGroup()),
      isVisible: when(w => w.canAddToGroup()),
    })
    commands.registerCommand(RemoveFromGroupCommand, {
      execute: () => this.withWidget(w => w.removeSelectionFromGroup()),
      isEnabled: when(w => w.canRemoveFromGroup()),
      isVisible: when(w => w.canRemoveFromGroup()),
    })
    commands.registerCommand(RenameGroupCommand, {
      execute: () => this.withWidget(w => this.promptRename(w)),
      isEnabled: when(w => w.selectedGroupName() !== undefined),
      isVisible: when(w => w.selectedGroupName() !== undefined),
    })
    commands.registerCommand(DeleteGroupCommand, {
      execute: () => this.withWidget(w => this.deleteSelectedGroup(w)),
      isEnabled: when(w => w.selectedGroupName() !== undefined),
      isVisible: when(w => w.selectedGroupName() !== undefined),
    })
  }

  /** Existing groups, then New Group...: one static list, nothing to register or tear down. */
  protected async promptAddToGroup(widget: MapExplorerWidget): Promise<void> {
    const items = [
      ...widget
        .groupNames()
        .map(name => ({ label: name, group: name as string | typeof NEW_GROUP })),
      { label: 'New Group...', group: NEW_GROUP as string | typeof NEW_GROUP },
    ]
    const picked = await this.quickInput.showQuickPick(items, { placeholder: 'Add to group' })
    if (!picked) return
    if (picked.group === NEW_GROUP) await this.promptNewGroup(widget)
    else await widget.addSelectionToGroup(picked.group as string)
  }

  protected async promptNewGroup(widget: MapExplorerWidget): Promise<void> {
    const dialog = new SingleTextInputDialog({
      title: 'New Group',
      placeholder: 'Group name',
      validate: name => widget.validateGroupName(name) ?? '',
    })
    const name = await dialog.open()
    if (name) await widget.addSelectionToGroup(name.trim())
  }

  protected async promptRename(widget: MapExplorerWidget): Promise<void> {
    const oldName = widget.selectedGroupName()
    if (!oldName) return
    const dialog = new SingleTextInputDialog({
      title: 'Rename Group',
      initialValue: oldName,
      validate: name => widget.validateGroupName(name, oldName) ?? '',
    })
    const name = await dialog.open()
    if (name) await widget.renameGroup(oldName, name.trim())
  }

  protected async deleteSelectedGroup(widget: MapExplorerWidget): Promise<void> {
    const name = widget.selectedGroupName()
    if (name) await widget.deleteGroup(name)
  }

  registerMenus(menus: MenuModelRegistry): void {
    const path: MenuPath = MAP_EXPLORER_CONTEXT_MENU
    menus.registerMenuAction(path, { commandId: AddToGroupCommand.id, order: '0' })
    menus.registerMenuAction(path, { commandId: RemoveFromGroupCommand.id, order: '1' })
    menus.registerMenuAction(path, { commandId: RenameGroupCommand.id, order: '2' })
    menus.registerMenuAction(path, { commandId: DeleteGroupCommand.id, order: '3' })
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: ExpandAllMapsCommand.id,
      command: ExpandAllMapsCommand.id,
      tooltip: ExpandAllMapsCommand.label,
      priority: 0,
    })
    registry.registerItem({
      id: CollapseAllMapsCommand.id,
      command: CollapseAllMapsCommand.id,
      tooltip: CollapseAllMapsCommand.label,
      priority: 1,
    })
  }

  protected async withWidget(run: (widget: MapExplorerWidget) => Promise<void>): Promise<void> {
    const widget = this.tryGetWidget()
    if (widget) await run(widget)
  }

  /**
   * Shown and ACTIVATED on first launch. Revealing without activating leaves
   * the view as a background tab behind Explorer, where it has no size: the
   * tree virtualises its rows, so a hidden tree renders zero of them and the
   * maps are loaded but invisible.
   */
  async initializeLayout(): Promise<void> {
    await this.openView({ activate: true, reveal: true })
    // Map names are long ("DONUT GHOST HOUSE"), and the shell's default
    // sidebar is too narrow for them beside a slot number. Only a FIRST-RUN
    // default: Theia persists the layout, so a width the user sets themselves
    // is never overwritten by this.
    this.shell.leftPanelHandler.resize(DEFAULT_SIDEBAR_WIDTH)
  }
}
