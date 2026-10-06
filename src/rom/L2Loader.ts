/**
 * L2Loader - faithful port of CODE_05801E (bank_05.asm lines 20-74) for the
 * Layer 2 preset-background path. Object-stream L2 (bank != $FF) is NOT
 * handled here; that requires the standard object dispatcher targeting a
 * Map16-page-2/3 backing store, which is a separate concern.
 *
 * ── How preset-BG L2 works in SMW ─────────────────────────────────────────
 *
 * 1. The L2 pointer table at $05E600 stores a 3-byte entry per level:
 *      lo, hi, bank
 *    If `bank == $FF`, the level uses a preset background and the lo/hi form
 *    a 16-bit address in bank $0C - not $FF. (The game sets
 *    `Layer2DataPtr+2 = $0C` after detecting the $FF sentinel.)
 *
 * 2. A page selector is derived purely from the address threshold:
 *      page = (lowWord >= $CE8FE) ? 1 : 0
 *    This is stamped into every high-byte slot of Layer2Tilemap. Combined
 *    with each decompressed low byte, it forms a full Map16 tile ID:
 *      map16Id = (page << 8) | lowByte
 *    and indexes into Map16BGTiles ($0D9100) via the L2 pointer table set up
 *    by the tail of CODE_058126 (ported as `loadAllMap16BG`).
 *
 * 3. The compressed data is decoded by CODE_058126 (LC_RLE1) into a flat byte
 *    stream. The game's Layer2TilemapLow buffer is 1024 bytes - a 32×32 tile
 *    grid. Shorter streams leave the trailing bytes at $25 (the value written
 *    during pre-init).
 */

import { RomFile } from './RomFile'
import { decompressRle1 } from './LcRle1'
import { parseL2Objects, SCREEN_W, SCREEN_H, type LevelSprite } from './LevelParser'
import { expandObject, createGrid, SWITCH_FLAGS_UNCLEARED } from './ObjectExpander'
import { OWNER_NONE } from './objectHandlers/cursor'
import { findSecondaryEntranceForLevel } from './L3Loader'

/** L2 pointer table base. 3 bytes per level: lo, hi, bank. */
export const L2_POINTER_TABLE = 0x05e600

/** Page-selector threshold from CODE_05801E line 38. */
export const L2_PAGE_THRESHOLD = 0xe8fe

/** BG data bank set by CODE_05801E line 48 after the $FF sentinel check. */
export const L2_BG_BANK = 0x0c

/**
 * Preset tilemap dimensions.
 *
 * The decompressed stream is stored **screen-major**: two 16×27 blocks (432
 * bytes each) laid out back-to-back, representing the left and right halves
 * of the full 32×27 BG pattern. Byte offset for screen `s` (0=left, 1=right),
 * local column `c` in [0..15], row `r` in [0..26]:
 *
 *   offset = s * 432 + r * 16 + c
 *
 * Streams shorter than 864 bytes leave trailing cells at the $25 pre-init
 * value (CODE_05801E line 25 fills Layer2TilemapLow with $25 before the
 * decompressor runs).
 *
 * Row-major `width * row + col` interpretation (hypothesis A) would shuffle
 * hill tiles across unrelated rows, producing an incoherent BG; empirically
 * verified by dumping rows of level 105's $CD900 preset and seeing coherent
 * sky-to-ground structure only under the screen-major interpretation.
 */
export const L2_PRESET_SCREEN_COLS = 16
export const L2_PRESET_SCREEN_ROWS = 27
export const L2_PRESET_SCREEN_BYTES = L2_PRESET_SCREEN_COLS * L2_PRESET_SCREEN_ROWS // 432
/** Full tiled pattern - two side-by-side screens. */
export const L2_TILEMAP_COLS = L2_PRESET_SCREEN_COLS * 2 // 32
export const L2_TILEMAP_ROWS = L2_PRESET_SCREEN_ROWS // 27
export const L2_TILEMAP_SIZE = L2_PRESET_SCREEN_BYTES * 2 // 864

