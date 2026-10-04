/**
 * Commands and menus HackBench contributes to the shell.
 *
 * `File > New Project...` is the entry point: a hack is always created against
 * a base ROM, and everything else in the editor needs a project open first.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService,
} from '@theia/core/lib/common'
import {
  ApplicationShell,
  CommonMenus,
  QuickInputService,
  WidgetManager,
} from '@theia/core/lib/browser'
import {
  PatchFormatDto,
  ProjectDto,
  ProjectService,
  RecentProjectDto,
} from '../common/project-protocol'
import { NewProjectDialog } from './new-project-dialog'
import { MapExplorerWidget, MAP_EXPLORER_ID } from './map-explorer-widget'
import { PreviewTabs } from './preview-tabs'
import { MapViewWidget, MAP_VIEW_ID } from './map-view-widget'
import { EmulatorService } from '../common/emulator-protocol'
import { ProjectFrontendClient } from './project-push-client'
import { Map16FrontendClient } from './map16-push-client'
import { GfxFrontendClient } from './gfx-push-client'
import { PaletteFrontendClient } from './palette-push-client'
import { describeRomMismatch, ProjectPropertiesDialog } from './project-properties-dialog'
import { ProjectContext } from './project-context'
import { FileDialogService } from '@theia/filesystem/lib/browser'
import { PROJECT_EXT } from '../../../../src/project/Project'
import { perfEndAfterPaint, perfStart } from '../common/perf-marks'

export const NewProjectCommand: Command = {
  id: 'hackbench.project.new',
  label: 'New Project...',
  category: 'HackBench',
}

export const OpenProjectCommand: Command = {
  id: 'hackbench.project.open',
  label: 'Open Project...',
  category: 'HackBench',
}

/** Kept as a command too, so the palette and a keybinding can reach the list. */
export const OpenRecentProjectCommand: Command = {
  id: 'hackbench.project.openRecent',
  label: 'Open Recent Project...',
  category: 'HackBench',
}

export const ClearRecentProjectsCommand: Command = {
  id: 'hackbench.project.clearRecent',
  label: 'Clear Recently Opened',
  category: 'HackBench',
}

/** Where the dynamic submenu hangs, beside the other project actions. */
const RECENT_SUBMENU = [...CommonMenus.FILE, '1_hackbench_project', 'recent']

/** One command per remembered project, registered and torn down as it changes. */
const RECENT_COMMAND_PREFIX = 'hackbench.project.openRecent.'

export const ProjectPropertiesCommand: Command = {
  id: 'hackbench.project.properties',
  label: 'Project Properties...',
  category: 'HackBench',
}

export const ExportPatchCommand: Command = {
  id: 'hackbench.project.exportPatch',
  label: 'Export Patch',
  category: 'HackBench',
}

/** BPS is what `ExportPatchCommand` writes by default; this is the IPS escape hatch. */
export const ExportPatchAsIpsCommand: Command = {
  id: 'hackbench.project.exportPatchAsIps',
  label: 'Export Patch as IPS',
  category: 'HackBench',
}

/**
 * File-menu entries Theia contributes that make no sense here, by the menu
 * path they live under and the command they invoke. Verified against the live
 * menu model rather than guessed: every id below was read out of a running
 * app.
 *
 * Save, Auto Save, Preferences and Close Editor are deliberately KEPT. Editing
 * a map will need them, and Preferences is where the colour theme lives.
 */
const IRRELEVANT_FILE_ACTIONS: Array<[string[], string]> = [
  // New: we create projects, not loose text files or extra windows.
  [['menubar', '1_file', '1_new_text'], 'workbench.action.files.newUntitledFile'],
  [['menubar', '1_file', '1_new_text'], 'workbench.action.files.pickNewFile'],
  [['menubar', '1_file', '1_new_text'], 'file.newFolder'],
  [['menubar', '1_file', '1_new_text'], 'workbench.action.newWindow'],
  // Open: a project is the unit, and a folder or workspace would be a second,
  // parallel notion of what is loaded.
  [['menubar', '1_file', '2_open'], 'workspace:open'],
  [['menubar', '1_file', '2_open'], 'workspace:openWorkspace'],
  [['menubar', '1_file', '2_open'], 'workspace:openRecent'],
  // Workspaces do not exist in this application at all.
  [['menubar', '1_file', '2_workspace'], 'workspace:addFolder'],
  [['menubar', '1_file', '2_workspace'], 'workspace:saveAs'],
  [['menubar', '1_file', '6_close'], 'workspace:close'],
  // Browser-target affordances with no meaning in a desktop ROM editor.
  [['menubar', '1_file', '4_downloadupload'], 'file.upload'],
  [['menubar', '1_file', '4_downloadupload'], 'file.download'],
]

