/**
 * Cancels Ctrl + wheel everywhere in the shell (#651): only a zoom
 * stepper's own `ZoomController.bindWheel` ever acts on it. Capture phase,
 * so this runs before a bubble-phase handler deeper in the DOM (Monaco
 * stops propagation on its own) can swallow the event first.
 */
import { injectable } from '@theia/core/shared/inversify'
import { FrontendApplicationContribution } from '@theia/core/lib/browser'

@injectable()
export class CtrlWheelGuardContribution implements FrontendApplicationContribution {
  onStart(): void {
    window.addEventListener(
      'wheel',
      e => {
        if (e.ctrlKey) e.preventDefault()
      },
      { passive: false, capture: true },
    )
  }
}