/**
 * BG2 PPU sub-tilemap height in tiles. Layer2TilemapLow is a 1024-byte buffer
 * (32×32 tiles); only the first 864 bytes hold preset data - the bottom 5 rows
 * stay at the $25 init fill (CODE_05801E lines 24-30). For vertical levels the
 * BG scrolls vertically and the PPU wraps the sub-tilemap every 32 rows, so
 * the tiled pattern repeats with a 5-row $25 strip between iterations. Lunar
 * Magic draws the same strip as solid back-area color.
 */
export const L2_BG_PLANE_ROWS = 32

/** Default empty-tile byte written by CODE_05801E init loop (line 25). */
export const L2_EMPTY_TILE = 0x25

export interface L2PresetLoad {
  /** Raw 3-byte L2 pointer (bank<<16 | hi<<8 | lo) read from the table. */
  rawPtr: number
  /** SNES address of the compressed BG data in bank $0C. */
  dataAddr: number
  /** Page selector (0 or 1) derived from the address threshold. */
  page: number
  /** 32×32 grid of full Map16 tile IDs: `(page << 8) | lowByte`. */
  grid: number[][]
}

/**
 * Read the raw 3-byte L2 pointer for a level.
 * Returns null if the ROM read fails.
 */
export function readL2Pointer(rom: RomFile, level: number): number | null {
  const base = L2_POINTER_TABLE + level * 3
  const lo = rom.readByte(base)
  const hi = rom.readByte(base + 1)
  const bk = rom.readByte(base + 2)
  if (lo === null || hi === null || bk === null) return null
  return (bk << 16) | (hi << 8) | lo
}

/** True if the L2 pointer indicates a preset BG (bank byte $FF). */
export function isPresetPtr(ptr: number): boolean {
  return ((ptr >> 16) & 0xff) === 0xff
}

/**
 * Load a preset BG from its pointer. Accepts the raw 3-byte pointer value so
 * the UI can override the level's default and render any preset on demand.
 *
 * Mirrors CODE_05801E preset-BG path: decompresses LC_RLE1 data from bank
 * $0C, derives the page selector from the source-address threshold, and
 * stamps a 32×32 tile grid. Returns null if `ptr` isn't a preset (bank != $FF).
 */
export function loadL2Preset(rom: RomFile, ptr: number): L2PresetLoad | null {
  if (!isPresetPtr(ptr)) return null

  const lowWord = ptr & 0xffff
  const page = lowWord >= L2_PAGE_THRESHOLD ? 1 : 0
  const dataAddr = (L2_BG_BANK << 16) | lowWord

  // Max L2 preset stream length we'll read; LC_RLE1 stops at $FF $FF so a
  // generous cap is fine. Vanilla streams decompress to ≤ 1024 bytes.
  const raw = rom.readAt(dataAddr, 0x2000)
  if (!raw) return null

  const bytes = decompressRle1(raw)

  // Build the 32×27 grid. ASM pre-initializes Layer2TilemapLow to $25 and
  // the decompressor writes on top; cells past the stream stay $25. Stream
  // layout: bytes [0..431] are the left 16×27 screen row-major, [432..863]
  // are the right 16×27 screen row-major.
  const grid: number[][] = Array.from({ length: L2_TILEMAP_ROWS }, () =>
    new Array<number>(L2_TILEMAP_COLS).fill((page << 8) | L2_EMPTY_TILE),
  )
  for (let s = 0; s < 2; s++) {
    for (let r = 0; r < L2_PRESET_SCREEN_ROWS; r++) {
      for (let c = 0; c < L2_PRESET_SCREEN_COLS; c++) {
        const i = s * L2_PRESET_SCREEN_BYTES + r * L2_PRESET_SCREEN_COLS + c
        if (i >= bytes.length) break
        grid[r][s * L2_PRESET_SCREEN_COLS + c] = (page << 8) | bytes[i]
      }
    }
  }

  return { rawPtr: ptr, dataAddr, page, grid }
}

