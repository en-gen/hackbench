/**
 * The frontend half of ProjectServiceClient: turns the backend's two pushes
 * into local events. Bound as a singleton and handed to `createProxy` as the
 * RPC target, independent of any widget, because the subscribers include
 * command contributions that exist from startup. Widgets do not inject this;
 * they subscribe on ProjectContext, the one bus.
 *
 * Every other service proxy is client-less: an edit made through the palette,
 * Map16 or GFX service reaches every view on THIS connection.
 */
import { injectable } from '@theia/core/shared/inversify'
import { Emitter, Event } from '@theia/core/lib/common'
import type { EditEvent } from '../../../../src/project/EditEvent'
import { ProjectServiceClient } from '../common/project-protocol'

@injectable()
export class ProjectFrontendClient implements ProjectServiceClient {
  private readonly editEmitter = new Emitter<EditEvent>()
  /** Fires with the edit event for every working-copy change. */
  readonly onEdit: Event<EditEvent> = this.editEmitter.event

  private readonly romEmitter = new Emitter<string>()
  /** Fires with the manifest path whose base ROM was swapped or became available. */
  readonly onRomSwapped: Event<string> = this.romEmitter.event

  onEditEvent(event: EditEvent): void {
    this.editEmitter.fire(event)
  }

  onRomChanged(manifestPath: string): void {
    this.romEmitter.fire(manifestPath)
  }
}
