/**
 * The globe in the activity bar, and `hackbench.overworld.focus`.
 *
 * Theia's activity bar holds only side-panel views, so the globe is an empty
 * launcher view. A click on it, or the panel opening onto it (View > Toggle
 * Left Panel, a restored layout), opens or focuses the ONE main-area Overworld
 * widget; any show collapses the panel, so the slot never shows.
 * Collapsing clears the side bar's current tab, so the next click activates
 * the globe again rather than collapsing an open panel.
 *
 * The command is menu-contributed, not only bound (#379, see
 * map-explorer-contribution.ts).
 */
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import {
  AbstractViewContribution,
  ApplicationShell,
  BaseWidget,
  Message,
} from '@theia/core/lib/browser'
import { Command, CommandRegistry, CommandService, Disposable } from '@theia/core/lib/common'
import { OverworldViewWidget, OVERWORLD_VIEW_ID } from './overworld-view-widget'

export const OVERWORLD_LAUNCHER_ID = 'hackbench.overworld-launcher'

export const ShowOverworldCommand: Command = {
  id: 'hackbench.overworld.focus',
  label: 'Overworld',
  category: 'HackBench',
}

@injectable()
export class OverworldLauncherWidget extends BaseWidget {
  @inject(CommandService) protected readonly commands!: CommandService
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell

  constructor() {
    super()
    this.id = OVERWORLD_LAUNCHER_ID
    this.title.label = 'Overworld'
    this.title.caption = 'Overworld'
    this.title.iconClass = 'codicon codicon-globe'
    this.title.closable = false
    this.node.tabIndex = 0
  }

  /**
   * Set when a left-side widget is removed, cleared two tasks later. Closing a
   * sibling makes the globe current through the tab bar's
   * 'select-previous-tab', synchronously inside the removal; the dock panel's
   * own selection can show the globe before `widgetRemoved` emits. So the
   * mark is read when the deferred run starts, one task on, when it is set
   * whichever came first, and cleared only after that run.
   */
  protected sawRemoval = false

  @postConstruct()
  protected init(): void {
    const { dockPanel, tabBar } = this.shell.leftPanelHandler
    const mark = (): void => {
      this.sawRemoval = true
      setTimeout(() => setTimeout(() => (this.sawRemoval = false)))
    }
    // A click on the globe. Theia also re-activates the new current tab after
    // a removal, so onActivateRequest cannot tell a click from a fallback;
    // the tab bar's own request fires only for a click (measured, #363).
    const click = (_: unknown, args: { title: { owner: unknown } }): void => {
      if (args.title.owner !== this) return
      this.clicked = true
      this.schedule()
    }
    dockPanel.widgetRemoved.connect(mark)
    tabBar.tabActivateRequested.connect(click)
    this.toDispose.push(
      Disposable.create(() => {
        dockPanel.widgetRemoved.disconnect(mark)
        tabBar.tabActivateRequested.disconnect(click)
      }),
    )
  }

  /** The panel opening onto the globe opens the view; a removal fallback only collapses. */
  protected override onAfterShow(msg: Message): void {
    super.onAfterShow(msg)
    this.shown = true
    this.schedule()
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  protected scheduled = false
  protected shown = false
  protected clicked = false

  /**
   * Collapses the panel, THEN opens and activates the view, so keyboard focus
   * ends on the view: collapsing hides the focused launcher, which would drop
   * focus from a view activated before it. Deferred out of the tab bar's own
   * dispatch, where a show lands. A click sends a show and a tab request
   * within one task; they fold into one run. The flags clear when the run starts,
   * never across activateWidget, which can take 2.25 s or not settle at all.
   */
  protected schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    setTimeout(async () => {
      const opens = this.clicked || (this.shown && !this.sawRemoval)
      this.scheduled = this.shown = this.clicked = false
      // Synchronous (SidePanelHandler.collapse); its promise is only an
      // animation frame, which never comes in a hidden window.
      void this.shell.collapsePanel('left')
      if (opens) await this.commands.executeCommand(ShowOverworldCommand.id)
    })
  }
}

@injectable()
export class OverworldContribution extends AbstractViewContribution<OverworldLauncherWidget> {
  constructor() {
    super({
      widgetId: OVERWORLD_LAUNCHER_ID,
      widgetName: 'Overworld',
      // After Maps (100), before Graphics (200).
      defaultWidgetOptions: { area: 'left', rank: 150 },
      toggleCommandId: ShowOverworldCommand.id,
    })
  }

  async onStart(): Promise<void> {
    await this.openView({ activate: false, reveal: false })
  }

  protected attaching: Promise<OverworldViewWidget> | undefined

  /** Opens the Overworld widget, or focuses the one already open. */
  async openOverworld(): Promise<OverworldViewWidget> {
    // Concurrent calls share one create-and-attach, so the view is added once.
    this.attaching ??= this.attachOverworld().finally(() => (this.attaching = undefined))
    const view = await this.attaching
    await this.shell.activateWidget(view.id)
    return view
  }

  protected async attachOverworld(): Promise<OverworldViewWidget> {
    // The factory hands back the live instance, or a fresh one once closed.
    const view = await this.widgetManager.getOrCreateWidget<OverworldViewWidget>(OVERWORLD_VIEW_ID)
    if (!view.isAttached) await this.shell.addWidget(view, { area: 'main' })
    return view
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ShowOverworldCommand, { execute: () => this.openOverworld() })
  }
}
