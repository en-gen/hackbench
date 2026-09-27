/** Zoom-out / indicator / zoom-in, shared by Map16 and GFX (#651). */
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
        className="hb-icon-btn"
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
        className="hb-icon-btn"
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