/**
 * Tileset(s) where SMW's L2 strip uploader OR's `$1000` (= palette bit 2)
 * into every L2 subtile attribute. The check sits inline in the routine -
 * `LDA.W ObjectTileset / CMP.B #$03` at bank_05.asm:1387-1391 + 1503-1507 -
 * with no pointer table, so this is the entire set: tileset 3 only.
 *
 * The OR mask itself in tilemap-entry coords is `$1000` = bit 12 = palette
 * index += 4 (the 3-bit palette field lives at bits 10-12 of a tilemap word).
 * Expressed against our 0..7 `SubTile.palette` field, the mask is simply `4`.
 */
const L2_TILESET3_PALETTE_OR = 4

/** Returns the value OR'd with each L2 subtile's palette for this tileset. */
export function l2PaletteOrForTileset(objectTileset: number): number {
  return objectTileset === 3 ? L2_TILESET3_PALETTE_OR : 0
}

/**
 * The 32x27 preset pattern repeated over a map's footprint: horizontally by
 * column, vertically by the 32-row BG2 plane, whose last 5 rows stay empty
 * (null). Every byte draws, the $25 pre-init filler included: the upload loop
 * (CODE_058D7A, bank_05.asm:1680-1705) indexes Map16BGTiles with it
 * unconditionally and Map16BGTiles[$025] is a visible tile.
 */
export function tilePresetGrid(
  preset: Pick<L2PresetLoad, 'grid'>,
  cols: number,
  rows: number,
): (number | null)[][] {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const rr = r % L2_BG_PLANE_ROWS
      return rr >= L2_TILEMAP_ROWS ? null : preset.grid[rr]![c % L2_TILEMAP_COLS]!
    }),
  )
}

/**
 * Load an object-stream L2 tilemap (bank != $FF).
 *
 * Mirrors LoadLevel (bank_05.asm line 424) for `LayerProcessing == 1`:
 *   - The game COPIES Layer2DataPtr + 5 into Layer1DataPtr and JMPs back into
 *     LoadAgain, which is the object-expansion loop. The +5 skips L2's own
 *     5-byte header bytes - the game never parses L2's header.
 *   - Object dispatch uses L1's ObjectTileset and L1's LevelScrLength. That's
 *     the screen count and tileset we pass in here.
 *   - The object stream writes Map16 IDs against the *regular* Map16 pointer
 *     table (not Map16BGTiles) - so the rendered tile IDs are L1-atlas
 *     compatible.
 *
 * We still call parseLevelObjects on the raw L2 bytes because it reads a
 * 5-byte "header" then an object stream - the same layout L2 data has. We
 * discard the parsed header and use only `.objects`.
 */
export function loadL2Objects(
  rom: RomFile,
  ptr: number,
  screens: number,
  objectTileset: number,
  isVertical = false,
): { grid: number[][] } | null {
  if (isPresetPtr(ptr)) return null

  const snesAddr = ptr & 0xffffff
  // Read a generous window - real L2 streams terminate with $FF.
  const raw = rom.readAt(snesAddr, 0x2000)
  if (!raw) return null

  // parseL2Objects skips the same 5-byte preamble the game does
  // (bank_05.asm:462-470 copies Layer2DataPtr+5 into Layer1DataPtr before
  // re-running LoadLevelData with LayerProcessing=1). The vertical flag
  // mirrors L1's - in vanilla SMW, L2 verticality tracks L1 closely.
  const objects = parseL2Objects(raw, screens, isVertical)
  const grid = createGrid(screens, isVertical)
  for (const obj of objects) {
    // L2 draws from the ports
    expandObject(
      grid,
      obj,
      rom,
      objectTileset,
      null,
      OWNER_NONE,
      SWITCH_FLAGS_UNCLEARED,
      null,
      isVertical,
    )
  }
  return { grid }
}

// Re-export for callers that want the canonical grid dimensions without
// reaching into LevelParser directly.
export { SCREEN_W as L1_SCREEN_W, SCREEN_H as L1_SCREEN_H }

// ── Initial Layer2YPos (BG2VOFS) ──────────────────────────────────────────────

/**
 * SNES address of DATA_05F400 - per-level Layer1/Layer2 startup Y-index byte.
 * - Bits 1:0 index DATA_05D70C for primary-entrance Layer2YPos init.
 * - Bits 3:2 index DATA_05D708 for primary-entrance Layer1YPos init (L1 path).
 * Confirmed at bank_05.asm:7323-7328.
 */
