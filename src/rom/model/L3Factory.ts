import type { RomFile } from '../RomFile'
import {
  L3_TILEMAP_COLS, L3_TILEMAP_ROWS,
  applyInitialTimer, applyStaticStatusBar, loadL3Tilemap,
} from '../L3Loader'
import type { GfxSheet } from '../GfxLoader'
import { L3TilemapLayer, type L3Layer } from './L3Layer'

/**
 * Build the L3 layer for a level.
 *
 * Every level gets an L3Layer so the static status-bar HUD can render in the
 * camera viewport, even when the level has no L3 tide / cage / etc. overlay.
 * For tide/cage levels, the overlay stripe image is parsed and composed on
 * top of the HUD tiles (matching the game's load order).
 *
 * @param rom        ROM file to read from
 * @param levelId    Level number
 * @param tileset    Object tileset index (from level header)
 * @param l3Chars    GFX28–GFX2B decoded sheets from loadL3Chars()
 * @param screens    Number of screens in the level (drives horizontal repeat width)
 * @param isVertical True for vertical levels (16-tile wide × screens*16-tile tall)
 * @param timeLimit  Header byte-3 bits 7:6 — drives the initial timer digits
 */
export function buildL3(
  rom: RomFile,
  levelId: number,
  tileset: number,
  l3Chars: GfxSheet[],
  screens: number,
  isVertical: boolean,
  timeLimit = 0,
): L3Layer | null {
  // Level pixel dims. Horizontal: 27 rows × 16 = 432px tall, screens × 256 wide.
  // Vertical: 32 cols × 16 = 512px wide (L3 rarely used here).
  const levelPixelW = isVertical ? 32 * 16 : screens * 256
  const levelPixelH = isVertical ? screens * 16 * 16 : 27 * 16

  const load = loadL3Tilemap(rom, levelId, tileset, timeLimit)
  if (load) {
    return new L3TilemapLayer(load.tilemap, l3Chars, load.initialYPx, levelPixelW, levelPixelH)
  }

  // No L3 overlay for this level — still create an L3Layer populated with
  // only the static status-bar tiles so the HUD toggle works everywhere.
  // initialYPx = 0xD0 picks the "non-tide" rendering path (full 512px period,
  // no bottom-anchored water positioning). That keeps the HUD-only case
  // indistinguishable from non-tide tilesets like cage bars.
  const hudOnlyTilemap = new Uint16Array(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
  applyStaticStatusBar(rom, hudOnlyTilemap)
  applyInitialTimer(rom, hudOnlyTilemap, timeLimit)
  return new L3TilemapLayer(hudOnlyTilemap, l3Chars, 0xD0, levelPixelW, levelPixelH)
}
