/**
 * Backend half of the project service.
 *
 * Thin on purpose: all the real work lives in the shell-free project and ROM
 * modules, which are unit tested without Theia, VS Code or a browser. This
 * class exists only to put those modules on the wire.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import {
  createProject,
  openProject,
  romIdentity,
  updateProject,
} from '../../../../src/project/Project'
import { RecentProjects } from '../../../../src/project/RecentProjects'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildMapTree, MapTree } from '../../../../src/rom/MapTree'
import {
  WorkingRomEntry,
  WorkingRomRegistry,
  WorkingRomResult,
} from '../../../../src/project/WorkingRomRegistry'
import { buildMapDetails } from './map-details'
import { L1ModelCache, mapScreen, toolbarArtOf } from './map-screen'
import { SWITCH_FLAGS_UNCLEARED } from '../../../../src/rom/ObjectExpander'
import { exportPatch } from '../../../../src/project/ExportPatch'
import {
  admitGroups,
  applyGroups,
  GroupsRead,
  MapGroup,
  readGroups,
  resolveGroups,
  staleSlots,
  topLevelSlots,
  VANILLA_SHA256,
  writeGroups,
} from '../../../../src/project/MapGroups'
import * as fs from 'fs'
import {
  CreateProjectRequest,
  EditStackResult,
  ExportPatchResult,
  GroupedMapTreeDto,
  HackMetadataDto,
  LoadMapsResult,
  MapDetailsDto,
  MapScreenResult,
  PalaceIconsResult,
  PatchFormatDto,
  ProjectDto,
  ProjectService,
  ProjectServiceClient,
  RecentProjectDto,
  RomIdentityDto,
  SetMapGroupsResult,
  SwitchFlagsDto,
  SwitchStateDto,
} from '../common/project-protocol'
import { WorkingCopyNotifier } from './working-copy-notifier'

@injectable()
export class ProjectServiceImpl implements ProjectService {
  private readonly recent = new RecentProjects()
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry
  private readonly notifier = new WorkingCopyNotifier<ProjectServiceClient>()
  private readonly screens = new L1ModelCache()

  setClient(client: ProjectServiceClient | undefined): void {
    this.notifier.setClient(client)
  }

  async createProject(req: CreateProjectRequest): Promise<ProjectDto> {
    const p = createProject(req)
    // The user has just pointed at their cartridge, which is the only moment
    // we are certain where it is. Recording it here is what lets the project
    // itself stay path-free.
    this.workingRoms.register(req.romPath)
    this.recent.remember(p)
    return toDto(p)
  }

  async openProject(manifestPath: string): Promise<ProjectDto> {
    const p = openProject(manifestPath)
    // Recorded only on a SUCCESSFUL open, so a manifest that cannot be read
    // never enters the list that exists to offer working projects.
    this.recent.remember(p)
    return toDto(p)
  }

  async recentProjects(): Promise<RecentProjectDto[]> {
    return this.recent.list()
  }

  async clearRecentProjects(): Promise<void> {
    this.recent.clear()
  }

  async mapDetails(manifestPath: string, index: number): Promise<MapDetailsDto> {
    const r = this.located(manifestPath)
    if (r.status !== 'ok') throw new Error(`The base ROM ${r.baseRom.title} is not on this machine`)
    return buildMapDetails(romOf(r), index)
  }

  async mapScreen(
    manifestPath: string,
    index: number,
    screen: number,
    switchFlags: SwitchFlagsDto,
    switches: SwitchStateDto,
  ): Promise<MapScreenResult> {
    const r = this.located(manifestPath)
    if (r.status !== 'ok') return r
    // An edit made in any view must repaint an open map.
    this.notifier.watch(manifestPath, r.working)
    return mapScreen(this.screens, r.working.bytes(), r.romPath, index, screen, switchFlags, switches) // prettier-ignore
  }

  async mapPalaceIcons(manifestPath: string, index: number): Promise<PalaceIconsResult> {
    const r = this.located(manifestPath)
    if (r.status !== 'ok') return r
    const bytes = r.working.bytes()
    const built = this.screens.get(bytes, r.romPath, index, SWITCH_FLAGS_UNCLEARED)
    const rom = RomFile.fromBytes(r.romPath, Buffer.from(bytes))
    return toolbarArtOf(rom, built, this.screens.art(bytes, r.romPath))
  }

  async updateProject(
    manifestPath: string,
    changes: Partial<HackMetadataDto>,
  ): Promise<ProjectDto> {
    return toDto(updateProject(manifestPath, changes))
  }

  async identifyRom(romPath: string): Promise<RomIdentityDto> {
    return romIdentity(new Uint8Array(fs.readFileSync(romPath)))
  }

  async registerRom(romPath: string): Promise<RomIdentityDto> {
    return this.workingRoms.register(romPath)
  }

  async loadMaps(manifestPath: string): Promise<LoadMapsResult> {
    const r = this.located(manifestPath)
    if (r.status !== 'ok') return r
    const { project, romPath } = r
    const rom = romOf(r)
    const tree = buildMapTree(rom)

    // A bad groups.json must not hide the maps: fall back to the ungrouped
    // tree and report why, rather than throwing the whole view away. The
    // decision (use / seed / error) is pure (resolveGroups); only the read
    // and the seed write touch disk.
    const decision = resolveGroups(
      this.readGroupsSafely(manifestPath),
      project.baseRom.sha256 === VANILLA_SHA256,
    )
    let groups: MapGroup[]
    let groupsError: string | undefined
    if (decision.action === 'error') {
      groups = []
      groupsError = decision.groupsError
    } else {
      groups = decision.groups
      if (decision.action === 'seed') {
        try {
          writeGroups(manifestPath, decision.groups)
        } catch (err) {
          // Reported distinctly from a READ failure: there is no bad file to
          // point at here, the write itself (a read-only folder, say) failed.
          groups = []
          groupsError = `Could not seed groups.json: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    const stale = staleSlots(tree, groups)
    const notes = [...tree.notes]
    if (stale.length > 0) {
      notes.push(
        `${stale.length} grouped slots are not maps in this ROM and are kept in meta/groups.json.`,
      )
    }

    return {
      status: 'ok',
      tree: toGroupedDto(tree, groups, notes),
      rawGroups: groups,
      romPath,
      groupsError,
    }
  }

  async setMapGroups(manifestPath: string, groups: MapGroup[]): Promise<SetMapGroupsResult> {
    const r = this.located(manifestPath)
    if (r.status !== 'ok') return r
    const topLevel = topLevelSlots(buildMapTree(romOf(r)))
    const admitted = admitGroups(groups, this.readGroupsSafely(manifestPath), topLevel)
    if (admitted.status === 'invalid') return admitted

    try {
      writeGroups(manifestPath, groups)
    } catch (err) {
      return { status: 'invalid', reason: err instanceof Error ? err.message : String(err) }
    }
    return { status: 'ok' }
  }

  /** The working copy, `rom-not-located`, or a throw for an unreadable project. */
  private located(manifestPath: string): Exclude<WorkingRomResult, { status: 'unreadable' }> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'unreadable') throw new Error(r.reason)
    return r
  }

  /** Reads meta/groups.json, turning a throw into a `GroupsRead` so admission and load decisions stay pure. */
  private readGroupsSafely(manifestPath: string): GroupsRead {
    try {
      return { status: 'ok', groups: readGroups(manifestPath) }
    } catch (err) {
      return { status: 'invalid', reason: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Exports whatever edits are live in this run's WorkingRomRegistry, not a re-read of ops/ from disk. */
  async exportPatch(
    manifestPath: string,
    format: PatchFormatDto = 'bps',
  ): Promise<ExportPatchResult> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status !== 'ok') return r
    const written = exportPatch(r.project.directory, r.project.name, r.working, format)
    return {
      status: 'ok',
      path: written.path,
      hasCopierHeader: written.hasCopierHeader,
      opCount: written.opCount,
    }
  }

  /**
   * Reading the stack is also where this service starts WATCHING the working
   * copy: the frontend calls it when a project opens, and from then on an
   * edit made in any view (a palette colour) pushes here too, so the Edit
   * menu's enablement is never stale.
   */
  async editStack(manifestPath: string): Promise<EditStackResult> {
    const entry = this.workingRoms.get(manifestPath)
    if (entry.status === 'ok') this.notifier.watch(manifestPath, entry.working)
    return this.workingRoms.editStack(manifestPath)
  }

  async undo(manifestPath: string): Promise<EditStackResult> {
    return this.workingRoms.undo(manifestPath)
  }

  async redo(manifestPath: string): Promise<EditStackResult> {
    return this.workingRoms.redo(manifestPath)
  }
}

/** The working copy as a ROM, over a copy of its shared bytes. */
function romOf(entry: WorkingRomEntry): SmwRom {
  return new SmwRom(RomFile.fromBytes(entry.romPath, Buffer.from(entry.working.bytes())))
}

/** Applies groups.json to the raw tree and puts the result on the wire. */
function toGroupedDto(tree: MapTree, groups: MapGroup[], notes: string[]): GroupedMapTreeDto {
  const grouped = applyGroups(tree, groups)
  return {
    special: tree.special,
    unassigned: grouped.unassigned,
    mapCount: tree.mapCount,
    counts: tree.counts,
    notes,
    groups: grouped.groups.map(g => ({ name: g.name, maps: g.maps })),
  }
}

function toDto(p: ReturnType<typeof openProject>): ProjectDto {
  return {
    manifestPath: p.manifestPath,
    directory: p.directory,
    name: p.name,
    title: p.title,
    summary: p.summary,
    authors: p.authors,
    version: p.version,
    baseRom: p.baseRom,
  }
}
