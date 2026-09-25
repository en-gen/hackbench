/**
 * SmwRom.ts -- ROM access and level enumeration for Super Mario World.
 *
 * Derived from SMWDisX disassembly:
 *   - Layer1Ptrs: bank_05.asm line 7680 (L1 pointer table at $05E000)
 *   - Layer2Ptrs: bank_05.asm line 8194 (L2 pointer table at $05E600)
 *   - Ptrs05EC00: bank_05.asm line 8708 (sprite pointer table at $05EC00)
 *   - CODE_05D796: bank_05.asm line 7079 (level load / translevel conversion)
 *   - CODE_05D8B7: bank_05.asm lines 7228-7258 (pointer table indexing)
 *
 * Pointer table layout (bank_05.asm lines 7228-7258):
 *   Level number is multiplied by 3 for L1/L2 (3-byte interleaved: lo, hi, bank)
 *   Level number is multiplied by 2 for sprites (2-byte: lo, hi; bank always $07)
 *
 * Translevel conversion (CODE_05D8A2, line 7217-7222):
 *   If translevel >= $25, subtract $24 to get the level index.
 *   Combined with submap flag to form the full 9-bit level number.
 *
 * Screen-exit destination (CODE_05D796, bank_05.asm lines 7100-7162):
 *   The destination's high byte comes from OWPlayerSubmap (RAM, "is the
 *   player's overworld position on a submap"), never from ExitTableHigh
 *   (declared rammap.asm:1970, written once at bank_0D.asm:1435, read
 *   nowhere) and never from DATA_05FE00 bit 3 (bank_05.asm:7159-7161 reads
 *   only bits 0-2, into LevelEntranceType). See buildLevelExitGraph for the
 *   static equivalent of this runtime flag.
 */

import { RomFile } from './RomFile'
import { parseLevelObjects } from './LevelParser'
import { getLevelNameByIndex } from './SmwLevelNames'
import { OVERWORLD_ENTRY, SCREEN_EXIT, stockCodeMismatch } from './SubmapFlagGate'
import {
  readSpritePointerSite,
  readVerticalTable,
  SpritePointerSite,
  VerticalTableSite,
} from './LevelTableGate'

/** SNES addresses for SMW ROM structures. */
export const ADDR = {
  ROM_NAME: 0x00ffc0,
  ROM_SPEED_MAP: 0x00ffd5,
  ROM_SIZE: 0x00ffd7,
  SRAM_SIZE: 0x00ffd8,

  // Layer 1 pointer table: interleaved 3-byte entries (lo, hi, bank).
  // bank_05.asm line 7680: Layer1Ptrs at $05E000.
  // 512 entries x 3 bytes = $600 bytes ($05E000-$05E5FF).
  LEVEL_L1_PTR: 0x05e000,
  LEVEL_L1_LOW: 0x05e000,

  // Layer 2 pointer table: same 3-byte layout.
  // bank_05.asm line 8194: Layer2Ptrs at $05E600.
  LEVEL_L2_PTR: 0x05e600,

  // Map16 tile data
  MAP16_LOW: 0x0d8000,
  MAP16_HIGH: 0x0dc000,

  // GFX tileset lookup: $05D760[spriteSet] -> tileset index
  // bank_05.asm: referenced in the game's sprite tileset loading
  TILESETID_TABLE: 0x05d760,

  // Secondary entrance tables (bank_05.asm CODE_05D796 lines 7113-7161).
  // DATA_05F800 is two 256-entry halves: index = (submap flag << 8) | byte
  // (line 7116: `LDY.B _E` is a 16-bit load of the _E/_F zero-page pair).
  SEC_EXIT_DEST: 0x05f800, // DATA_05F800: lo byte of destination
  SEC_EXIT_LO: 0x05fa00, // DATA_05FA00: BG/FG/Mario Y pos info
  SEC_EXIT_SCREEN: 0x05fc00, // DATA_05FC00: Mario X pos + screen
  SEC_EXIT_FLAGS: 0x05fe00, // DATA_05FE00: entrance action (bits 0-2 only; bit 3 unread, see header)

  SEC_ENTRANCE_COUNT: 512,

  // Overworld translevel table
  OW_TRANSLEVEL: 0x049e00, // OWLayer1Translevel (bank_05.asm line 7214)

  // Global palette
  GLOBAL_PALETTE: 0x00b0a0,
} as const

