/**
 * Backend half of the Objects activity: saved Object definitions.
 *
 * Definitions are project metadata (meta/objects/), never the ROM. The
 * working copy is reached through WorkingRomRegistry like every server
 * (workingCopyGate.test.ts) and is never written. The logic is in
 * objects-core.ts, which a unit test can load without the DI container; the
 * decisions are in src/project/ObjectDefinitions.ts.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'
import {
  DeleteObjectResultDto,
  ListObjectsResult,
  ObjectDraftDto,
  ObjectsService,
  ObjectWriteResultDto,
} from '../common/objects-protocol'
import { ObjectsCore } from './objects-core'

@injectable()
export class ObjectsServiceImpl implements ObjectsService {
  @inject(WorkingRomRegistry) protected readonly workingRoms!: WorkingRomRegistry

  private core?: ObjectsCore
  private get ops(): ObjectsCore {
    return (this.core ??= new ObjectsCore(this.workingRoms))
  }

  async listObjects(manifestPath: string): Promise<ListObjectsResult> {
    return this.ops.list(manifestPath)
  }

  async saveObject(manifestPath: string, draft: ObjectDraftDto): Promise<ObjectWriteResultDto> {
    return this.ops.save(manifestPath, draft)
  }

  async renameObject(
    manifestPath: string,
    id: string,
    name: string,
  ): Promise<ObjectWriteResultDto> {
    return this.ops.rename(manifestPath, id, name)
  }

  async deleteObject(manifestPath: string, id: string): Promise<DeleteObjectResultDto> {
    return this.ops.delete(manifestPath, id)
  }
}
