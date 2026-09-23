/**
 * Details and editing for one BGR555 word, plus, for an animated CGRAM
 * index, a playing preview with its frames directly beneath.
 *
 * Nothing is written until OK (or Enter): an earlier live-preview layer
 * left `old` unable to match the committed bytes by the time OK ran, so
 * every commit refused. The parent owns the service call; this component
 * owns only the pick.
 */
import * as React from '@theia/core/shared/react'
import { PaletteAnimTargetDto, PaletteColorDto } from '../common/palette-protocol'
import {
  bgr555HexToCssHex,
  cssColor,
  cssHexToBgr555,
  formatBgr555,
  formatRomAddr,
  normalizeBgr555Hex,
} from './palette-color-format'
import { PaletteFrameStrip } from './palette-frame-strip'
import { framePhase } from './palette-view-model'
import { frameClock, FrameSubscription } from '../../../../src/webview/shared/frameClock'
import { hex2 } from '../../../../src/webview/shared/hex'

export interface EditableWord {
  color: PaletteColorDto
  table: string
  romAddr: number
}

export interface PaletteInspectorProps {
  title: string
  word: EditableWord | undefined
  /** Shown above the details, e.g. "Stock value, overwritten every frame". */
  wordLabel?: string
  animation?: PaletteAnimTargetDto
  /** Whether the owning tab is currently shown; the preview pauses while it is not. */
  visible: boolean
  selectedFrame: number | undefined
  onSelectFrame: (index: number | undefined) => void
  error: string | undefined
  onCommit: (romAddr: number, oldHex: string, newHex: string) => void
  onDismissError: () => void
}

interface InspectorState {
  pickedHex?: string
  pickedCssHex?: string
  hexDraft?: string
  playing: number
}

export class PaletteInspector extends React.Component<PaletteInspectorProps, InspectorState> {
  override state: InspectorState = { playing: 0 }
  protected clock: FrameSubscription | undefined

  /**
   * On this inspector's own root, not the document: two tabs each mount an
   * inspector, and a document listener let Escape in one discard the other's pick.
   */
  protected readonly onKeyDown = (e: React.KeyboardEvent): void => {
    if (
      e.key === 'Escape' &&
      (this.state.pickedHex !== undefined || this.state.hexDraft !== undefined)
    ) {
      this.cancel()
    }
  }

  override componentDidMount(): void {
    this.syncClock()
  }

  override componentDidUpdate(): void {
    this.syncClock()
  }

  override componentWillUnmount(): void {
    this.clock?.stop()
  }

  /**
   * Plays only while animated, no frame is pinned, and the owning tab is
   * visible. Theia main-area tabs share one document, so rAF keeps firing
   * for a hidden tab; `visible` (from the widget's onAfterShow/onAfterHide)
   * is what actually stops it, not rAF on its own.
   */
  protected syncClock(): void {
    const a = this.props.animation
    const shouldRun =
      !!a && a.frames.length > 0 && this.props.selectedFrame === undefined && this.props.visible
    if (shouldRun && !this.clock) {
      this.clock = frameClock.every(
        () => this.props.animation?.frameStride ?? 1,
        () => {
          const anim = this.props.animation
          if (!anim) return
          this.setState({
            playing: framePhase(frameClock.frame, anim.frameStride, anim.frames.length),
          })
        },
      )
      this.clock.start()
    } else if (!shouldRun && this.clock) {
      this.clock.stop()
      this.clock = undefined
    }
  }

  protected cancel(): void {
    this.setState({ pickedHex: undefined, pickedCssHex: undefined, hexDraft: undefined })
    this.props.onDismissError()
  }

  protected commit(): void {
    const w = this.props.word
    const newHex = this.state.pickedHex
    if (!w || !newHex) return
    const committed = formatBgr555(w.color)
    if (newHex === committed) return
    this.setState({ pickedHex: undefined, pickedCssHex: undefined, hexDraft: undefined })
    this.props.onCommit(w.romAddr, committed, newHex)
  }