const DATA_05F400_ADDR = 0x05f400

/**
 * SNES address of DATA_05FA00 - secondary-entrance settings byte.
 * - Bits 7:6 index DATA_05D70C for secondary-entrance Layer2YPos init
 *   (bank_05.asm:7137-7146 - top 2 bits, distinct from L1's bits 5:4).
 */
const DATA_05FA00_ADDR = 0x05fa00

/**
 * SNES address of DATA_05F600 - first level-data byte per level. For vertical
 * levels, low 5 bits hold the high byte of the initial Y position used for
 * both Layer1YPos+1 and Layer2YPos+1 (bank_05.asm:7386-7393).
 */
const DATA_05F600_ADDR = 0x05f600
/** DATA_05F000 (per-level settings, high nibble indexes DATA_05D710) and DATA_05D710 (VertLayer2Setting). */
const DATA_05F000_ADDR = 0x05f000
const DATA_05D710_ADDR = 0x05d710

/**
 * SNES address of DATA_05D70C - initial Layer2YPos low-byte table.
 * Verified contents: $60, $90, $C0, $00 (bank_05.asm:7035-7036).
 */
const DATA_05D70C_ADDR = 0x05d70c

/**
 * Read the initial `Layer2YPos` (BG2VOFS) byte for a level, picking the
 * primary entrance for main levels ($000-$0FF) and the secondary entrance
 * that targets the level for sublevels ($100-$1FF).
 *
 * Primary path (bank_05.asm:7323-7328):
 *   Layer2YPos = DATA_05D70C[DATA_05F400[level] & $03]
 *
 * Secondary path (bank_05.asm:7137-7146; reached via pipe/door entrance):
 *   Layer2YPos = DATA_05D70C[(DATA_05FA00[entranceId] >> 6) & $03]
 *
 * Vertical levels (bank_05.asm:7386-7393): same low byte, plus the high byte
 *   from `DATA_05F600[level] & $1F` written to Layer2YPos+1 (only when
 *   VertLayer2Setting != 3 at runtime; the helper combines unconditionally
 *   for symmetry with `readInitialLayer1YPos`).
 *
 * Bit positions differ from the L1 sibling: L2 uses bits 1:0 of F400 / bits
 * 7:6 of FA00, where L1 uses bits 3:2 / bits 5:4 of the same bytes.
 */
export function readInitialLayer2YPos(rom: RomFile, levelId: number, isVertical = false): number {
  let loByte: number
  if (levelId >= 0x100) {
    const entrance = findSecondaryEntranceForLevel(rom, levelId)
    if (entrance !== null) {
      const faByte = rom.readByte(DATA_05FA00_ADDR + entrance) ?? 0
      const idx = (faByte >> 6) & 0x03
      loByte = rom.readByte(DATA_05D70C_ADDR + idx) ?? 0
    } else {
      // Primary fallback for sublevels with no targeting entrance - same path
      // as the standard primary load. Mirrors readInitialLayer1YPos's fallback
      // at L3Loader.ts:260-266.
      const settings = rom.readByte(DATA_05F400_ADDR + levelId) ?? 0
      const idx = settings & 0x03
      loByte = rom.readByte(DATA_05D70C_ADDR + idx) ?? 0
    }
  } else {
    const settings = rom.readByte(DATA_05F400_ADDR + levelId) ?? 0
    const idx = settings & 0x03
    loByte = rom.readByte(DATA_05D70C_ADDR + idx) ?? 0
  }

  if (!isVertical) return loByte
  // The game writes Layer2YPos+1 only when VertLayer2Setting != 3 (bank_05.asm:7390-7393);
  // that setting is DATA_05D710[DATA_05F000[level] >> 4] (bank_05.asm:7270-7278).
  const setting = rom.readByte(DATA_05D710_ADDR + ((rom.readByte(DATA_05F000_ADDR + levelId) ?? 0) >> 4)) ?? 0 // prettier-ignore
  if (setting === 3) return loByte
  const hiByte = (rom.readByte(DATA_05F600_ADDR + levelId) ?? 0) & 0x1f
  return (hiByte << 8) | loByte
}

