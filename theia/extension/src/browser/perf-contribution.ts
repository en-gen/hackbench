/** Emits `hb:shell-ready`: navigation start to the shell's `ready` state. */
import { inject, injectable } from '@theia/core/shared/inversify'
import { FrontendApplicationContribution } from '@theia/core/lib/browser'
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state'

@injectable()
export class PerfContribution implements FrontendApplicationContribution {
  @inject(FrontendApplicationStateService)
  protected readonly state!: FrontendApplicationStateService

  onStart(): void {
    void this.state
      .reachedState('ready')
      .then(() => performance.measure('hb:shell-ready', { start: 0 }))
  }
}
