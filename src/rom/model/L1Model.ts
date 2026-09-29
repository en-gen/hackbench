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
import { frameZeroFrom } from '../FrameZero'
import {
  loadAnimationDataOrReason,
  stockAnimationUnreached,
  type AnimationData,
  type LoadAnimationResult,
} from '../AnimationLoader'
import {
  buildLevelCgram,
  loadBackAreaColors,
  loadCustomLevelPalette,
  loadRomPalettes,
  type CustomLevelPalette,
  type RomPalettes,
} from '../PaletteLoader'
import { readLevelCol1 } from '../PaletteStockTables'
import { bgr555ToRgba } from '../GraphicsDecoder'
import { detectPaletteAnimation, type PaletteAnimContext } from '../PaletteAnimationDetect'
import { findUnique, WILD, type BytePattern } from '../BytePattern'
import { switchArtOf, type TileSwitchArt } from '../SwitchAlternates'

/**
 * LoadLevel's boss-mode exit, bank_05.asm:431-437: `LDA.W LevelModeSetting`
 * then three `CMP #imm / BEQ LoadLevelDone`. The immediates are the level
 * modes whose L1 the game never loads ($09, $0B, $10 on a stock ROM).
 */
const NO_L1_CHECK: BytePattern = [0xad, 0x25, 0x19, 0xc9, WILD, 0xf0, WILD, 0xc9, WILD, 0xf0, WILD, 0xc9, WILD, 0xf0, WILD] // prettier-ignore

/**
 * The level modes LoadLevel returns for before reading the object stream,
 * read from its own `CMP` operands. Gated: exactly one match, and all three
 * branches reaching one target, or the answer is unavailable.
 */
export function readNoL1Modes(rom: RomFile): { modes: ReadonlySet<number> } | { reason: string } {
  const unreadable = {
    reason:
      "LoadLevel's boss-mode check (bank_05.asm:431-437) is not the stock shape, so whether the game loads this map's L1 (foreground) cannot be read",
  }
  const at = findUnique(rom, NO_L1_CHECK)
  const bytes = at === null ? null : rom.readAtFileOffset(at, NO_L1_CHECK.length)
  if (!bytes) return unreadable
  const target = (branchAt: number) => branchAt + 2 + ((bytes[branchAt + 1]! << 24) >> 24)
  if (target(5) !== target(9) || target(9) !== target(13)) return unreadable
  return { modes: new Set([bytes[4]!, bytes[8]!, bytes[12]!]) }
}

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
  /** Why the char or palette animation frames, or an object's tiles, are unverified or absent, when they are. */
  animNote?: string
  /** CGRAM, 256 colors: any per-level override block, then the palette animation's representative frame (phase 0). */
  colors: RgbaColor[]
  /** CGRAM color 0, the backdrop the PPU shows where every layer is transparent. */
  backArea: RgbaColor
  /** Each switch-following tile's pictures, from its own chars: what `ghostOf` draws faintly. */
  switchArt: Map<number, TileSwitchArt>
}

export type L1InputsResult = { ok: true; inputs: L1Inputs } | { ok: false; reason: string }

const hex3 = (n: number) => `$${n.toString(16).toUpperCase().padStart(3, '0')}`

/** Everything `assembleL1Inputs` needs, read from the ROM and nothing else. */
export interface L1Readings {
  header: LevelHeader
  isVertical: boolean
  grid: TileGrid
  map16: { tiles: Map16Tile[]; pipeVariants: Map16Tile[][] }
  rawVram: VramState
  stockAnim: LoadAnimationResult
  unreached: { target: number } | { reason: string } | null
  exAnim: AnimationData | null
  custom: CustomLevelPalette | null
  romPalettes: RomPalettes
  backAreas: RgbaColor[]
  col1: { bg: number; obj: number }
  paletteAnim: PaletteAnimContext
  /** Why the expander drew an object from a port the interpreter could not check (#342). */
  unverified?: string[]
}

/** A level's CGRAM and backdrop: its override block, else the header's palettes and back-area color. */
export function levelColorsFrom(
  r: Pick<L1Readings, 'header' | 'custom' | 'romPalettes' | 'backAreas' | 'col1'>,
): { colors: RgbaColor[]; backArea: RgbaColor } {
  if (r.custom) return { colors: r.custom.colors, backArea: r.custom.backAreaColor }
  const { bgPalette, fgPalette, spritePalette, bgColor } = r.header
  const cgram = buildLevelCgram(r.romPalettes, bgPalette, fgPalette, spritePalette, r.col1)
  return { colors: cgram.colors, backArea: r.backAreas[bgColor] ?? [0, 0, 0, 255] }
}

