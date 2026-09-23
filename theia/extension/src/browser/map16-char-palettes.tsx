/**
 * The character palettes: the four GFX sheets the selected tileset has
 * loaded into BG character space, as an accordion, every character a click
 * target.
 *
 * Four, never fifty. A quadrant can only say "character N"; it cannot say
 * "file X, tile Y". The character space is VRAM, which the TILESET
 * assembles (fg1/fg2/fg3/an1, chars $000-$1FF), so a palette offering every
 * GFX file would let the user pick a character this tileset has not loaded,
 * which would render as whatever actually sits at that VRAM address. See
 * Map16CharSheetDto.
 *
 * Assignment is SELECT-THEN-CLICK, which is not merely simpler than the
 * drag it replaces: with no drop target, a character number can only come
 * from clicking a rendered character in a loaded sheet, so an out-of-range
 * one is unreachable rather than validated against.
 *
 * Painting and markup live together here because they read the same bytes:
 * one canvas per sheet paints all its characters at once, and a grid of
 * transparent handles over it gives each character its own hit box and
 * accessible name without one canvas context per character.
 */
import * as React from '@theia/core/shared/react'
import { Map16CharSheetDto, Map16CharSlot } from '../common/map16-protocol'
import { CHAR_PX, compositeIndices, decodeBase64Bytes, paintScaled } from './map16-pixels'
import { formatCharNum } from './map16-view-model'

/** Characters per row inside one palette section. */
export const CHARS_PER_ROW = 8
/** 4x, so an 8x8 character is a 32px cell: a comfortable click target. */
export const CHAR_SCALE = 4
/**
 * One cell's side in CSS pixels. Everything that has to line up with the
 * painted canvas is sized from THIS, inline, rather than from a matching
 * number written out again in the stylesheet: the two used to be spelled
 * separately and nothing could have caught them drifting apart.
 */
export const CELL_PX = CHAR_PX * CHAR_SCALE

export interface Map16CharPalettesProps {
  sheets: readonly Map16CharSheetDto[]
  /** Which sections are open. Painting only happens for these. */
  expanded: ReadonlySet<Map16CharSlot>
  /** The selected quadrant's current character, marked in place so the user
   * can see what they are about to replace. */
  currentChar: number | undefined
  onToggleSheet(slot: Map16CharSlot): void
  onPickChar(charNum: number): void
  /** One canvas per OPEN section. `paintCharSheet` fills it with the colors
   * of the selected quadrant's row, so a row change recolors with no round
   * trip and it stays plain that a click carries only a character number. */
  canvasRef(slot: Map16CharSlot, el: HTMLCanvasElement | null): void
}

/**
 * Paints every character of `sheet` into one canvas, `CHARS_PER_ROW` per
 * row, at natural resolution; the bitmap and the CSS size agree because
 * both come from `CELL_PX`.
 *
 * The sheet is always the cartridge's frame 0. An animated slot is NOT
 * advanced here even while the tile preview is playing: a click target that
 * changes four times a second is not a click target.
 */
export function paintCharSheet(
  canvas: HTMLCanvasElement,
  sheet: Map16CharSheetDto,
  colors: readonly string[],
): void {
  const rows = Math.ceil(sheet.charCount / CHARS_PER_ROW)
  const width = CHARS_PER_ROW * CHAR_PX
  const height = rows * CHAR_PX
  const indices = decodeBase64Bytes(sheet.indicesBase64)
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let c = 0; c < sheet.charCount; c++) {
    const charPixels = compositeIndices(indices, c * CHAR_PX * CHAR_PX, CHAR_PX * CHAR_PX, colors)
    const x0 = (c % CHARS_PER_ROW) * CHAR_PX
    const y0 = Math.floor(c / CHARS_PER_ROW) * CHAR_PX
    for (let y = 0; y < CHAR_PX; y++) {
      const dst = ((y0 + y) * width + x0) * 4
      rgba.set(charPixels.subarray(y * CHAR_PX * 4, (y + 1) * CHAR_PX * 4), dst)
    }
  }
  paintScaled(canvas, rgba, width, height, CHAR_SCALE)
  // paintScaled sizes the bitmap; CSS keeps it at the same size so the
  // handles laid over it line up character for character.
  canvas.style.width = `${CHARS_PER_ROW * CELL_PX}px`
  canvas.style.height = `${rows * CELL_PX}px`
}

function renderHandles(props: Map16CharPalettesProps, sheet: Map16CharSheetDto): React.ReactNode[] {
  const handles: React.ReactNode[] = []
  for (let c = 0; c < sheet.charCount; c++) {
    const charNum = sheet.charBase + c
    handles.push(
      <button
        key={charNum}
        type="button"
        className={
          'hb-map16-char' + (charNum === props.currentChar ? ' hb-map16-char-current' : '')
        }
        data-char={charNum}
        title={`Character ${formatCharNum(charNum)} - ${sheet.slot} - ${sheet.fileLabel}`}
        aria-label={`Character ${formatCharNum(charNum)}`}
        onClick={() => props.onPickChar(charNum)}
      />,
    )
  }
  return handles
}

function renderSection(props: Map16CharPalettesProps, sheet: Map16CharSheetDto): React.ReactNode {
  const open = props.expanded.has(sheet.slot)
  const rows = Math.ceil(sheet.charCount / CHARS_PER_ROW)
  return (
    <section className="hb-map16-sheet" key={sheet.slot} data-slot={sheet.slot}>
      <button
        type="button"
        data-control="sheet-head"
        className="hb-map16-sheet-head"
        aria-expanded={open}
        title={
          sheet.animated
            ? `${sheet.slot} holds ${sheet.fileLabel}, whose characters this tileset animates. Shown at frame 0.`
            : `${sheet.slot} holds ${sheet.fileLabel}`
        }
        onClick={() => props.onToggleSheet(sheet.slot)}
      >
        <span className={`codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} />
        <span className="hb-map16-sheet-slot">{sheet.slot}</span>
        <span className="hb-map16-sheet-file">{sheet.fileLabel}</span>
        {sheet.animated && <span className="hb-map16-sheet-anim">animated</span>}
      </button>
      {open && sheet.unavailable && (
        <div className="hb-map16-sheet-unavailable">{sheet.unavailable}</div>
      )}
      {open && !sheet.unavailable && (
        <div
          className="hb-map16-sheet-grid"
          style={{ width: `${CHARS_PER_ROW * CELL_PX}px`, height: `${rows * CELL_PX}px` }}
        >
          <canvas className="hb-map16-sheet-canvas" ref={el => props.canvasRef(sheet.slot, el)} />
          <div
            className="hb-map16-sheet-handles"
            style={{
              gridTemplateColumns: `repeat(${CHARS_PER_ROW}, ${CELL_PX}px)`,
              gridAutoRows: `${CELL_PX}px`,
            }}
          >
            {renderHandles(props, sheet)}
          </div>
        </div>
      )}
    </section>
  )
}

export function renderCharPalettes(props: Map16CharPalettesProps): React.ReactNode {
  if (props.sheets.length === 0) {
    return (
      <div className="hb-map16-palettes hb-map16-palettes-empty">
        This tileset has no character sheets loaded, so there is nothing to choose from.
      </div>
    )
  }
  return (
    <div className="hb-map16-palettes">
      <div className="hb-map16-palettes-hint">
        Click a character to put it in the selected quadrant. Only the character changes.
      </div>
      {props.sheets.map(sheet => renderSection(props, sheet))}
      <div className="hb-map16-palettes-foot">
        These are the four sheets this tileset loads into character space. A character outside them
        cannot be named by a Map16 quadrant.
      </div>
    </div>
  )
}
