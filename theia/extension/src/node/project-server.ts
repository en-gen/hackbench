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
import { RomRegistry } from '../../../../src/project/RomRegistry'
import { RecentProjects } from '../../../../src/project/RecentProjects'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildMapTree } from '../../../../src/rom/MapTree'
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import { buildMapDetails } from './map-details'
import { exportPatch } from '../../../../src/project/ExportPatch'
import * as fs from 'fs'
import {
  CreateProjectRequest,
  EditStackResult,
  ExportPatchResult,
  HackMetadataDto,
  LoadMapsResult,
  MapDetailsDto,
  ProjectDto,
  ProjectService,
  ProjectServiceClient,
  RecentProjectDto,
  RomIdentityDto,
} from '../common/project-protocol'
import { WorkingCopyNotifier } from './working-copy-notifier'

@injectable()
export class ProjectServiceImpl implements ProjectService {
  private readonly registry = new RomRegistry()
  private readonly recent = new RecentProjects()
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry
  private readonly notifier = new WorkingCopyNotifier<ProjectServiceClient>()

  setClient(client: ProjectServiceClient | undefined): void {
    this.notifier.setClient(client)
  }

  async createProject(req: CreateProjectRequest): Promise<ProjectDto> {
    const p = createProject(req)
    // The user has just pointed at their cartridge, which is the only moment
    // we are certain where it is. Recording it here is what lets the project
    // itself stay path-free.
    this.registry.register(req.romPath)
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
    return buildMapDetails(this.romFor(manifestPath), index)
  }

  /**
   * The cartridge behind a project, or a refusal.
   *
   * Opened per call rather than cached: the registry re-verifies the hash, and
   * a cart the user swapped under us must not keep resolving to the old one.
   */
  private romFor(manifestPath: string): SmwRom {
    const project = openProject(manifestPath)
    const romPath = this.registry.resolve(project.baseRom.sha256)
    if (!romPath) {
      throw new Error(`The base ROM for ${project.name} is not on this machine`)
    }
    return new SmwRom(RomFile.load(romPath))
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
    return this.registry.register(romPath)
  }

  async loadMaps(manifestPath: string): Promise<LoadMapsResult> {
    const project = openProject(manifestPath)
    const romPath = this.registry.resolve(project.baseRom.sha256)
    if (!romPath) {
      return { status: 'rom-not-located', baseRom: project.baseRom }
    }

    const rom = new SmwRom(RomFile.load(romPath))
    return { status: 'ok', tree: buildMapTree(rom), romPath }
  }

  /**
   * Diff the working copy against the base cartridge and write an .ips.
   *
   * Uses the SAME WorkingRomRegistry instance palette-server.ts writes
   * through, so this exports whatever edits are actually live in this run,
   * not a re-read of ops/ from disk (which would also be correct, but would
   * silently miss an unflushed in-memory state if one ever existed).
   */
  async exportPatch(manifestPath: string): Promise<ExportPatchResult> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status !== 'ok') return r
    const written = exportPatch(r.project.directory, r.project.name, r.working)
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