@injectable()
export class HackBenchContribution implements CommandContribution, MenuContribution {
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(MessageService) protected readonly messages!: MessageService
  @inject(NewProjectDialog) protected readonly dialog!: NewProjectDialog
  @inject(WidgetManager) protected readonly widgets!: WidgetManager
  @inject(PreviewTabs) protected readonly previews!: PreviewTabs
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell
  @inject(ProjectPropertiesDialog) protected readonly properties!: ProjectPropertiesDialog
  @inject(ProjectContext) protected readonly context!: ProjectContext
  @inject(EmulatorService) protected readonly emulator!: EmulatorService
  @inject(ProjectFrontendClient) protected readonly pushClient!: ProjectFrontendClient
  @inject(Map16FrontendClient) protected readonly map16Push!: Map16FrontendClient
  @inject(GfxFrontendClient) protected readonly gfxPush!: GfxFrontendClient
  @inject(PaletteFrontendClient) protected readonly palettePush!: PaletteFrontendClient
  @inject(FileDialogService) protected readonly fileDialog!: FileDialogService
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService

  /** Captured at registration so the submenu can be rebuilt later. */
  protected commands: CommandRegistry | undefined
  protected menus: MenuModelRegistry | undefined
  /** Command ids currently in the submenu, so they can be torn down. */
  protected recentIds: string[] = []
  /** Explorer instances already wired, so a reopened view gets its own. */
  protected readonly wiredExplorers = new WeakSet<MapExplorerWidget>()
  protected currentManifest = ''

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(NewProjectCommand, {
      execute: () => this.newProject(),
    })
    registry.registerCommand(OpenProjectCommand, {
      execute: () => this.openProject(),
    })
    registry.registerCommand(OpenRecentProjectCommand, {
      execute: () => this.openRecent(),
    })
    registry.registerCommand(ClearRecentProjectsCommand, {
      execute: () => this.clearRecent(),
      isEnabled: () => this.recentIds.length > 0,
    })
    this.commands = registry
    // Populate once the backend is reachable; the menu is empty until then
    // rather than showing a stale list from a previous run.
    void this.refreshRecentMenu()
    registry.registerCommand(ProjectPropertiesCommand, {
      execute: () => this.editProperties(),
      // Greyed out rather than hidden with no project: a command that vanishes
      // reads as a broken install, one that is disabled reads as "not yet".
      isEnabled: () => !!this.context.current,
    })
    registry.registerCommand(ExportPatchCommand, {
      execute: () => this.exportPatch('bps'),
      isEnabled: () => !!this.context.current,
    })
    registry.registerCommand(ExportPatchAsIpsCommand, {
      execute: () => this.exportPatch('ips'),
      isEnabled: () => !!this.context.current,
    })
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(CommonMenus.FILE, {
      commandId: NewProjectCommand.id,
      label: NewProjectCommand.label,
      order: '0',
    })
    menus.registerMenuAction(CommonMenus.FILE, {
      commandId: OpenProjectCommand.id,
      label: OpenProjectCommand.label,
      order: '1',
    })
    // A submenu rather than a quick pick, matching VS Code: the list is short
    // and the whole point is seeing it without a second interaction.
    menus.registerSubmenu(RECENT_SUBMENU, 'Open Recent Project')
    this.menus = menus
    void this.refreshRecentMenu()
    menus.registerMenuAction(CommonMenus.FILE, {
      commandId: ProjectPropertiesCommand.id,
      label: ProjectPropertiesCommand.label,
      order: '3',
    })
    menus.registerMenuAction(CommonMenus.FILE, {
      commandId: ExportPatchCommand.id,
      label: ExportPatchCommand.label,
      order: '4',
    })
    menus.registerMenuAction(CommonMenus.FILE, {
      commandId: ExportPatchAsIpsCommand.id,
      label: ExportPatchAsIpsCommand.label,
      order: '5',
    })