/** `levelColorsFrom` over this ROM's own tables. */
export function levelColors(
  rom: RomFile,
  index: number,
  header: LevelHeader,
  col1: { bg: number; obj: number },
): { colors: RgbaColor[]; backArea: RgbaColor } {
  return levelColorsFrom({
    header,
    col1,
    custom: loadCustomLevelPalette(rom, index),
    romPalettes: loadRomPalettes(rom, header.bgPalette),
    backAreas: loadBackAreaColors(rom),
  })
}

/**
 * The palette at its REPRESENTATIVE frame, phase 0 of the level's palette
 * animation (e.g. `$64`; PaletteAnimationDetect.ts), by the owner's
 * first-frame-by-default convention. Not necessarily the first frame the
 * player sees: CODE_00A5F9 (bank_00.asm:4891-4899) leaves EffFrame so the
 * first shown phase is 2, 4, 6 or 0 by runtime state. The stored color is
 * never shown in-game, which is why a phase replaces it. When the routine
 * cannot be read, the stored colors stand and the note says so.
 */
export function applyPaletteFrame0(
  colors: readonly RgbaColor[],
  level: PaletteAnimContext,
): { colors: RgbaColor[]; note?: string } {
  const out = [...colors]
  if (!level.available) {
    return {
      colors: out,
      note: `Palette animation couldn't be read: ${level.notes.join(' ')} Animated colors are shown as stored.`,
    }
  }
  for (const t of level.targets) {
    if (t.colors.length > 0) out[t.cgramIdx] = bgr555ToRgba(t.colors[0]!)
  }
  return { colors: out }
}

/** The wiring from readings to inputs. Pure: no ROM access, so every step is testable in CI. */
export function assembleL1Inputs(r: L1Readings): L1Inputs {
  const frameZero = frameZeroFrom(r.stockAnim, r.unreached, r.rawVram, r.exAnim)
  const vram = frameZero?.vram ?? r.rawVram
  const stored = levelColorsFrom(r)
  const palette = applyPaletteFrame0(stored.colors, r.paletteAnim)
  const notes = [...(r.unverified ?? []), frameZero?.error, palette.note].filter(Boolean)
  const anim = frameZero?.animData
  return {
    header: r.header,
    isVertical: r.isVertical,
    screenCount: r.header.levelLength,
    grid: r.grid,
    map16: r.map16,
    rawVram: r.rawVram,
    anim: frameZero?.animData ?? null,
    vram,
    animNote: notes.length > 0 ? notes.join(' ') : undefined,
    colors: palette.colors,
    backArea: stored.backArea,
    switchArt: anim ? switchArtOf(anim, r.map16.tiles, vram, palette) : new Map(),
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
  const noL1 = readNoL1Modes(rom.rom)
  if ('reason' in noL1) return refuse(noL1.reason)
  if (noL1.modes.has(header.levelMode)) {
    return refuse(`Map ${hex3(index)} is a boss arena: the game never loads its L1 (foreground)`)
  }
  try {
    const { objects } = parseLevelObjects(raw, table.table)
    const isVertical = isLevelModeVertical(header.levelMode, table.table)
    const tileset = header.objectTileset
    // No levelNum: the Layer 3 overflow screens are not this map's own.
    const unverified: string[] = []
    const grid = expandMap(objects, header.levelLength, rom.rom, tileset, isVertical, header.levelMode, undefined, flags, unverified) // prettier-ignore

    const gfx = gfxSource(rom.rom)
    if (!gfx.ok) return refuse(`GFX cannot be read: ${gfx.reason}`)
    const capacity = map16TileCapacity(rom.rom)
    if ('reason' in capacity) return refuse(capacity.reason)
    const col1 = readLevelCol1(rom.rom)
    if ('reason' in col1) return refuse(`Palette column 1 is unavailable: ${col1.reason}`)

    const stockAnim = loadAnimationDataOrReason(rom.rom, tileset)
    const inputs = assembleL1Inputs({
      header,
      isVertical,
      grid,
      map16: loadMap16WithPipeVariants(rom.rom, tileset),
      rawVram: loadVram(rom.rom, tileset, header.spriteSet),
      stockAnim,
      unreached: stockAnim.ok ? stockAnimationUnreached(rom.rom) : null,
      exAnim: loadExAnimData(rom.rom, index),
      custom: loadCustomLevelPalette(rom.rom, index),
      romPalettes: loadRomPalettes(rom.rom, header.bgPalette),
      backAreas: loadBackAreaColors(rom.rom),
      col1,
      paletteAnim: detectPaletteAnimation(rom.rom).level,
      unverified,
    })
    return { ok: true, inputs }
  } catch (err) {
    return refuse(`Map ${hex3(index)} could not be read: ${(err as Error).message}`)
  }
}
