/**
 * Which axis a Map16 edit is written against (`editAxisFor`).
 *
 * `handleTilesetChange` sets the picker synchronously and reloads
 * asynchronously, so for the length of that round trip the character
 * palettes are still drawing the PREVIOUS tileset. An edit that read the
 * picker would resolve the address against the new tileset for a character
 * the user picked out of the old one, and 186 of 512 FG ids resolve outside
 * the shared Map16Common run, so that is a write to a different tile.
 *
 * This used to be a source-text tripwire, on the reasoning that
 * `Map16ViewWidget` extends `ReactWidget` and cannot be constructed in node
 * while the race is too narrow to drive in a browser. Both were true, and
 * both were beside the point: the DECISION is a pure function of the sheet
 * and the picker, so it can simply be extracted and tested. A grep over
 * source text passes when the bug returns under a different spelling and
 * fails on an innocent rename, which is the wrong failure mode twice over.
 */
import { describe, it, expect } from 'vitest'
import { editAxisFor } from '../../../theia/extension/src/browser/map16-view-model'
import type { Map16Layer, Map16SheetDto } from '../../../theia/extension/src/common/map16-protocol'

function sheetFrom(tileset: number, layer: Map16Layer, bg: number, fg: number): Map16SheetDto {
  return {
    cgramRows: [],
    layer,
    tileset,
    paletteVariant: { bg, fg },
    tileCountSource: 'rom',
    citedColorRows: [],
    charSheets: [],
    tilesPerRow: 16,
    width: 256,
    height: 512,
    rgbaBase64: '',
    tiles: [],
    pipeVariantsIgnored: true,
  }
}

describe('editAxisFor', () => {
  it('takes the axis of the sheet on screen when the picker agrees with it', () => {
    const sheet = sheetFrom(5, 'fg', 2, 3)
    expect(
      editAxisFor(sheet, { tileset: 5, layer: 'fg', paletteVariant: { bg: 2, fg: 3 } }),
    ).toEqual({ tileset: 5, layer: 'fg', paletteVariant: { bg: 2, fg: 3 } })
  })

  /**
   * The race, written down: the user changed the tileset picker to 3 and
   * clicked a character before the reload landed, so the sheet they clicked
   * into is still tileset 0's.
   */
  it('takes the SHEET tileset, not the picker, while a reload is in flight', () => {
    const onScreen = sheetFrom(0, 'fg', 0, 0)
    const axis = editAxisFor(onScreen, {
      tileset: 3,
      layer: 'fg',
      paletteVariant: { bg: 0, fg: 0 },
    })
    expect(axis.tileset).toBe(0)
  })

  it('takes the SHEET palette variants, which move on the same round trip', () => {
    const onScreen = sheetFrom(0, 'fg', 0, 0)
    const axis = editAxisFor(onScreen, {
      tileset: 0,
      layer: 'fg',
      paletteVariant: { bg: 7, fg: 4 },
    })
    expect(axis.paletteVariant).toEqual({ bg: 0, fg: 0 })
  })

  it('takes the SHEET layer, so an edit can never cross tables', () => {
    // The layer is fixed for a widget's life, so the two cannot disagree
    // through the UI. Pinned anyway: this is the field that decides which
    // TABLE is written, and the cost of being wrong is an edit to the other
    // one.
    const onScreen = sheetFrom(0, 'bg', 0, 0)
    expect(
      editAxisFor(onScreen, { tileset: 0, layer: 'fg', paletteVariant: { bg: 0, fg: 0 } }).layer,
    ).toBe('bg')
  })

  it('returns every field of the axis, so no caller has to fill one in', () => {
    const axis = editAxisFor(sheetFrom(9, 'bg', 1, 6), {
      tileset: 9,
      layer: 'bg',
      paletteVariant: { bg: 1, fg: 6 },
    })
    expect(Object.keys(axis).sort()).toEqual(['layer', 'paletteVariant', 'tileset'])
  })
})