const SMW_ROM_NAME = 'SUPER MARIOWORLD'
export const LEVEL_COUNT = 0x200

/**
 * Overworld-accessible level pointer table ranges.
 *
 * From CODE_05D8A2 (bank_05.asm line 7217):
 *   Translevel $00-$24 -> room $000-$024 (main overworld, 37 slots)
 *   Translevel $25-$5F -> room $101-$13B (submaps, 59 slots)
 *     (subtract $24, then add $100 for submap flag)
 */
export function isOverworldLevel(index: number): boolean {
  return (index >= 0x000 && index <= 0x024) || (index >= 0x101 && index <= 0x13b)
}

/** `unavailable` names why the graph could not be built; `graph` is then empty. */
export interface LevelExitGraph {
  graph: Map<number, number[]>
  unavailable: string | null
}

export interface RomSummary {
  filePath: string
  internalName: string
  romSizeKb: number
  sramSizeKb: number
  hasHeader: boolean
  romSize: number
  isVanilla: boolean
}

export class SmwRom {
  readonly rom: RomFile

  constructor(romFile: RomFile) {
    this.rom = romFile
    this._validateOrWarn()
  }

  static open(filePath: string): SmwRom {
    return new SmwRom(RomFile.load(filePath))
  }

  private _validateOrWarn(): void {
    const mapMode = this.rom.readByte(ADDR.ROM_SPEED_MAP)
    if (mapMode !== 0x20 && mapMode !== 0x30) {
      throw new Error(
        `Unexpected ROM map mode: $${mapMode?.toString(16).toUpperCase()} ` +
          `(expected $20 or $30 for LoROM)`,
      )
    }
  }

  get internalName(): string {
    return this.rom.readString(ADDR.ROM_NAME, 21)
  }
  get romSizeKb(): number {
    const n = this.rom.readByte(ADDR.ROM_SIZE)
    return n ? 1 << n : 0
  }
  get sramSizeKb(): number {
    const n = this.rom.readByte(ADDR.SRAM_SIZE)
    return n ? 1 << n : 0
  }

  getSummary(): RomSummary {
    return {
      filePath: this.rom.filePath,
      internalName: this.internalName,
      romSizeKb: this.romSizeKb,
      sramSizeKb: this.sramSizeKb,
      hasHeader: this.rom.hasHeader,
      romSize: this.rom.romSize,
      isVanilla: this.internalName.startsWith(SMW_ROM_NAME),
    }
  }

  /**
   * Read the L1 pointer for a level.
   *
   * From CODE_05D8B7 (bank_05.asm lines 7228-7240):
   *   Y = levelNumber * 3 (each entry is 3 bytes: lo, hi, bank)
   *   ptr = Layer1Ptrs[Y] | (Layer1Ptrs[Y+1] << 8) | (Layer1Ptrs[Y+2] << 16)
   */
  getLevelL1Pointer(index: number): number | null {
    const base = ADDR.LEVEL_L1_PTR + index * 3
    const lo = this.rom.readByte(base)
    const hi = this.rom.readByte(base + 1)
    const bk = this.rom.readByte(base + 2)
    if (lo === null || hi === null || bk === null) return null
    return (bk << 16) | (hi << 8) | lo
  }

  /**
   * Read the L2 pointer for a level.
   *
   * Same 3-byte layout as L1. Bank byte = $FF means preset background.
   * (bank_05.asm lines 7241-7246)
   */
  getLevelL2Pointer(index: number): number | null {
    const base = ADDR.LEVEL_L2_PTR + index * 3
    const lo = this.rom.readByte(base)
    const hi = this.rom.readByte(base + 1)
    const bk = this.rom.readByte(base + 2)
    if (lo === null || hi === null || bk === null) return null
    return (bk << 16) | (hi << 8) | lo
  }

  /**
   * Read the sprite pointer for a level.
   *
   * From CODE_05D8B7 (bank_05.asm lines 7248-7258):
   *   Y = levelNumber * 2 (each entry is 2 bytes: lo, hi)
   *   table address and bank source are read from the routine's own operands
   *   by LevelTableGate.readSpritePointerSite, including the recognized
   *   Lunar Magic hooks that read the bank per level.
   */
  getLevelSpritePointer(index: number): number | null {
    const site = readSpritePointerSite(this.rom)
    if (!site.ok) return null
    const base = site.tableAddr + index * 2
    const lo = this.rom.readByte(base)
    const hi = this.rom.readByte(base + 1)
    if (lo === null || hi === null) return null
    const bank =
      site.bank.kind === 'fixed' ? site.bank.bank : this.rom.readByte(site.bank.tableAddr + index)
    if (bank === null) return null
    return (bank << 16) | (hi << 8) | lo
  }

