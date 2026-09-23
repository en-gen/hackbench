/**
 * The frontend half of Map16ServiceClient - see palette-push-client.ts for
 * why this is a standalone singleton rather than a method on the widget
 * itself.
 */
import { injectable } from '@theia/core/shared/inversify'
import { Emitter, Event } from '@theia/core/lib/common'
import { Map16ServiceClient } from '../common/map16-protocol'

@injectable()
export class Map16FrontendClient implements Map16ServiceClient {
  private readonly emitter = new Emitter<string>()
  /** Fires with the manifest path whose working copy changed. */
  readonly onChanged: Event<string> = this.emitter.event

  onWorkingCopyChanged(manifestPath: string): void {
    this.emitter.fire(manifestPath)
  }
}
