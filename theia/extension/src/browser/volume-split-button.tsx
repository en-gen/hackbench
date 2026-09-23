/**
 * Volume as a split button: the main half toggles mute, the chevron opens a
 * popover holding a slider. Same shape as the VS Code extension's controls
 * (mapEditor's popover slider, transportBar's click-to-mute), in one control
 * any view that plays sound can reuse.
 *
 * Stateless: the owner holds the VolumeState and applies it, so the control
 * cannot drift from what is actually audible.
 */
import * as React from '@theia/core/shared/react'
import { MAX_VOLUME, VolumeState, effectiveGain, setVolume, toggleMute } from './audio-volume'

export interface VolumeSplitButtonProps {
  state: VolumeState
  onChange(next: VolumeState): void
  /** Set when there is no sound to control; shown as the tooltip. */
  unavailable?: string
}

export function VolumeSplitButton({
  state,
  onChange,
  unavailable,
}: VolumeSplitButtonProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const root = React.useRef<HTMLDivElement>(null)
  const dropdown = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Escape is handled here, not on document, so it only closes this popover,
  // and focus goes back to the chevron rather than dropping to <body>.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (open && e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
      dropdown.current?.focus()
    }
  }

  const silent = effectiveGain(state) === 0
  // The slider shows the stored level even while muted: showing 0 would let
  // one arrow key overwrite the level unmute is meant to restore.
  const percent = Math.round(state.volume * 100)
  const disabled = unavailable !== undefined

  return (
    <div className="hb-volume" ref={root} onKeyDown={onKeyDown}>
      <button
        className="hb-volume-mute"
        disabled={disabled}
        aria-pressed={state.muted}
        aria-label="Mute"
        title={unavailable ?? (state.muted ? 'Unmute' : `Mute (${percent}%)`)}
        onClick={() => onChange(toggleMute(state))}
      >
        <span className={`codicon ${silent ? 'codicon-mute' : 'codicon-unmute'}`} />
      </button>
      <button
        ref={dropdown}
        className="hb-volume-dropdown"
        disabled={disabled}
        aria-label="Volume"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={unavailable ?? 'Volume'}
        onClick={() => setOpen(!open)}
      >
        <span className="codicon codicon-chevron-down" />
      </button>
      {open && !disabled && (
        <div className="hb-volume-popover" role="dialog" aria-label="Volume">
          <input
            type="range"
            min={0}
            max={MAX_VOLUME * 100}
            step={1}
            value={percent}
            autoFocus
            aria-label="Volume"
            aria-valuetext={state.muted ? `${percent}%, muted` : `${percent}%`}
            onChange={e => onChange(setVolume(Number(e.currentTarget.value) / 100))}
          />
          <span className="hb-volume-readout">{state.muted ? 'Muted' : `${percent}%`}</span>
        </div>
      )}
    </div>
  )
}
