/**
 * The Objects service's logic without the DI container, as map16-decode.ts
 * does for Map16: objects-server.ts imports inversify, which the unit job
 * does not install, so everything a test must reach lives here.
 *
 * Definitions are project metadata (meta/objects/), never the ROM. The
 * working copy is read only for the two numbers a definition is checked
 * against (tileset count, Map16 tile count); nothing here writes it.
 */
import * as path from 'path'
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
  ObjectWriteResultDto,
} from '../common/objects-protocol'

type OkWorkingRom = { status: 'ok' } & Parameters<typeof romFileOf>[0]

/** What a definition is checked against, from the working copy's own Map16. */
export function limitsOfWorkingCopy(r: OkWorkingRom): ObjectLimits {
  const capacity = map16TileCapacity(romFileOf(r))
  return 'reason' in capacity
    ? { tilesetCount: TILESET_COUNT, tileCount: 0, unavailable: capacity.reason }
    : { tilesetCount: TILESET_COUNT, tileCount: capacity.count }
}

export class ObjectsCore {
  constructor(
    private readonly workingRoms: WorkingRomRegistry,
    /** Replaceable so a test can use a synthetic ROM that has no readable Map16. */
    private readonly limitsOf: (r: OkWorkingRom) => ObjectLimits = limitsOfWorkingCopy,
  ) {}

  list(manifestPath: string): ListObjectsResult {
    const limits = this.limits(manifestPath)
    if ('status' in limits) return limits
    return { status: 'ok', ...readObjectDefinitions(path.dirname(manifestPath), limits) }
  }

  save(manifestPath: string, draft: ObjectDraftDto): ObjectWriteResultDto {
    const limits = this.limits(manifestPath)
    if ('status' in limits) return limits
    return saveObjectDefinition(path.dirname(manifestPath), limits, draft)
  }

  rename(manifestPath: string, id: string, name: string): ObjectWriteResultDto {
    const limits = this.limits(manifestPath)
    if ('status' in limits) return limits
    return renameObjectDefinition(path.dirname(manifestPath), limits, id, name)
  }

  delete(manifestPath: string, id: string): DeleteObjectResultDto {
    const limits = this.limits(manifestPath)
    if ('status' in limits) return limits
    return deleteObjectDefinition(path.dirname(manifestPath), id)
  }

  /**
   * `rom-not-located` passes through; an unreadable project throws, as in
   * map16-server.ts. A Map16 that cannot be counted makes every definition
   * skipped with that reason rather than checked against a guessed 512.
   */
  private limits(
    manifestPath: string,
  ): ObjectLimits | Extract<ListObjectsResult, { status: 'rom-not-located' }> {
    const r = this.workingRoms.get(manifestPath)
    if (r.status === 'rom-not-located') return r
    if (r.status === 'unreadable') throw new Error(r.reason)
    return this.limitsOf(r)
  }
}
