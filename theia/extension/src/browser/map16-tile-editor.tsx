/**
 * The two tile surfaces: the PREVIEW, which is what the view opens on, and
 * the EDIT PANE below it, which is absent until the user asks for it.
 *
 * Most of the time the user is looking rather than editing, and a
 * permanently armed editor makes looking feel risky. Splitting them also
 * lets the edit pane be denser than a browsing view should be, because it
 * is only present when asked for.
 *
 * The hover affordance OVERLAYS the preview (docs/ui-conventions.md):
 * emphasis never moves layout, so nothing may reflow when the pointer
 * arrives.
 *
 * Nothing here accepts a typed character number. The number is READ-ONLY
 * text beside the picture: recognition comes from the picture, verification
 * from the number. Every control moves exactly ONE field - picking a
 * character sets the character and leaves the color row alone, because
 * taking the source's row would change two fields from one gesture and the
 * palette's colors come from the selected quadrant's row rather than from
 * the character itself.
 */
import * as React from '@theia/core/shared/react'
import {
  Map16Field,
  Map16QuadrantKey,
  Map16SheetDto,
  Map16SwitchKind,
  Map16TileDto,
} from '../common/map16-protocol'
import { CHAR_PX, HOVER_DIM, TILE_PX, paintScaled } from './map16-pixels'
import {
  activeFor,
  charSourceLabel,
  formatCharNum,
  swatchCountFor,
  toggleKinds,
} from './map16-view-model'
import { formatRomAddr } from './palette-color-format'
import { SwitchToggle, type SwitchButtonImages } from './switch-toggle'

const SWITCH_BUTTON_SCALE = 2

/** 12x: a 16x16 tile becomes a 192px preview, the view's dominant element. */
export const PREVIEW_SCALE = 12
/** 5x per 8x8 character, so one frame is 80px and four sit side by side. */
export const FRAME_QUADRANT_SCALE = 5

export const QUADRANTS: readonly { key: Map16QuadrantKey; label: string }[] = [
  { key: 'tl', label: 'Top-left' },
  { key: 'tr', label: 'Top-right' },
  { key: 'bl', label: 'Bottom-left' },
  { key: 'br', label: 'Bottom-right' },
]

/** The toggles, as text rather than glyphs: ui-conventions requires a glyph
 * to mean exactly one thing, and no codicon means "flip vertically". */
const TOGGLES: readonly { field: Map16Field; label: string; title: string }[] = [
  { field: 'flipX', label: 'Flip X', title: 'Mirror this character horizontally' },
  { field: 'flipY', label: 'Flip Y', title: 'Mirror this character vertically' },
  { field: 'priority', label: 'Priority', title: 'Draw this character in front of sprites' },
]

export interface Map16TilePreviewProps {
  tile: Map16TileDto
  editing: boolean
  onToggleEdit(): void
  previewCanvasRef(el: HTMLCanvasElement | null): void
  /** Which of this tile's switches are on: view state, never an edit. */
  activeSwitches: ReadonlySet<Map16SwitchKind>
  onToggleSwitch(kind: Map16SwitchKind): void
  /** Sheet-level reason some switch alternates could not be read. */
  switchUnavailable: string | undefined
  /** Each toggle button's own pictures; a missing kind falls back to its text label. */
  buttonImages: Partial<Record<Map16SwitchKind, SwitchButtonImages>>
  /** Why a kind has no button picture. */
  buttonUnavailable: Partial<Record<Map16SwitchKind, string>> | undefined
}

export interface Map16TileEditorProps {
  sheet: Map16SheetDto
  tile: Map16TileDto
  quadrant: Map16QuadrantKey
  /** How many frames to draw: 1 for a tile that does not animate, the
   * cartridge's own frame count for one that does - see `tileFrameCount`. */
  frameCount: number
  /** `committed`, unless an edit of that exact field is still in flight. */
  display<T extends number | boolean>(
    quadrant: Map16QuadrantKey,
    field: Map16Field,
    committed: T,
  ): T
  onSelectQuadrant(quadrant: Map16QuadrantKey): void
  onToggle(field: Map16Field, value: boolean): void
  onColorRow(row: number): void
  quadrantCanvasRef(frame: number, quadrant: Map16QuadrantKey, el: HTMLCanvasElement | null): void
  playingFrame: number | undefined
  editError: string | undefined
}

export function paintTilePreview(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray): void {
  paintScaled(canvas, pixels, TILE_PX, TILE_PX, PREVIEW_SCALE)
}

export function paintFrameQuadrant(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray): void {
  paintScaled(canvas, pixels, CHAR_PX, CHAR_PX, FRAME_QUADRANT_SCALE)
}

