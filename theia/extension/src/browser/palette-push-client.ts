/**
 * The frontend half of PaletteServiceClient: turns the backend's
 * "a project's working copy changed" push into a local event any widget can
 * subscribe to. Bound as a singleton and handed to `createProxy` as the RPC
 * target, independent of whether a palette explorer or group tab currently
 * exists - the push can arrive before one is ever opened.
 */
import { injectable } from '@theia/core/shared/inversify'
import { Emitter, Event } from '@theia/core/lib/common'
import { PaletteServiceClient } from '../common/palette-protocol'

@injectable()
export class PaletteFrontendClient implements PaletteServiceClient {
  private readonly emitter = new Emitter<string>()
  /** Fires with the manifest path whose working copy changed. */
  readonly onChanged: Event<string> = this.emitter.event

  onWorkingCopyChanged(manifestPath: string): void {
    this.emitter.fire(manifestPath)
  }
}
