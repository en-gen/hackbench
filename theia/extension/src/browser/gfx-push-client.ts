/**
 * The frontend half of GfxServiceClient - see palette-push-client.ts for why
 * this is a standalone singleton rather than a method on the widget itself.
 */
import { injectable } from '@theia/core/shared/inversify'
import { Emitter, Event } from '@theia/core/lib/common'
import { GfxServiceClient } from '../common/gfx-protocol'

@injectable()
export class GfxFrontendClient implements GfxServiceClient {
  private readonly emitter = new Emitter<string>()
  /** Fires with the manifest path whose working copy changed. */
  readonly onChanged: Event<string> = this.emitter.event

  onWorkingCopyChanged(manifestPath: string): void {
    this.emitter.fire(manifestPath)
  }
}
