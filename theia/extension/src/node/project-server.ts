/**
 * Backend half of the project service.
 *
 * Thin on purpose: all the real work lives in the shell-free project and ROM
 * modules, which are unit tested without Theia, VS Code or a browser. This
 * class exists only to put those modules on the wire.
 */
import { injectable } from '@theia/core/shared/inversify'
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
import * as fs from 'fs'
import {
  CreateProjectRequest,
  HackMetadataDto,
  LoadMapsResult,
  ProjectDto,
  ProjectService,
  RecentProjectDto,
  RomIdentityDto,
} from '../common/project-protocol'

@injectable()
export class ProjectServiceImpl implements ProjectService {
  private readonly registry = new RomRegistry()
  private readonly recent = new RecentProjects()

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