    // Strip what a workspace IDE offers and a ROM editor does not have.
    //
    // HackBench opens PROJECTS, not files, folders or workspaces. Leaving
    // these in means a File menu where most entries either do nothing useful
    // or open a second, parallel notion of "what is loaded" that nothing else
    // in the application understands.
    for (const [menuPath, id] of IRRELEVANT_FILE_ACTIONS) {
      menus.unregisterMenuAction(id, menuPath)
    }
  }

  protected async newProject(): Promise<void> {
    const request = await this.dialog.collect()
    if (!request) return

    try {
      const project = await this.projects.createProject(request)
      // Name the ROM back to the user: it is how they confirm they picked
      // the ROM they meant, and the title comes from the ROM's own header.
      this.messages.info(
        `Created ${project.name} against ${project.baseRom.title || 'a ROM'} ` +
          `(${project.baseRom.size} bytes)`,
      )

      await this.show(project)
    } catch (err) {
      // Failures here are expected and actionable: an occupied directory, a
      // missing ROM. Say which, rather than a generic failure.
      this.messages.error(`Could not create project: ${(err as Error).message}`)
    }
  }

  /**
   * Open an existing project from its manifest.
   *
   * Filtered to .hbproj rather than to folders: the manifest is the project,
   * and picking a folder would mean guessing which manifest inside it was
   * meant, which openProject already refuses to do when there are two.
   */
  protected async openProject(): Promise<void> {
    const uri = await this.fileDialog.showOpenDialog({
      title: 'Open a HackBench project',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'HackBench project': [PROJECT_EXT.replace('.', '')] },
    })
    if (!uri) return

    try {
      const project = await this.projects.openProject(uri.path.fsPath())
      await this.show(project)
    } catch (err) {
      // Expected and actionable: a manifest moved away from its data, two
      // manifests in one folder, a newer schema. Say which.
      this.messages.error(`Could not open that project: ${(err as Error).message}`)
    }
  }

  /**
   * Put a project on screen.
   *
   * Shared by create and open so the two cannot drift: a project that shows
   * its maps when created but not when reopened is the kind of difference
   * nobody notices until it is reported as data loss.
   */
  protected async show(project: ProjectDto): Promise<void> {
    perfStart('open-project')
    this.context.current = project
    // Opening or creating a project reorders the recent list.
    void this.refreshRecentMenu()

    const explorer = await this.widgets.getOrCreateWidget<MapExplorerWidget>(MAP_EXPLORER_ID)
    this.listenForMapOpens(explorer, project.manifestPath)
    await explorer.load(project.manifestPath)
    // Activated, not merely revealed: the tree virtualises its rows, so a
    // background tab shows a loaded project as an empty view.
    await this.shell.activateWidget(MAP_EXPLORER_ID)
    perfEndAfterPaint('open-project')
  }

  /**
   * Rebuild the Open Recent submenu from the backend's list.
   *
   * Rebuilt rather than registered once: the list is per-machine state that
   * changes as the user works, and a menu built at registration time would go
   * stale the moment they created a project. Old entries are unregistered
   * first so a project that dropped off does not linger as a dead command.
   */
  protected async refreshRecentMenu(): Promise<void> {
    if (!this.commands || !this.menus) return

    for (const id of this.recentIds) {
      this.menus.unregisterMenuAction(id, RECENT_SUBMENU)
      this.commands.unregisterCommand(id)
    }
    this.recentIds = []

    let entries: RecentProjectDto[]
    try {
      entries = await this.projects.recentProjects()
    } catch {
      // The backend may not be up yet on first paint. An empty submenu is the
      // honest state; it fills as soon as a project is opened.
      return
    }

    entries.forEach((entry, i) => {
      const id = `${RECENT_COMMAND_PREFIX}${i}`
      this.commands!.registerCommand(
        { id, label: entry.title || entry.name },
        {
          execute: () => this.openPath(entry.manifestPath),
        },
      )
      this.menus!.registerMenuAction(RECENT_SUBMENU, {
        commandId: id,
        // The path disambiguates two hacks that share a title.
        label: `${entry.title || entry.name}  ${entry.manifestPath}`,
        order: String(i).padStart(3, '0'),
      })
      this.recentIds.push(id)
    })

    if (entries.length > 0) {
      this.menus.registerMenuAction(RECENT_SUBMENU, {
        commandId: ClearRecentProjectsCommand.id,
        label: ClearRecentProjectsCommand.label,
        order: 'zzz',
      })
    }
  }

  protected async clearRecent(): Promise<void> {
    await this.projects.clearRecentProjects()
    await this.refreshRecentMenu()
  }

  protected async openPath(manifestPath: string): Promise<void> {
    try {
      await this.show(await this.projects.openProject(manifestPath))
    } catch (err) {
      this.messages.error(`Could not open that project: ${(err as Error).message}`)
    }
  }

  /**
   * The same list as a quick pick, for the command palette.
   */
  protected async openRecent(): Promise<void> {
    const entries = await this.projects.recentProjects()
    if (entries.length === 0) {
      this.messages.info('No recent projects yet')
      return
    }

    const picked = await this.quickInput.showQuickPick(
      entries.map(e => ({
        label: e.title || e.name,
        // The path is what distinguishes two hacks with the same title.
        description: e.manifestPath,
        manifestPath: e.manifestPath,
      })),
      { placeholder: 'Open a recent project' },
    )
    if (!picked) return

    await this.openPath(picked.manifestPath)
  }

  /**
   * Open a map when a row is clicked.
   *
   * Subscribed once per explorer instance: the widget is a singleton, so
   * re-subscribing on every project open would open one widget per past
   * project on the next click.
   */
  protected listenForMapOpens(explorer: MapExplorerWidget, manifestPath: string): void {
    this.currentManifest = manifestPath
    // Keyed on the widget instance, not a one-shot flag: the view is closable,
    // so closing it and reopening yields a NEW widget that a once-only guard
    // would never subscribe, leaving every row click silently dead.
    if (this.wiredExplorers.has(explorer)) return
    this.wiredExplorers.add(explorer)

    explorer.onMapOpened(async ({ index, label, pinned, iconClass }) => {
      const manifestPath = this.currentManifest
      const apply = (w: MapViewWidget) => w.open({ manifestPath, index, label, iconClass })
      if (pinned) {
        await this.previews.pin<MapViewWidget>(
          MAP_VIEW_ID,
          { index },
          apply,
          p => p.shows(index),
          {},
        )
      } else {
        await this.previews.preview<MapViewWidget>(MAP_VIEW_ID, apply)
      }
    })
  }

  protected async editProperties(): Promise<void> {
    const open = this.context.current
    if (!open) {
      this.messages.info('Open a project first')
      return
    }

    // Re-read before editing rather than trusting the cached DTO: the manifest
    // is a file, and the user may have changed it in another editor.
    let current
    try {
      current = await this.projects.openProject(open.manifestPath)
    } catch (err) {
      this.messages.error(`Could not read the project: ${(err as Error).message}`)
      return
    }

    const changes = await this.properties.editFor(current)
    if (!changes) return

    // Both picks are re-validated before anything is written: a file can
    // change after Browse. Writes then run ROM, core, metadata; a failure
    // reports exactly what already applied, and any registry write still
    // refreshes the views.
    const { pendingRomPath, pendingCorePath } = this.properties
    const applied: string[] = []
    try {
      if (pendingRomPath) {
        const check = await this.projects.checkRom(open.manifestPath, pendingRomPath)
        if (check.status === 'mismatch') throw new Error(describeRomMismatch(check))
      }
      if (pendingCorePath) {
        const core = await this.emulator.checkCore(pendingCorePath)
        if (core.status === 'invalid') throw new Error(core.message)
      }
      if (pendingRomPath) {
        const moved = await this.projects.relocateRom(open.manifestPath, pendingRomPath)
        if (moved.status === 'mismatch') throw new Error(describeRomMismatch(moved))
        applied.push('ROM location')
      }
      if (pendingCorePath) {
        const core = await this.emulator.locateCore(pendingCorePath)
        if (core.status === 'invalid') throw new Error(core.message)
        applied.push('emulator core')
      }
      this.context.current = await this.projects.updateProject(open.manifestPath, changes)
      applied.push('properties')
      this.messages.info(`Saved properties for ${changes.title}`)
    } catch (err) {
      // The message may already end in a full stop.
      this.messages.error(
        `Could not save properties: ${(err as Error).message.replace(/\.$/, '')}. ` +
          `Applied: ${applied.length ? applied.join(', ') : 'nothing'}.`,
      )
    } finally {
      // Views waiting on a ROM or core re-read on these, the same pushes a
      // working-copy edit sends. Each view type listens to its own client.
      const romMoved = applied.includes('ROM location')
      const registryWritten = romMoved || applied.includes('emulator core')
      if (registryWritten) {
        this.pushClient.onWorkingCopyChanged(open.manifestPath)
        // Re-announce the project: the GFX and music explorers and the
        // emulator reload on the context, not on pushes. A full save already did.
        if (!applied.includes('properties')) this.context.current = this.context.current // eslint-disable-line no-self-assign
      }
      if (romMoved) {
        for (const client of [this.map16Push, this.gfxPush, this.palettePush]) {
          client.onWorkingCopyChanged(open.manifestPath)
        }
      }
    }
  }

  /** IPS's copier-header note is dropped for BPS, which always targets the unheadered ROM. */
  protected async exportPatch(format: PatchFormatDto): Promise<void> {
    const open = this.context.current
    if (!open) {
      this.messages.info('Open a project first')
      return
    }

    try {
      const result = await this.projects.exportPatch(open.manifestPath, format)
      if (result.status === 'rom-not-located') {
        this.messages.error(`Locate ${result.baseRom.title || 'the base ROM'} first`)
        return
      }
      if (result.status === 'unreadable') {
        this.messages.error(result.reason)
        return
      }
      const suffix =
        format === 'ips'
          ? ` (base ROM ${result.hasCopierHeader ? 'has a copier header' : 'has no copier header'})`
          : ''
      this.messages.info(
        `Exported ${result.opCount} changed byte${result.opCount === 1 ? '' : 's'} to ` +
          `${result.path}${suffix}`,
      )
    } catch (err) {
      this.messages.error(`Could not export patch: ${(err as Error).message}`)
    }
  }
}
