/**
 * Backend half of the Objects activity: saved Object definitions.
 *
 * Definitions are project metadata (meta/objects/), never the ROM. The
 * working copy is read only for the two numbers a definition is checked
 * against (tileset count, Map16 tile count), through WorkingRomRegistry like
 * every server (workingCopyGate.test.ts); nothing here writes it. All
 * decisions are in src/project/ObjectDefinitions.ts.
 */
import * as path from 'path'
import { inject, injectable } from '@theia/core/shared/inversify'
import { romFileOf, WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import {
  deleteObjectDefinition,
  ObjectLimits,
  readObjectDefinitions,
  renameObjectDefinition,
  saveObjectDefinition,
} from '../../../../src/project/ObjectDefinitions'
import { map16TileCapacity, TILESET_COUNT } from '../../../../src/rom/Map16'
import {
  DeleteObjectResultDto,
  ListObjectsResult,
  ObjectDraftDto,
  ObjectsService,
  ObjectWriteResultDto,
} from '../common/objects-protocol'

@injectable()
export class ObjectsServiceImpl implements ObjectsService {
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry

  async listObjects(manifestPath: string): Promise<ListObjectsResult> {
    const limits = this.limits(manifestPath)
    if ('status' in limits) return limits
    return { status: 'ok', ...readObjectDefinitions(path.dirname(manifestPath), limits) }
  }

  async saveObject(manifestPath: string, draft: ObjectDraftDto): Promise<ObjectWriteResultDto> {
    const limits = this.limits(manifestPath)
    if ('status' in limits) return limits
    return saveObjectDefinition(path.dirname(manifestPath), limits, draft)
  }

  async renameObject(
    manifestPath: string,
    id: string,
    name: string,
  ): Promise<ObjectWriteResultDto> {
    const limits = this.limits(manifestPath)
    if ('status' in limits) return limits
    return renameObjectDefinition(path.dirname(manifestPath), limits, id, name)
  }

  async deleteObject(manifestPath: string, id: string): Promise<DeleteObjectResultDto> {
    const limits = this.limits(manifestPath)
    if ('status' in limits) return limits
    return deleteObjectDefinition(path.dirname(manifestPath), id)
  }

  /**
   * What a definition is checked against, or `rom-not-located`; an
   * unreadable project throws, as in map16-server.ts. A Map16 that cannot
   * be counted is `unavailable`, so every definition is skipped with that
   * reason rather than checked against a guessed 512.
   */
  private limits(
    manifestPath: string,
  ): ObjectLimits | Extract<ListObjectsResult, { status: 'rom-not-located' }> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') return r
    if (r.status === 'unreadable') throw new Error(r.reason)
    const capacity = map16TileCapacity(romFileOf(r))
    return 'reason' in capacity
      ? { tilesetCount: TILESET_COUNT, tileCount: 0, unavailable: capacity.reason }
      : { tilesetCount: TILESET_COUNT, tileCount: capacity.count }
  }
}