/**
 * The tile as the view opens on it, with the hover affordance over it.
 *
 * The overlay is absolutely positioned and the button lives inside it, so
 * the pointer arriving changes opacity and nothing else. A control that
 * appeared in flow would push everything below it down by its own height
 * every time the pointer crossed the preview.
 */
export function renderTilePreview(props: Map16TilePreviewProps): React.ReactNode {
  const label = props.editing ? 'Stop editing this tile' : 'Edit this tile'
  return (
    <div className="hb-map16-preview-wrap">
      <div className="hb-map16-preview-row">
        <div className="hb-map16-preview">
          <canvas className="hb-map16-preview-canvas" ref={props.previewCanvasRef} />
          <div className="hb-map16-preview-overlay" style={{ background: HOVER_DIM }}>
            <button
              type="button"
              data-control="edit-toggle"
              className={
                'hb-map16-preview-edit' + (props.editing ? ' hb-map16-preview-edit-on' : '')
              }
              aria-pressed={props.editing}
              title={label}
              aria-label={label}
              onClick={props.onToggleEdit}
            >
              <span className="codicon codicon-edit" />
            </button>
          </div>
        </div>
        {renderSwitchToggles(props)}
      </div>
      <div className="hb-map16-preview-caption">
        <span className="hb-map16-editor-tile-id">{`Tile ${formatCharNum(props.tile.id)}`}</span>
        <span className="hb-map16-addr">{formatRomAddr(props.tile.romAddr)}</span>
      </div>
    </div>
  )
}

/**
 * One toggle per switch this tile's chars follow (#574), beside the preview so
 * it shows without scrolling; absent for a tile no switch affects. The sheet's
 * reason shows once alongside resolved toggles, the tile's own when none resolved.
 */
function renderSwitchToggles(props: Map16TilePreviewProps): React.ReactNode {
  const switches = toggleKinds(props.tile.alternates)
  const on = activeFor(props.tile.alternates, props.activeSwitches)
  const note = switches.length === 0 ? props.tile.switchesUnavailable : props.switchUnavailable
  if (switches.length === 0 && !note) return null

  return (
    <div className="hb-map16-switches" role="group" aria-label="Switch states">
      {switches.map(kind => {
        const pressed = on.includes(kind)
        const images = props.buttonImages[kind]
        return (
          <SwitchToggle
            key={kind}
            kind={kind}
            images={images}
            pressed={pressed}
            reason={props.buttonUnavailable?.[kind]}
            scale={SWITCH_BUTTON_SCALE}
            data={{ control: 'switch-toggle', switch: kind }}
            onClick={() => props.onToggleSwitch(kind)}
          />
        )
      })}
      {note && (
        <div className="hb-map16-switch-note" data-note="switch-unavailable">
          {`Switch states are unavailable: ${note}`}
        </div>
      )}
    </div>
  )
}

/**
 * The color-row picker: real swatch strips built from the CGRAM the sheet
 * was composited with, not from the ROM tables it came from.
 *
 * Only rows the sheet's characters actually cite are offered, and only the
 * indices the selected character's own sheet can produce (`swatchCountFor`).
 * Offering an unreachable choice invites an edit that renders wrong.
 */
function renderColorRowPicker(
  props: Map16TileEditorProps,
  selectedRow: number,
  charNum: number,
): React.ReactNode {
  const { sheet } = props
  const swatchCount = swatchCountFor(sheet.charSheets, charNum)
  return (
    <div className="hb-map16-rowpick" role="radiogroup" aria-label="Color row">
      {sheet.cgramRows.map(row => (
        <button
          key={row.row}
          type="button"
          role="radio"
          className={
            'hb-map16-rowpick-row' + (row.row === selectedRow ? ' hb-map16-rowpick-row-on' : '')
          }
          data-row={row.row}
          aria-checked={row.row === selectedRow}
          aria-label={`Color row ${row.row}`}
          title={`CGRAM row ${row.row}`}
          onClick={() => props.onColorRow(row.row)}
        >
          <span className="hb-map16-rowpick-label">{`Row ${row.row}`}</span>
          <span className="hb-map16-rowpick-strip">
            {row.colors.slice(0, swatchCount).map((color, i) => (
              <span
                key={i}
                className="hb-map16-swatch"
                style={{ background: color }}
                title={`${i}: ${color}`}
              />
            ))}
          </span>
        </button>
      ))}
    </div>
  )
}

/** One frame: the tile as four quadrant canvases, each its own hit box, so
 * a quadrant can be selected by clicking it on any frame. */
