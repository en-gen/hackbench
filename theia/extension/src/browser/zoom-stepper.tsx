/**
 * The zoom-out / indicator / zoom-in trio, lifted from the Map16 sheet's own
 * toolbar (#651) so the GFX sheet gets the identical control instead of its
 * own `<select>`, and both get Ctrl + wheel through the shared
 * `ZoomController` alone. `data-control` values are unchanged so the
 * existing Playwright specs still find these buttons.
 */
import * as React from '@theia/core/shared/react'
import { ZoomController } from './zoom-controller'

export interface ZoomStepperProps {
  controller: ZoomController
}

export function ZoomStepper({ controller }: ZoomStepperProps): React.ReactElement {
  return (
    <div className="hb-zoom-stepper">
      <button
        data-control="zoom-out"
        type="button"
        className="hb-zoom-btn"
        disabled={!controller.canZoomOut}
        title="Zoom out"
        aria-label="Zoom out"
        onClick={() => controller.step(-1)}
      >
        <span className="codicon codicon-zoom-out" />
      </button>
      <span
        data-control="zoom-indicator"
        className="hb-zoom-indicator"
      >{`${controller.value}x`}</span>
      <button
        data-control="zoom-in"
        type="button"
        className="hb-zoom-btn"
        disabled={!controller.canZoomIn}
        title="Zoom in"
        aria-label="Zoom in"
        onClick={() => controller.step(1)}
      >
        <span className="codicon codicon-zoom-in" />
      </button>
    </div>
  )
}
