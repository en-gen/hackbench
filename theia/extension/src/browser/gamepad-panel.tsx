/**
 * The controllers fly-out: one live drawing per player, who drives it, and
 * the drawing's color style. Stateless: ControllerSession owns the state, so
 * what is drawn is what is being sent.
 */
import * as React from '@theia/core/shared/react'
import { CONTROLLER_SVG } from './controller-art'
import {
  ControllerScheme,
  ControllerSettings,
  ControllerStyle,
  SCHEME_COLORS,
  PlayerAssignment,
} from './controller-settings'

const svgCache = new Map<number, string>()

/** One copy of the art per player, with ids made unique so gradients never cross copies. */
function svgFor(player: number): string {
  let svg = svgCache.get(player)
  if (!svg) {
    const tag = `-p${player + 1}`
    svg = CONTROLLER_SVG.replace(/\bid="([^"]+)"/g, `id="$1${tag}"`)
      .replace(/url\(#([^)]+)\)/g, `url(#$1${tag})`)
      .replace(/href="#([^"]+)"/g, `href="#$1${tag}"`)
    svgCache.set(player, svg)
  }
  return svg
}

export interface ConnectedPad {
  index: number
  id: string
  /** Reports the standard mapping; others are not read until they can be remapped. */
  standard: boolean
}

export interface ControllerDrawingProps {
  player: number
  scheme: ControllerScheme
  /** libretro joypad ids this player is sending now. */
  pressed: ReadonlySet<number>
}

export function ControllerDrawing({
  player,
  scheme,
  pressed,
}: ControllerDrawingProps): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null)
  const html = React.useMemo(() => ({ __html: svgFor(player) }), [player])
  // The SVG is not React-managed, so lit parts are toggled on its own nodes.
  React.useLayoutEffect(() => {
    ref.current?.querySelectorAll('[data-btn]').forEach(el => {
      el.classList.toggle('hb-pad-on', pressed.has(Number(el.getAttribute('data-btn'))))
    })
  }, [pressed])
  return (
    <div
      ref={ref}
      className={`hb-pad-art hb-pad-${scheme}`}
      data-player={player + 1}
      data-scheme={scheme}
      style={SCHEME_COLORS[scheme] as React.CSSProperties}
      dangerouslySetInnerHTML={html}
    />
  )
}

export interface GamepadPanelProps {
  settings: ControllerSettings
  scheme: ControllerScheme
  pads: ConnectedPad[]
  pressed(port: number): ReadonlySet<number>
  active(player: number): boolean
  onSelect(player: number): void
  onKeyboard(player: number, on: boolean): void
  onPad(player: number, pad: number | undefined): void
  onStyle(style: ControllerStyle): void
  onClose(): void
}

export function GamepadPanel(props: GamepadPanelProps): React.ReactElement {
  const { settings, scheme, pads } = props
  return (
    <aside className="hb-pad-flyout" aria-label="Controllers">
      <div className="hb-pad-head">
        <span className="hb-pad-title">Controllers</span>
        <span className="hb-toolbar-spacer" />
        <button
          className="hb-icon-btn"
          title="Close"
          aria-label="Close controllers"
          onClick={props.onClose}
        >
          <span className="codicon codicon-close" />
        </button>
      </div>
      <div className="hb-pad-tabs" role="tablist" aria-label="Players">
        {settings.players.map((_, i) => (
          <button
            key={i}
            role="tab"
            id={`hb-pad-tab-${i}`}
            aria-selected={settings.selectedPlayer === i}
            aria-controls="hb-pad-tabpanel"
            tabIndex={settings.selectedPlayer === i ? 0 : -1}
            className={`hb-pad-tab${settings.selectedPlayer === i ? ' hb-pad-tab-on' : ''}`}
            onClick={() => props.onSelect(i)}
            onKeyDown={e => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              props.onSelect(1 - i)
              document.getElementById(`hb-pad-tab-${1 - i}`)?.focus()
            }}
          >
            Player {i + 1}
            {props.active(i) && (
              <span className="hb-pad-dot" data-active="true" aria-label="active" />
            )}
          </button>
        ))}
      </div>
      <div
        id="hb-pad-tabpanel"
        role="tabpanel"
        aria-labelledby={`hb-pad-tab-${settings.selectedPlayer}`}
      >
        <PlayerRow
          index={settings.selectedPlayer}
          player={settings.players[settings.selectedPlayer]}
          scheme={scheme}
          pads={pads}
          pressed={props.pressed(settings.selectedPlayer)}
          onKeyboard={props.onKeyboard}
          onPad={props.onPad}
        />
      </div>
      <label className="hb-pad-field">
        <span>Controller style</span>
        <select
          aria-label="Controller style"
          value={settings.style}
          onChange={e => props.onStyle(e.target.value as ControllerStyle)}
        >
          <option value="auto">Auto</option>
          <option value="na">North American</option>
          <option value="pal">PAL</option>
        </select>
      </label>
    </aside>
  )
}

interface PlayerRowProps {
  index: number
  player: PlayerAssignment
  scheme: ControllerScheme
  pads: ConnectedPad[]
  pressed: ReadonlySet<number>
  onKeyboard: GamepadPanelProps['onKeyboard']
  onPad: GamepadPanelProps['onPad']
}

function PlayerRow(props: PlayerRowProps): React.ReactElement {
  const { index, player, pads } = props
  // A pad assigned but not plugged in stays selectable, so it is not silently dropped.
  const missing = player.pad !== undefined && !pads.some(p => p.index === player.pad)
  return (
    <section className="hb-pad-player" data-player-row={index + 1}>
      <ControllerDrawing player={index} scheme={props.scheme} pressed={props.pressed} />
      <label className="hb-pad-field">
        <input
          type="checkbox"
          aria-label={`Player ${index + 1} keyboard`}
          checked={player.keyboard}
          onChange={e => props.onKeyboard(index, e.target.checked)}
        />
        <span>Keyboard</span>
      </label>
      <label className="hb-pad-field">
        <span>Gamepad</span>
        <select
          aria-label={`Player ${index + 1} gamepad`}
          value={player.pad ?? ''}
          onChange={e =>
            props.onPad(index, e.target.value === '' ? undefined : Number(e.target.value))
          }
        >
          <option value="">None</option>
          {missing && <option value={player.pad}>Gamepad {player.pad! + 1} (not connected)</option>}
          {pads.map(p => (
            <option key={p.index} value={p.index}>
              Gamepad {p.index + 1}: {p.id}
              {p.standard ? '' : ' (layout not recognized)'}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}