  /** VerticalTable's 32 bytes (bank_05.asm:552), carrying a reason when the
   *  read that names it is not present or not recognized on this ROM. */
  getVerticalTable(): VerticalTableSite {
    return readVerticalTable(this.rom)
  }

  /** The sprite pointer table and bank source, carrying a reason when the
   *  read that names them is not present or not recognized on this ROM. */
  getSpritePointerSite(): SpritePointerSite {
    return readSpritePointerSite(this.rom)
  }

  /** `getVerticalTable`, thrown as the gate's own reason for a caller that
   *  cannot proceed without it. */
  requireVerticalTable(): readonly number[] {
    const site = this.getVerticalTable()
    if (!site.ok) throw new Error(site.reason)
    return site.table
  }

  getAllLevelPointers(): Array<{ index: number; address: number | null }> {
    return Array.from({ length: LEVEL_COUNT }, (_, i) => ({
      index: i,
      address: this.getLevelL1Pointer(i),
    }))
  }

  /**
   * Read enough of a level's Layer-1 stream to cover the object data AND
   * the LM per-screen exit table after the $FF terminator. LM-extended
   * streams can exceed a fixed 512 bytes (sublevel $103 is ~655 bytes of
   * objects alone), so read a generous ceiling and fall back smaller near
   * EOF; parseLevelObjects/parseLevelScreenExits both stop at the first
   * $FF regardless, so over-reading is harmless.
   */
  getLevelRawData(index: number): Buffer | null {
    const ptr = this.getLevelL1Pointer(index)
    if (!ptr) return null
    // Try a generous ceiling first, then fall back for pointers near EOF.
    for (const len of [0x2000, 0x1000, 0x800, 0x400, 0x200]) {
      const buf = this.rom.readAt(ptr, len)
      if (buf) return buf
    }
    return null
  }

  /**
   * Returns the GFX tileset index for a level.
   *
   * From bank_05.asm: tilesetId = ROM[$05D760 + spriteSet]
   * The spriteSet comes from header byte 2 bits 3-0 (CODE_0584E3 line 573).
   */
  getGfxTilesetId(index: number): number {
    const ptr = this.getLevelL1Pointer(index)
    if (!ptr) return 0
    const buf = this.rom.readAt(ptr, 5)
    if (!buf || buf.length < 5) return 0
    // Header byte 2 bits 3-0 = sprite tileset (CODE_0584E3 line 573)
    const spriteSet = buf[2] & 0x0f
    return this.rom.readByte(ADDR.TILESETID_TABLE + spriteSet) ?? 0
  }

  /**
   * Returns true if the level has valid object data.
   *
   * Bank byte validation: vanilla level data is in banks $02-$09.
   * Level mode check: modes 0-20 are valid (CODE_0584E3 line 539).
   */
  levelHasObjects(index: number): boolean {
    const data = this.getLevelRawData(index)
    if (data === null || data.length <= 5) return false

    const levelMode = data[1] & 0x1f
    if (levelMode > 20) return false

    // data[5] is first object byte; 0xFF = immediate terminator
    return data[5] !== 0xff
  }

  /**
   * Classify all levels into overworld-accessible and sub-area groups.
   *
   * For the lower-level question of which of the 512 pointer-table slots
   * hold real (non-filler) data at all, see buildLevelCatalog in LevelCatalog.ts.
   */
  classifyLevels(): { overworld: number[]; subarea: number[] } {
    const overworld: number[] = []
    const subarea: number[] = []
    const seenPointers = new Set<number>()

    for (let i = 0; i < LEVEL_COUNT; i++) {
      const ptr = this.getLevelL1Pointer(i)
      if (!ptr) continue
      if (seenPointers.has(ptr)) continue

      if (!this.levelHasObjects(i)) continue
      seenPointers.add(ptr)

      if (isOverworldLevel(i)) {
        overworld.push(i)
      } else {
        subarea.push(i)
      }
    }

    return { overworld, subarea }
  }

