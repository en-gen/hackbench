/**
 * The frontend half of ProjectServiceClient: turns the backend's "a project's
 * working copy changed" push into a local event. Bound as a singleton and
 * handed to `createProxy` as the RPC target, independent of any widget - the
 * subscriber here is a command contribution, which exists from startup.
 *
 * Mirrors palette-push-client.ts. Separate rather than shared because each
 * service's proxy carries its own client, and the push arrives on whichever
 * connection registered it.
 */
import { injectable } from '@theia/core/shared/inversify'
import { Emitter, Event } from '@theia/core/lib/common'
import { ProjectServiceClient } from '../common/project-protocol'

@injectable()
export class ProjectFrontendClient implements ProjectServiceClient {
  private readonly emitter = new Emitter<string>()
  /** Fires with the manifest path whose working copy changed. */
  readonly onChanged: Event<string> = this.emitter.event

  private readonly romEmitter = new Emitter<string>()
  /** Fires with the manifest path whose base ROM was swapped. */
  readonly onRomSwapped: Event<string> = this.romEmitter.event

  onRomChanged(manifestPath: string): void {
    this.romEmitter.fire(manifestPath)
  }

  onWorkingCopyChanged(manifestPath: string): void {
    this.emitter.fire(manifestPath)
  }
}
