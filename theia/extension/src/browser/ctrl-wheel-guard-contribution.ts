/**
 * Stops Ctrl + wheel from ever reaching Chromium's own page-zoom (#651).
 *
 * A view's `ZoomController.bindWheel` already preventDefault's Ctrl + wheel
 * over its own scroll node, which is enough while the pointer is over a
 * zoom-aware view. Elsewhere - the explorer, a panel with no zoom control,
 * the gap between widgets - nothing does, so Chromium still zooms the whole
 * window. This contribution is the backstop: a bubble-phase (not capture)
 * window listener, so a view's own handler runs first and can still decide
 * what to do; this one just guarantees SOME handler always preventDefault's.
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
      { passive: false },
    )
  }
}
