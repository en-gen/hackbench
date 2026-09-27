/**
 * Everything a map's L1 (foreground) is drawn from, read from the ROM in
 * ONE place (#421 step 3). The map tab (theia/extension/src/node/map-screen.ts)
 * draws from it and the L1 data gate (tools/scripts/capture_gate.ts
 * `gateMap`) checks it against Mesen, so what the gate proves is what the
 * tab shows, by construction rather than by keeping two copies in step.
 */
import type { SmwRom } from '../SmwRom'
import type { RomFile } from '../RomFile'
import type { RgbaColor } from '../GraphicsDecoder'
import {
  isLevelModeVertical,
  parseLevelHeader,
  parseLevelObjects,
  type LevelHeader,
} from '../LevelParser'
import { expandMap, type SwitchFlags, type TileGrid } from '../ObjectExpander'
import { loadMap16WithPipeVariants, map16TileCapacity, type Map16Tile } from '../Map16'
import { gfxSource, loadVram, type VramState } from '../GfxLoader'
import { loadExAnimData } from '../ExAnimationLoader'
import { frameZeroChars } from '../FrameZero'
import { buildChars } from './chars/CharFactory'
import type { Char } from './chars/Char'
import type { AnimationData } from '../AnimationLoader'
import {
  buildLevelCgram,
  loadBackAreaColors,
  loadCustomLevelPalette,
  loadRomPalettes,
} from '../PaletteLoader'
import { readLevelCol1 } from '../PaletteStockTables'

/** Level modes whose L1 the game never loads: LoadLevel returns before the
 *  object stream for $09, $0B and $10 (bank_05.asm:431-437). */
export const NO_L1_MODES: ReadonlySet<number> = new Set([0x09, 0x0b, 0x10])

export interface L1Inputs {
  header: LevelHeader
  isVertical: boolean
  /** The header's screen count, never the grid's width (a handler may write past it). */
  screenCount: number
  grid: TileGrid
  map16: { tiles: Map16Tile[]; pipeVariants: Map16Tile[][] }
  /** VRAM as the GFX files load it, and the animation (stock plus ExAnimation) over it. */
  rawVram: VramState
  anim: AnimationData | null
  /** Frame 0 of that animation: what a still picture composites from. */
  vram: VramState
  chars: Map<number, Char>
  /** Why the animation frames are unverified or absent, when they are. */
  animNote?: string
  /** CGRAM, 256 colors, with any per-level override block applied. */
  colors: RgbaColor[]
  /** CGRAM color 0, the backdrop the PPU shows where every layer is transparent. */
  backArea: RgbaColor
}

export type L1InputsResult = { ok: true; inputs: L1Inputs } | { ok: false; reason: string }

const hex3 = (n: number) => `$${n.toString(16).toUpperCase().padStart(3, '0')}`

/** A level's CGRAM and backdrop: the header's palettes, or its override block. */
export function levelColors(
  rom: RomFile,
  index: number,
  header: LevelHeader,
  col1: { bg: number; obj: number },
): { colors: RgbaColor[]; backArea: RgbaColor } {
  const custom = loadCustomLevelPalette(rom, index)
  if (custom) return { colors: custom.colors, backArea: custom.backAreaColor }
  const palettes = loadRomPalettes(rom, header.bgPalette)
  const cgram = buildLevelCgram(palettes, header.bgPalette, header.fgPalette, header.spritePalette, col1) // prettier-ignore
  return {
    colors: cgram.colors,
    backArea: loadBackAreaColors(rom)[header.bgColor] ?? [0, 0, 0, 255],
  }
}

/** Read one map's L1 inputs, or why they cannot be read. Never a partial set. */
export function buildL1Inputs(rom: SmwRom, index: number, flags: SwitchFlags): L1InputsResult {
  const refuse = (reason: string): L1InputsResult => ({ ok: false, reason })
  const raw = rom.getLevelRawData(index)
  if (!raw) return refuse(`No readable level data at slot ${hex3(index)}`)
  const table = rom.getVerticalTable()
  if (!table.ok) return refuse(table.reason)
  const header = parseLevelHeader(raw)
  if (NO_L1_MODES.has(header.levelMode)) {
    return refuse(`Map ${hex3(index)} is a boss arena: the game never loads its L1 (foreground)`)
  }
  try {
    const { objects } = parseLevelObjects(raw, table.table)
    const isVertical = isLevelModeVertical(header.levelMode, table.table)
    const tileset = header.objectTileset
    // No levelNum: the Layer 3 overflow screens are not this map's own.
    const grid = expandMap(objects, header.levelLength, rom.rom, tileset, isVertical, header.levelMode, undefined, flags) // prettier-ignore

    const gfx = gfxSource(rom.rom)
    if (!gfx.ok) return refuse(`GFX cannot be read: ${gfx.reason}`)
    const capacity = map16TileCapacity(rom.rom)
    if ('reason' in capacity) return refuse(capacity.reason)
    const col1 = readLevelCol1(rom.rom)
    if ('reason' in col1) return refuse(`Palette column 1 is unavailable: ${col1.reason}`)

    const map16 = loadMap16WithPipeVariants(rom.rom, tileset)
    const rawVram = loadVram(rom.rom, tileset, header.spriteSet)
    const frameZero = frameZeroChars(rom.rom, tileset, rawVram, loadExAnimData(rom.rom, index))
    const vram = frameZero?.vram ?? rawVram
    const chars = frameZero?.animData ? frameZero.chars : buildChars(vram)
    return {
      ok: true,
      inputs: {
        header,
        isVertical,
        screenCount: header.levelLength,
        grid,
        map16,
        rawVram,
        anim: frameZero?.animData ?? null,
        vram,
        chars,
        animNote: frameZero?.error,
        ...levelColors(rom.rom, index, header, col1),
      },
    }
  } catch (err) {
    return refuse(`Map ${hex3(index)} could not be read: ${(err as Error).message}`)
  }
}
