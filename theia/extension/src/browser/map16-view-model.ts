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
  Map16SwitchKind,
  Map16TileAlternateDto,
  Map16TileDto,
} from '../common/map16-protocol'
import { TILE_PX } from './map16-pixels'
import { hiddenPixelStrength, overlayHidden } from '../../../../src/rom/render/HiddenTiles'

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

/** Plain words for a switch kind, per "approachable over powerful" - never
 * the ROM's own RAM-address vocabulary. */
export const SWITCH_LABELS: Record<Map16SwitchKind, string> = {
  blue: 'Blue P-switch',
  silver: 'Silver P-switch',
  onOff: 'ON/OFF switch',
}

/** The order every list of switch kinds is shown in. Combo keys sort by name instead. */
export const SWITCH_ORDER: readonly Map16SwitchKind[] = ['blue', 'silver', 'onOff']

/** A tile's toggles: its single-switch alternates, in SWITCH_ORDER. */
export function toggleKinds(
  alternates: readonly Map16TileAlternateDto[] | undefined,
): Map16SwitchKind[] {
  const singles = new Set((alternates ?? []).flatMap(a => (a.kinds.length === 1 ? a.kinds : [])))
  return SWITCH_ORDER.filter(k => singles.has(k))
}

/** The switches on for this tile: `active` pruned to the tile's own toggles, in SWITCH_ORDER. */
export function activeFor(
  alternates: readonly Map16TileAlternateDto[] | undefined,
  active: ReadonlySet<Map16SwitchKind>,
): Map16SwitchKind[] {
  return toggleKinds(alternates).filter(k => active.has(k))
}

/** A copy of one 16x16 RGBA tile in the screen door; colors are untouched. */
export function screenDoor(tile: Uint8ClampedArray): Uint8ClampedArray {
  const out = tile.slice()
  for (let y = 0; y < TILE_PX; y++)
    for (let x = 0; x < TILE_PX; x++) {
      const a = (y * TILE_PX + x) * 4 + 3
      out[a] = Math.round(tile[a]! * hiddenPixelStrength(x, y))
    }
  return out
}

/**
 * What the preview draws (#574): the alternate matching the tile's own active
 * switches as is, else a hidden tile's first single, flagged `hidden` so it is
 * drawn in the screen door, else undefined for the tile's own picture. When
 * the matching alternate is blank (`isBlank`, e.g. $094 under ON/OFF), the
 * switch blanks the tile: `alt` is undefined and `hidden` set, meaning the
 * tile's own picture in the screen door (`ghostOf`'s rule, both ways).
 */
export function previewAlternate(
  alternates: readonly Map16TileAlternateDto[] | undefined,
  active: ReadonlySet<Map16SwitchKind>,
  isBlank: (alt: Map16TileAlternateDto) => boolean = () => false,
): { alt: Map16TileAlternateDto | undefined; hidden: boolean } | undefined {
  const key = activeFor(alternates, active).sort().join('+')
  const match = key ? alternates?.find(a => a.kinds.join('+') === key) : undefined
  if (match)
    return isBlank(match) ? { alt: undefined, hidden: true } : { alt: match, hidden: false }
  const hidden = alternates?.find(a => a.kinds.length === 1 && a.hidden)
  return hidden && { alt: hidden, hidden: true }
}

const NO_SWITCHES: ReadonlySet<Map16SwitchKind> = new Set()

type BrowsedSheet = Pick<Map16SheetDto, 'width' | 'tilesPerRow'> & {
  tiles: readonly Pick<Map16TileDto, 'id' | 'alternates'>[]
}

/**
 * The sheet as browsed (#621): every hidden tile's switched-on art in the
 * preview's own screen door, in the pixels its cell leaves blank. The same
 * `previewAlternate` the inspector uses with no switch on, so the two never
 * disagree. Returns a copy; the decoded phase other surfaces crop is never written.
 */
export function withHiddenTiles(
  atlas: Uint8ClampedArray,
  sheet: BrowsedSheet,
  decode: (base64: string) => Uint8ClampedArray,
): Uint8ClampedArray {
  let out: Uint8ClampedArray | undefined
  for (const tile of sheet.tiles) {
    const shown = previewAlternate(tile.alternates, NO_SWITCHES)
    if (!shown?.alt) continue
    out ??= atlas.slice()
    const x0 = (tile.id % sheet.tilesPerRow) * TILE_PX
    const y0 = Math.floor(tile.id / sheet.tilesPerRow) * TILE_PX
    overlayHidden(out, sheet.width, x0, y0, decode(shown.alt.altRgbaBase64))
  }
  return out ?? atlas
}

/**
 * Each phase's browsed pixels, cached by the phase's base64. That key alone would
 * go stale: a reload can change `alternates` while the still atlas stays
 * byte-identical, so a new sheet DTO (every reload makes one) starts afresh.
 */
export class BrowsedSheetCache {
  private sheet: BrowsedSheet | undefined
  private readonly phases = new Map<string, Uint8ClampedArray>()

  pixels(
    sheet: BrowsedSheet,
    base64: string,
    decode: (base64: string) => Uint8ClampedArray,
  ): Uint8ClampedArray {
    if (sheet !== this.sheet) {
      this.phases.clear()
      this.sheet = sheet
    }
    let buf = this.phases.get(base64)
    if (!buf) {
      buf = withHiddenTiles(decode(base64), sheet, decode)
      this.phases.set(base64, buf)
    }
    return buf
  }
}
