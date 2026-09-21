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
import { ProjectDto, ProjectService } from '../common/project-protocol'
import { NewProjectDialog } from './new-project-dialog'
import { MapExplorerWidget, MAP_EXPLORER_ID } from './map-explorer-widget'
import { ProjectPropertiesDialog } from './project-properties-dialog'
import { ProjectContext } from './project-context'
import { FileDialogService } from '@theia/filesystem/lib/browser'
import { PROJECT_EXT } from '../../../../src/project/Project'

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

export const OpenRecentProjectCommand: Command = {
  id: 'hackbench.project.openRecent',
  label: 'Open Recent Project...',
  category: 'HackBench',
}

export const ProjectPropertiesCommand: Command = {
  id: 'hackbench.project.properties',
  label: 'Project Properties...',
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
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell
  @inject(ProjectPropertiesDialog) protected readonly properties!: ProjectPropertiesDialog
  @inject(ProjectContext) protected readonly context!: ProjectContext
  @inject(FileDialogService) protected readonly fileDialog!: FileDialogService
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService

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
    registry.registerCommand(ProjectPropertiesCommand, {
      execute: () => this.editProperties(),
      // Greyed out rather than hidden with no project: a command that vanishes
      // reads as a broken install, one that is disabled reads as "not yet".
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
    menus.registerMenuAction(CommonMenus.FILE, {
      commandId: OpenRecentProjectCommand.id,
      label: OpenRecentProjectCommand.label,
      order: '2',
    })
    menus.registerMenuAction(CommonMenus.FILE, {
      commandId: ProjectPropertiesCommand.id,
      label: ProjectPropertiesCommand.label,
      order: '3',
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
      // Name the cart back to the user: it is how they confirm they picked
      // the ROM they meant, and the title comes from the cart's own header.
      this.messages.info(
        `Created ${project.name} against ${project.baseRom.title || 'an SNES cart'} ` +
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
    this.context.current = project
    const explorer = await this.widgets.getOrCreateWidget<MapExplorerWidget>(MAP_EXPLORER_ID)
    await explorer.load(project.manifestPath)
    // Activated, not merely revealed: the tree virtualises its rows, so a
    // background tab shows a loaded project as an empty view.
    await this.shell.activateWidget(MAP_EXPLORER_ID)
  }

  /**
   * Reopen something from the recent list.
   *
   * A quick pick rather than a nested menu: the list is per-machine state that
   * changes as the user works, and a menu built once at registration would go
   * stale the moment they created a project.
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

    try {
      await this.show(await this.projects.openProject(picked.manifestPath))
    } catch (err) {
      this.messages.error(`Could not open that project: ${(err as Error).message}`)
    }
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

    try {
      this.context.current = await this.projects.updateProject(open.manifestPath, changes)
      this.messages.info(`Saved properties for ${changes.title}`)
    } catch (err) {
      this.messages.error(`Could not save properties: ${(err as Error).message}`)
    }
  }
}