/**
 * Enumerate every unique preset pointer used by any level in the L2 table.
 * Returns them sorted by low-word address so the dropdown has a stable order.
 *
 * Each entry is the full 3-byte packed pointer (bank<<16 | hi<<8 | lo), matching
 * the input shape of `loadL2Preset`. The `levels` field lists which level indices
 * reference each pointer so the UI can label them helpfully.
 */
export function enumerateL2Presets(
  rom: RomFile,
  levelCount = 0x200,
): { ptr: number; levels: number[] }[] {
  const byPtr = new Map<number, number[]>()
  for (let level = 0; level < levelCount; level++) {
    const ptr = readL2Pointer(rom, level)
    if (ptr === null || !isPresetPtr(ptr)) continue
    const list = byPtr.get(ptr)
    if (list) list.push(level)
    else byPtr.set(ptr, [level])
  }
  return [...byPtr.entries()]
    .map(([ptr, levels]) => ({ ptr, levels }))
    .sort((a, b) => (a.ptr & 0xffff) - (b.ptr & 0xffff))
}

// ── Scroll-range derivation (#246) ───────────────────────────────────────────

/**
 * Sprite-id base for scroll-sprite spawn. Sprite ids `>= $E7` in the L1 sprite
 * stream trigger an auto-scroll/sink-rise/etc. setup at level entry: the cmd
 * byte = `spriteId - $E7` is written to **`Layer1ScrollCmd`** at bank_02.asm
 * lines 5290-5300 and dispatched to the L1 setup table at bank_05.asm:4583+.
 *
 * Note: this is the L1 cmd, not the L2 cmd. `Layer2ScrollCmd` is never set
 * during gameplay levels (every CPU write to it lives in bank_0C cutscene/
 * credits code), so the L2 per-frame dispatch at bank_05.asm:4544 never fires.
 * L2 motion in normal gameplay comes from parallax (HorizLayer2Setting /
 * VertLayer2Setting tables) and event-driven sources (screen shake, sink/rise
 * timers set up by L1 cmds like $0E).
 */
export const SCROLL_SPRITE_BASE = 0xe7

/**
 * First scroll sprite in a level's sprite stream, returned as the
 * **Layer1ScrollCmd** dispatch index (`spriteId - $E7`). bank_02.asm:5294
 * short-circuits via `BNE +` once any cmd is set, so the FIRST scroll sprite
 * wins; later ones in the stream are ignored.
 *
 * Returns null when no scroll sprite is present - typical of non-auto-scroll
 * levels.
 */
export function findLevelScrollSprite(sprites: readonly LevelSprite[]): number | null {
  for (const s of sprites) {
    if (s.spriteId >= SCROLL_SPRITE_BASE) {
      return s.spriteId - SCROLL_SPRITE_BASE
    }
  }
  return null
}

/**
 * Same as `findLevelScrollSprite` but returns the raw sprite-stream byte 0
 * alongside the cmd, since `simulateScrollSetup` needs it (the L1 setup
 * routine reads `Layer1ScrollBits = b0 >> 2` from this byte).
 */
export function findLevelScrollSpriteFull(
  sprites: readonly LevelSprite[],
): { spriteId: number; b0: number } | null {
  for (const s of sprites) {
    if (s.spriteId >= SCROLL_SPRITE_BASE) {
      return { spriteId: s.spriteId, b0: s.raw[0] ?? 0 }
    }
  }
  return null
}

/**
 * Per-`Layer2ScrollCmd` motion bounds, read directly from the ROM tables
 * the cmd's per-frame routine compares against. The argument is the
 * **post-setup** Layer2ScrollCmd (computed via `simulateScrollSetup`),
 * NOT the raw scroll-sprite cmd byte - those differ for cmds where the
 * L1 setup routine remaps via 16-bit STA tricks (e.g. L1 cmd $0C → L2
 * cmd $00, no L2 motion).
 *
 * Returns `null` for cmds whose bounds source we haven't decoded yet -
 * caller falls back to `(initialLayer2YPx, initialLayer2YPx)` (no motion).
 *
 * Currently mapped:
 *   - cmd $0B (CODE_05C727 "On/Off Switch controlled"): targets read from
 *     `DATA_05C71B` at `$05C71B`. Two 16-bit `NextLayer2YPos` values the
 *     routine drifts toward. Vanilla: `$0020` and `$00C1`.
 *
 * Other cmds (e.g. $0E sink/rise CODE_05C81C) pending decoding.
 */
