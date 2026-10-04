/** Zoom-out / indicator / zoom-in, shared by Map16, GFX and Maps (#651, #526). */
import * as React from '@theia/core/shared/react'
import { ZoomController } from './zoom-controller'

export interface ZoomStepperProps {
  controller: ZoomController
  /** Adds Actual size (100%) and, if the controller can fit, Fit to window. */
  fitControls?: boolean
}

export function ZoomStepper({ controller, fitControls }: ZoomStepperProps): React.ReactElement {
  return (
    <div className="hb-zoom-stepper">
      {fitControls && (
        <button
          data-control="zoom-actual"
          type="button"
          className="hb-icon-btn"
          title="Actual size (100%)"
          aria-label="Actual size (100%)"
          onClick={() => controller.actualSize()}
        >
          <span className="codicon codicon-screen-normal" />
        </button>
      )}
      {fitControls && controller.canFit && (
        <button
          data-control="zoom-fit"
          type="button"
          className={`hb-icon-btn${controller.fitting ? ' hb-icon-btn-on' : ''}`}
          aria-pressed={controller.fitting}
          title="Fit to window"
          aria-label="Fit to window"
          onClick={() => controller.enterFit({ anchored: true })}
        >
          <span className="codicon codicon-screen-full" />
        </button>
      )}
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
      >{`${Math.round(controller.value * 100)}%`}</span>
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
