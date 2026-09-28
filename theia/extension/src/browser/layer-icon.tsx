/**
 * A graphics layer's toolbar icon (the owner's, from the VS Code extension's
 * map editor): three stacked bars, the layer's own in the foreground color
 * and the other two dimmed. L3 (overlay) is the top bar, L1 (foreground) the
 * middle and L2 (background) the bottom.
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