  /**
   * Detects the shared placeholder Layer-1 pointer that unused pointer-table
   * slots fall back to (measured on vanilla: SNES $068000, shared by 277 of
   * 512 slots, including both $012 and $112). levelHasObjects() cannot spot
   * this -- the filler room contains real, well-formed object data -- only
   * pointer identity distinguishes a filler slot from a real room. Measured
   * across the six-ROM corpus: filler repeats 158-277 times, the runner-up
   * pointer repeats 8 times on every ROM -- the gate below sits two above
   * that observed ceiling, not at some ratio of it.
   */
  private _findFillerL1Pointer(): number | null {
    const FILLER_MIN_REPEATS = 10
    const counts = new Map<number, number>()
    for (let i = 0; i < LEVEL_COUNT; i++) {
      const ptr = this.getLevelL1Pointer(i)
      // Falsy check (not just null), matching classifyLevels: a literal $000000
      // pointer is never a real level (it would land in the ROM header/reset
      // vectors), and it's what an all-zero pointer-table slot reads as.
      if (!ptr) continue
      counts.set(ptr, (counts.get(ptr) ?? 0) + 1)
    }
    let fillerPtr: number | null = null
    let fillerCount = 0
    for (const [ptr, count] of counts) {
      if (count > fillerCount) {
        fillerPtr = ptr
        fillerCount = count
      }
    }
    return fillerCount >= FILLER_MIN_REPEATS ? fillerPtr : null
  }