  override render(): React.ReactNode {
    const { word, animation } = this.props
    const committed = word ? formatBgr555(word.color) : '$----'
    const shown = this.state.pickedHex ?? committed
    const hasPick =
      !!word && this.state.pickedHex !== undefined && this.state.pickedHex !== committed
    const quantized =
      !!word && this.state.pickedCssHex !== undefined && this.state.pickedHex === committed
    const previewColor =
      animation && animation.frames.length > 0 && this.props.selectedFrame === undefined
        ? cssColor(animation.frames[this.state.playing % animation.frames.length]!.color)
        : word
          ? bgr555HexToCssHex(shown)
          : undefined

    return (
      <aside
        className={'hb-palette-inspector' + (word ? '' : ' hb-palette-inspector-empty')}
        onKeyDown={this.onKeyDown}
      >
        <div className="hb-palette-inspector-title">{this.props.title}</div>
        <div
          className="hb-palette-preview"
          style={previewColor ? { background: previewColor } : undefined}
        />
        {animation && (
          <PaletteFrameStrip
            frames={animation.frames}
            playingIndex={this.props.selectedFrame === undefined ? this.state.playing : undefined}
            selectedIndex={this.props.selectedFrame}
            onSelect={i => this.props.onSelectFrame(this.props.selectedFrame === i ? undefined : i)}
          />
        )}
        {this.props.wordLabel && (
          <div className="hb-palette-inspector-wordlabel">{this.props.wordLabel}</div>
        )}
        <dl className="hb-palette-inspector-readout">
          <dt>Table</dt>
          <dd>{word ? `${word.table} ${formatRomAddr(word.romAddr)}` : '-'}</dd>
          <dt>Value</dt>
          <dd>{committed}</dd>
          <dt>RGB</dt>
          <dd>{word ? `${word.color.r}, ${word.color.g}, ${word.color.b}` : '-, -, -'}</dd>
        </dl>
        <div className="hb-palette-inspector-edit">
          <input
            type="color"
            className="hb-palette-inspector-color"
            disabled={!word}
            value={word ? bgr555HexToCssHex(shown) : '#000000'}
            onChange={e => {
              const v = e.currentTarget.value
              let hex: string | undefined
              try {
                hex = cssHexToBgr555(v)
              } catch {
                return
              }
              this.setState({ pickedCssHex: v, pickedHex: hex, hexDraft: undefined })
            }}
          />
          <input
            type="text"
            className="hb-palette-inspector-hex"
            disabled={!word}
            placeholder="$----"
            value={this.state.hexDraft ?? (word ? shown.slice(1) : '')}
            onChange={e => {
              const v = e.currentTarget.value
              let hex: string | undefined
              try {
                hex = normalizeBgr555Hex(v)
              } catch {
                hex = undefined
              }
              this.setState({ hexDraft: v, pickedCssHex: undefined, pickedHex: hex })
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') this.commit()
              else if (e.key === 'Escape') {
                // Also clears an error with no draft; the root handler would not.
                e.stopPropagation()
                this.cancel()
              }
            }}
            // No onBlur: clearing the draft on blur ate the typed value before OK's click read it.
          />
          <button
            type="button"
            className="hb-palette-inspector-ok"
            disabled={!hasPick}
            onClick={() => this.commit()}
          >
            OK
          </button>
          <button
            type="button"
            className="hb-palette-inspector-cancel"
            disabled={!hasPick}
            onClick={() => this.cancel()}
          >
            Cancel
          </button>
        </div>
        <div
          className={
            'hb-palette-inspector-from' +
            (this.props.error ? ' hb-palette-inspector-from-error' : '')
          }
        >
          {this.props.error ??
            (quantized
              ? 'That color rounds to the same BGR555 word already here - nothing to apply. Try the hex field for an exact value.'
              : word
                ? ''
                : 'Click a swatch to inspect and edit it')}
        </div>
        {animation && <AnimationNotes animation={animation} />}
      </aside>
    )
  }
}

function AnimationNotes({ animation }: { animation: PaletteAnimTargetDto }): React.ReactElement {
  const t = animation.timing
  return (
    <div className="hb-palette-inspector-notes">
      <div>
        {`${animation.frames.length} frames, every ${animation.frameStride} frames (~${animation.intervalMs} ms): ` +
          `AND #$${hex2(t.mask)} + ${t.shift} LSR at ${formatRomAddr(t.maskAddr)}. Timing is code, not data, and is not editable here.`}
      </div>
      {animation.sharedWithOtherTargets === true && (
        <div>
          Another animated color reads some of these frame words; editing one changes it there too.
        </div>
      )}
      {animation.sharedWithOtherTargets === 'unknown' && (
        <div>
          The overworld routine could not be read, so other readers of these frame words are
          unknown.
        </div>
      )}
    </div>
  )
}
