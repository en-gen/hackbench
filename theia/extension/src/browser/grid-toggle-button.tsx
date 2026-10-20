/** The grid on/off toolbar button, shared by Maps and Map16. */
import * as React from '@theia/core/shared/react'

export interface GridToggleButtonProps {
  on: boolean
  onToggle: () => void
}

/** Toolbar button shared by the Maps and Map16 views, so both name the grid control and its states the same way. */
export function GridToggleButton({ on, onToggle }: GridToggleButtonProps): React.ReactElement {
  const label = on ? 'Hide grid' : 'Show grid'
  return (
    <button
      data-control="grid-toggle"
      type="button"
      className={'hb-icon-btn' + (on ? ' hb-icon-btn-on' : ' hb-icon-btn-off')}
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={onToggle}
    >
      <span className="codicon codicon-table" />
    </button>
  )
}
