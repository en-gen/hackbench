/**
 * The Map16 view's pure decisions, kept out of the .tsx files so they can be
 * unit-tested without React - same split as palette-view-model.ts.
 *
 * Everything here is a function of a DTO the backend already read from the
 * cartridge. Nothing here reads a ROM, and nothing here has a fallback: a
 * character no loaded sheet holds is reported as exactly that.
 */
import {
  Map16CharSheetDto,
  Map16Layer,
  Map16PaletteVariantDto,
  Map16SheetDto,
} from '../common/map16-protocol'

/** Which sheet an edit is written against: the tile table, the graphics and
 * the colors it resolves. */
export interface Map16Axis {
  tileset: number
  layer: Map16Layer
  paletteVariant: Map16PaletteVariantDto
}

/**
 * The axis an edit targets, given the sheet ON SCREEN and what the pickers
 * currently read.
 *
 * It is always the sheet's. `handleTilesetChange` sets the picker
 * synchronously and reloads asynchronously, so for the length of that round
 * trip the character palettes are still drawing the PREVIOUS tileset's
 * characters. Taking the picker's value would resolve the address against
 * the new tileset for a character the user picked out of the old one, and
 * 186 of 512 FG ids resolve outside the shared Map16Common run, so that is
 * a write to a different tile. Same rule `Map16SheetDto` states for
 * display: report what PRODUCED the sheet, never the raw request.
 *
 * `picker` is taken and discarded on purpose. The discard is the whole
 * decision, and a function that never saw the value it must not use could
 * not be tested for using it: `editAxisFor(sheetOfTileset0, { tileset: 3 })`
 * is the race, written down.
 */
export function editAxisFor(sheet: Map16SheetDto, picker: Map16Axis): Map16Axis {
  void picker
  return { tileset: sheet.tileset, layer: sheet.layer, paletteVariant: sheet.paletteVariant }
}

export const MAP16_VIEW_ID = 'hackbench.map16-view'

/**
 * One widget id per layer.
 *
 * WidgetManager keys a widget by factory id PLUS options, so `{ layer }`
 * yields two independent widgets; this is the DOM/shell id that has to
 * differ alongside it, or the two tabs collide on one element id.
 */
export function map16WidgetId(layer: Map16Layer): string {
  return `${MAP16_VIEW_ID}:${layer}`
}

export function formatCharNum(charNum: number): string {
  return `$${charNum.toString(16).toUpperCase().padStart(3, '0')}`
}

/** The character sheet holding `charNum`, or undefined when no loaded sheet does. */
export function charSheetForChar(
  sheets: readonly Map16CharSheetDto[],
  charNum: number,
): Map16CharSheetDto | undefined {
  return sheets.find(s => charNum >= s.charBase && charNum < s.charBase + s.charCount)
}

/**
 * `fg3 - GFX25`, or a plain statement that this tileset has not loaded it.
 *
 * Never a guess at which GFX file a character "probably" comes from: the
 * quadrant names a VRAM address, and only the four loaded sheets say what
 * is at one.
 */
export function charSourceLabel(sheets: readonly Map16CharSheetDto[], charNum: number): string {
  const sheet = charSheetForChar(sheets, charNum)
  return sheet ? `${sheet.slot} - ${sheet.fileLabel}` : 'not loaded by this tileset'
}

/**
 * The CSS colors of one CGRAM row, untrimmed.
 *
 * `row` falls back to the sheet's FIRST CITED row, never to row 0 by
 * assumption: a sheet that cites no row at all yields no colors. Callers
 * trim to what the characters they are painting can actually index - see
 * `swatchCountFor`.
 */
export function rowColorsFor(sheet: Map16SheetDto, row: number | undefined): string[] {
  const found = sheet.cgramRows.find(r => r.row === row) ?? sheet.cgramRows[0]
  return found?.colors ?? []
}

/**
 * How many swatches of a color row a character can actually reach, from the
 * sheet that character comes from - see `Map16CharSheetDto.maxColorIndex`.
 *
 * A character no loaded sheet holds has no per-sheet answer, so the widest
 * any loaded sheet can reach is offered, and the source label beside it
 * already says the character is not loaded. That is a display choice about
 * an already-flagged character, not a fallback for a value read from the
 * cartridge.
 */
export function swatchCountFor(
  sheets: readonly Map16CharSheetDto[],
  charNum: number | undefined,
): number {
  const source = charNum === undefined ? undefined : charSheetForChar(sheets, charNum)
  const max = source
    ? source.maxColorIndex
    : sheets.reduce((m, s) => Math.max(m, s.maxColorIndex), 0)
  return max + 1
}

/**
 * How many frames this tile has: ONE when nothing it cites animates, the
 * cartridge's own frame count when something does.
 *
 * Derived from `animatedTileIds`, which the backend computes by COMPARING
 * the rendered phases, never from a slot name. The earlier design was going
 * to mark `an1` as the animated slot and freeze it; measured across all 15
 * tilesets on all 6 corpus ROMs, animated characters land in `fg1` and
 * `fg2` and never in `an1`, so that would have frozen the wrong thing.
 * Showing the tile's own frames sidesteps the question entirely: the user
 * never has to learn which slot animates.
 */
export function tileFrameCount(sheet: Map16SheetDto, tileId: number): number {
  const anim = sheet.charAnimation
  return anim && anim.animatedTileIds.includes(tileId) ? anim.frameCount : 1
}