const DATA_05C71B_ADDR = 0x05c71b

export function readL2ScrollBounds(
  rom: RomFile,
  layer2ScrollCmd: number | null,
): { min: number; max: number } | null {
  if (layer2ScrollCmd === 0x0b) {
    const a = rom.readByte(DATA_05C71B_ADDR + 0) ?? 0 // target 0 low
    // hi bytes (DATA_05C71B + 1, +3) are zero in vanilla; treating Y as 8-bit
    const b = rom.readByte(DATA_05C71B_ADDR + 2) ?? 0 // target 1 low
    const min = Math.min(a, b)
    const max = Math.max(a, b)
    if (max > min) return { min, max }
  }
  return null
}

export interface L2ScrollRange {
  /**
   * Plane visualization kind. Currently only static rects:
   *   - none:  empty grid (no L2 content to bound).
   *   - fixed: object-stream L2 content. yMin/yMax are the grid extents
   *            shifted by `dy = initialCameraYPx - initialLayer2YPx`.
   *
   * A per-frame Y animation source (screen-shake / cmd-$0E sink-rise /
   * boss-specific routines) would warrant a future `'animated'` kind with
   * captured sweep extremes. Not yet decoded - see issue #246.
   */
  kind: 'none' | 'fixed'
  /** Level pixel rectangle bounds. */
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  /**
   * The cmd byte from `findLevelScrollSprite`, recorded for diagnostic /
   * label purposes. This is **`Layer1ScrollCmd`**, not `Layer2ScrollCmd`.
   */
  layer1ScrollCmd?: number
}

export interface L2ScrollRangeInput {
  /** Object-stream grid (null cells are empty). row-major. */
  grid: readonly (readonly (number | null)[])[]
  initialLayer2YPx: number
  initialCameraYPx: number
  /** Level pixel width (screens × 256). */
  levelPixelW: number
  /** L1 cmd from `findLevelScrollSprite`, or null when no scroll sprite. */
  layer1ScrollCmd: number | null
}

/**
 * First/last grid rows containing any non-null cell. Returns `[-1, -1]` for
 * empty grids. Mirrors `findFirstDataRow` / `findLastDataRow` in L3Loader.
 */
function findGridDataRows(grid: readonly (readonly (number | null)[])[]): [number, number] {
  let first = -1
  let last = -1
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? []
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== null) {
        if (first === -1) first = r
        last = r
        break
      }
    }
  }
  return [first, last]
}

/**
 * Bounding rectangle (level pixels) for the L2 plane the editor should
 * visualize. Mirrors the shape of `computeL3ScrollRange`.
 *
 * Returns `kind: 'fixed'` whenever the grid has any data - gameplay-L2 has
 * no per-frame Y animation we've decoded yet (Layer2ScrollCmd is always 0
 * in vanilla play; cmd-$0E sink-rise needs separate verification). The
 * rect is at `firstRow*16 + dy` to `(lastRow+1)*16 + dy` where `dy =
 * initialCameraYPx - initialLayer2YPx`, matching the L2ObjectStream.render
 * formula.
 */
export function computeL2ScrollRange(input: L2ScrollRangeInput): L2ScrollRange {
  const { grid, initialLayer2YPx, initialCameraYPx, levelPixelW, layer1ScrollCmd } = input

  const [firstRow, lastRow] = findGridDataRows(grid)
  if (firstRow < 0) {
    return { kind: 'none', xMin: 0, xMax: 0, yMin: 0, yMax: 0 }
  }

  const dy = -initialLayer2YPx + initialCameraYPx
  return {
    kind: 'fixed',
    xMin: 0,
    xMax: levelPixelW,
    yMin: firstRow * 16 + dy,
    yMax: (lastRow + 1) * 16 + dy,
    layer1ScrollCmd: layer1ScrollCmd ?? undefined,
  }
}