  /**
   * Build exit graph: sourceLevelIndex → [destLevelIndex].
   *
   * Destination high byte (the "submap flag"): CODE_05D796 derives it at
   * runtime from OWPlayerSubmap (bank_05.asm 7103-7110, 7206-7226), never
   * from ExitTableHigh or DATA_05FE00 bit 3 (see header). Static
   * equivalent: every level reached from overworld root R inherits R's
   * flag -- 1 if R is in the submap range ($101-$13B), 0 in main-map range
   * ($000-$024).
   *
   * The flag can never collide across roots: every propagated destination
   * is (flag<<8)|destLow with destLow in [0,255], so flag-0 nodes live
   * entirely in $000-$0FF and flag-1 entirely in $100-$1FF -- disjoint by
   * construction, so a sub-area shared by two roots always sees the same
   * flag from both. The BFS's real job is a reachability gate, not flag
   * propagation (the flag is recoverable from the destination range
   * alone): a level's exits are resolved only once BFS reaches it from an
   * overworld root, so an orphaned level's exit data never contributes an
   * edge, and a level never reached gets no flag and no resolved exits.
   *
   * Secondary-exit low byte: DATA_05F800 is two 256-entry halves selected
   * by the same flag (bank_05.asm 7113-7118, `LDY.B _E` reads the _E/_F
   * zero-page pair as one 16-bit index). Primary-exit low byte: when
   * UseSecondaryExit is clear, the object's extra byte IS the destination
   * low byte (lines 7111-7112, 7162). Filler rejection: see
   * _findFillerL1Pointer().
   *
   * Edited ROMs: the root's flag assumes the overworld-entry code and
   * propagation the screen-exit code. When SubmapFlagGate.ts finds either
   * replaced, the graph is empty and `unavailable` says why, rather than a
   * stock-shaped graph from a table the ROM may no longer index this way.
   */
  buildLevelExitGraph(): LevelExitGraph {
    const unavailable = stockCodeMismatch(this.rom, [...OVERWORLD_ENTRY, ...SCREEN_EXIT])
    if (unavailable) return { graph: new Map(), unavailable }

    // The map universe comes from pointer identity, the same test
    // buildLevelCatalog applies. classifyLevels is deliberately NOT used here:
    // it dedupes by L1 pointer, and it gates on levelHasObjects(). Between them
    // those made 47 of the vanilla cart's 235 real maps ineligible as a
    // destination, leaving 59 unreachable. $0EB's pointer is shared by $0F0,
    // $0FB, $1DA, $1E7 and $1F9; the dedupe kept one and discarded four, but
    // the secondary-exit table names a SLOT, not a pointer, so all five are
    // distinct destinations. MapTree.ts documents both defects and routes
    // around them the same way; levelHasObjects is issue #311.
    // (Inlined rather than calling buildLevelCatalog: LevelCatalog imports
    // SmwRom for a value, so depending on it here would be a runtime cycle.)
    const fillerPtr = this._findFillerL1Pointer()
    const realMaps: number[] = []
    for (let i = 0; i < LEVEL_COUNT; i++) {
      const ptr = this.getLevelL1Pointer(i)
      if (!ptr || ptr === fillerPtr) continue
      realMaps.push(i)
    }
    const overworld = realMaps.filter(isOverworldLevel)
    const validDestinations = new Set(realMaps.filter(idx => !isOverworldLevel(idx)))

    const destTable = this.rom.readAt(ADDR.SEC_EXIT_DEST, ADDR.SEC_ENTRANCE_COUNT)
    if (!destTable) {
      return {
        graph: new Map(),
        unavailable: 'The secondary-exit table DATA_05F800 is unreadable.',
      }
    }

    // Parse every level's screen-exit objects once. Resolution is deferred
    // to the BFS below because it needs each level's submap flag, which is
    // only known once the BFS actually reaches that level.
    const exitsByLevel = new Map<number, Array<{ isSecondary: boolean; rawByte: number }>>()
    for (let levelIdx = 0; levelIdx < LEVEL_COUNT; levelIdx++) {
      const rawL1 = this.getLevelRawData(levelIdx)
      if (!rawL1 || rawL1.length < 6) continue
      let parsed
      try {
        // isVertical only steers object x/y (see parseLevelObjects), which this
        // method never reads -- only screenExitDest/screenExitIsSecondary. An
        // empty table is a documented no-op input here, not a vanilla fallback.
        parsed = parseLevelObjects(rawL1, [])
      } catch {
        continue
      }
      const specs = parsed.objects
        .filter(o => o.screenExitDest !== undefined)
        .map(o => ({
          isSecondary: o.screenExitIsSecondary === true,
          // LevelParser folds a dead ExitTableHigh-derived bit into bit 8 of
          // screenExitDest (see LevelParser.ts); mask it back off to recover
          // the object's raw extra byte.
          rawByte: o.screenExitDest! & 0xff,
        }))
      if (specs.length > 0) exitsByLevel.set(levelIdx, specs)
    }

    // BFS from every overworld root, propagating its submap flag to every
    // level reachable through its exits. `submapFlag` doubles as the
    // visited set, so cycles (vanilla has pipe loops) terminate naturally.
    // The flag is bit 8 of the pointer-table index itself -- root >> 8.
    const submapFlag = new Map<number, 0 | 1>()
    const queue: number[] = []
    for (const root of overworld) {
      if (submapFlag.has(root)) continue
      // Bit 8 of the pointer-table index. Written as a ternary rather than
      // `(root >> 8) as 0 | 1`: that cast asserts a range nothing here
      // enforces, so a root >= $200 would silently yield a flag of 2 or more.
      submapFlag.set(root, root >= 0x100 ? 1 : 0)
      queue.push(root)
    }

    // Index-pointer dequeue rather than Array.shift(), which is O(n) per call
    // and would make this BFS O(n^2) over the 512-slot table.
    const graph = new Map<number, number[]>()
    let qi = 0
    while (qi < queue.length) {
      const cur = queue[qi++]!
      const flag = submapFlag.get(cur)!
      const specs = exitsByLevel.get(cur)
      if (!specs) continue

      const dests: number[] = []
      for (const spec of specs) {
        const destLow = spec.isSecondary ? destTable[(flag << 8) | spec.rawByte] : spec.rawByte
        if (destLow === undefined) continue
        const dest = (flag << 8) | destLow
        if (dest === cur || !validDestinations.has(dest)) continue

        if (!dests.includes(dest)) dests.push(dest)
        if (!submapFlag.has(dest)) {
          submapFlag.set(dest, flag)
          queue.push(dest)
        }
      }
      if (dests.length > 0) graph.set(cur, dests)
    }

    return { graph, unavailable: null }
  }

  /** Get level name from ROM (decoded via SmwLevelNames). */
  getLevelName(index: number): string | null {
    return getLevelNameByIndex(this.rom, index)
  }

  /** Enumerate all 512 pointer table slots, returning metadata for each. */
  enumerateAllLevels(): Array<{ index: number; hasData: boolean; name: string | null }> {
    const results: Array<{ index: number; hasData: boolean; name: string | null }> = []
    for (let i = 0; i < 0x200; i++) {
      const ptr = this.getLevelL1Pointer(i)
      let hasData = false
      if (ptr !== null) {
        const data = this.rom.readAt(ptr, 6)
        if (data && data.length >= 6) {
          const mode = data[1] & 0x1f
          hasData = mode <= 0x1f && data[5] !== undefined
        }
      }
      results.push({ index: i, hasData, name: hasData ? this.getLevelName(i) : null })
    }
    return results
  }
}