function renderFrame(props: Map16TileEditorProps, frame: number): React.ReactNode {
  return (
    <div
      key={frame}
      className={'hb-map16-frame' + (props.playingFrame === frame ? ' hb-map16-frame-current' : '')}
      data-frame={frame}
    >
      <div className="hb-map16-quads">
        {QUADRANTS.map(q => (
          <div
            key={q.key}
            className={'hb-map16-quad' + (q.key === props.quadrant ? ' hb-map16-quad-on' : '')}
            data-quadrant={q.key}
            role="button"
            tabIndex={0}
            aria-pressed={q.key === props.quadrant}
            aria-label={q.label}
            title={`${q.label}: character ${formatCharNum(props.tile[q.key].charNum)}`}
            onClick={() => props.onSelectQuadrant(q.key)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') props.onSelectQuadrant(q.key)
            }}
          >
            <canvas
              className="hb-map16-quad-canvas"
              ref={el => props.quadrantCanvasRef(frame, q.key, el)}
            />
          </div>
        ))}
      </div>
      <span className="hb-map16-frame-label">{frame}</span>
    </div>
  )
}

/**
 * The read-only half of the selection: what this quadrant IS, for the
 * values that have no visual equivalent.
 *
 * The character number, its source sheet and the ROM address, and nothing
 * else. "Recognition comes from the picture, verification from the number"
 * earns its keep for the CHARACTER: you cannot look at an 8x8 picture and
 * know it is `$19A`, and that number is what makes a rendering bug
 * reportable. Flips, priority and the color row are not like that - a
 * pressed toggle IS the verification, and a highlighted swatch strip IS the
 * value, so printing "Flip X on" beside a visibly-on button verifies
 * nothing.
 */
function renderQuadrantFacts(props: Map16TileEditorProps, charNum: number): React.ReactNode {
  return (
    <>
      <div className="hb-map16-field-row">
        <span className="hb-map16-field-label">Character</span>
        <span className="hb-map16-char-number">{formatCharNum(charNum)}</span>
        <span className="hb-map16-char-source">
          {charSourceLabel(props.sheet.charSheets, charNum)}
        </span>
      </div>
      <div className="hb-map16-addr-line">{formatRomAddr(props.tile[props.quadrant].romAddr)}</div>
    </>
  )
}

export function renderTileEditor(props: Map16TileEditorProps): React.ReactNode {
  const { sheet, tile, quadrant } = props
  const quad = tile[quadrant]
  const charNum = props.display(quadrant, 'charNum', quad.charNum)
  const colorRow = props.display(quadrant, 'colorRow', quad.colorRow)

  return (
    <div className="hb-map16-editor">
      <div className="hb-map16-editor-main">
        <div className="hb-map16-frames-block">
          <div className="hb-map16-frames">
            {Array.from({ length: props.frameCount }, (_, i) => renderFrame(props, i))}
          </div>
          <div className="hb-map16-frames-note">
            {props.frameCount > 1
              ? `${props.frameCount} frames, as the ROM draws them. Editing a quadrant edits every frame of it.`
              : 'One frame: nothing this tile cites animates.'}
          </div>
        </div>

        <div className="hb-map16-quad-fields">
          <div className="hb-map16-quad-name">{QUADRANTS.find(q => q.key === quadrant)?.label}</div>
          {renderQuadrantFacts(props, charNum)}

          <div className="hb-map16-field-row hb-map16-toggles">
            {TOGGLES.map(t => {
              const on = props.display(
                quadrant,
                t.field,
                tile[quadrant][t.field as 'flipX' | 'flipY' | 'priority'],
              )
              return (
                <button
                  key={t.field}
                  type="button"
                  className={'hb-map16-toggle' + (on ? ' hb-map16-toggle-on' : '')}
                  aria-pressed={on}
                  aria-label={t.label}
                  title={t.title}
                  onClick={() => props.onToggle(t.field, !on)}
                >
                  {t.label}
                </button>
              )
            })}
          </div>

          <div className="hb-map16-field-label hb-map16-rowpick-heading">Color row</div>
          {renderColorRowPicker(props, colorRow, charNum)}
        </div>
      </div>

      {props.editError && <div className="hb-map16-editor-error">{props.editError}</div>}

      <div className="hb-map16-editor-note">
        {/* Per TILE, not per layer: 326 of 512 FG ids sit in the shared
            Map16Common run and are byte-identical across all 15 tilesets.
            Saying "other tilesets keep their own bytes" for those was
            confidently wrong about a destructive edit. See Map16TileDto.shared. */}
        {sheet.layer === 'bg'
          ? 'Editing the global Layer 2 table; every level that reads this tile sees the change.'
          : tile.shared
            ? 'This tile is shared by all 15 tilesets; the edit changes it for every one of them.'
            : `This tile is tileset ${sheet.tileset}'s own copy; other tilesets keep their own bytes.`}
      </div>
    </div>
  )
}
