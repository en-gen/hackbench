/**
 * A graphics layer's toolbar icon (the owner's, from the VS Code extension's
 * map editor): three stacked bars, the layer's own in the foreground color
 * and the other two dimmed. L3 (overlay) is the top bar, L1 (foreground) the
 * middle and L2 (background) the bottom.
 *
 * `LayerToggle` is the one show/hide button built on it, shared by the Map
 * tab and the Overworld view.
 */
import * as React from '@theia/core/shared/react'

const BARS = { top: 1, middle: 6, bottom: 11 } as const

export function LayerIcon({ highlight }: { highlight: keyof typeof BARS }): React.ReactElement {
  return (
    <svg className="hb-layer-icon" width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
      {Object.values(BARS).map(y => (
        <rect key={y} x="1" y={y} width="14" height="3" rx="1" data-on={y === BARS[highlight]} />
      ))}
    </svg>
  )
}

/** A layer's show/hide button. `label` is its tooltip; a disabled button says why in it. */
export function LayerToggle(props: {
  highlight: keyof typeof BARS
  label: string
  pressed: boolean
  disabled?: boolean
  control: string
  onClick(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      data-control={props.control}
      className={'hb-icon-btn hb-layer-btn' + (props.pressed ? ' hb-icon-btn-on' : '')}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
    >
      <LayerIcon highlight={props.highlight} />
    </button>
  )
}
