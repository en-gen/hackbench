/**
 * Pure `mapDetails` logic for the Map view: no Theia or RPC imports, so it is
 * unit-testable the same way map16-decode.ts is (see that file's doc
 * comment). `ProjectServiceImpl.mapDetails` is a thin delegator to
 * `buildMapDetails`, which is what lets this run in CI: the unit job does
 * not install the `theia/` workspace, and a test that reaches
 * `ProjectServiceImpl` (which imports `@theia/core/shared/inversify`) fails
 * to LOAD there, skipIf or not, because that import is resolved when the
 * test file loads, not when the gated case runs.
 */
import { SmwRom } from '../../../../src/rom/SmwRom'
import { hex2, hex3s, hex6 } from '../../../../src/rom/hex'
import { parseLevelObjects, parseLevelSprites } from '../../../../src/rom/LevelParser'
import { levelNameForSlot } from '../../../../src/rom/SmwLevelNames'
import { filterSomeRamNote, levelGfxAssignmentNote } from '../../../../src/rom/GfxLoader'
import {
  deriveOverworldEntrances,
  type OverworldEntranceIndex,
} from '../../../../src/rom/OverworldEntrances'
import type { MapDetailsDto } from '../common/project-protocol'

/**
 * Read one map's details from `rom`. A slot whose level data cannot be read
 * returns its name and the reason, never an empty map (see MapDetailsDto).
 */
export function buildMapDetails(
  rom: SmwRom,
  index: number,
  entrances?: OverworldEntranceIndex,
): MapDetailsDto {
  // Read once so "no name" and "mapping unreadable" stay distinguishable,
  // the same shape as verticalTable and the sprite site below.
  const nameResult = levelNameForSlot(rom.rom, entrances ?? deriveOverworldEntrances(rom), index)
  const named = { index, name: nameResult.name, nameUnavailable: nameResult.reason }

  const raw = rom.getLevelRawData(index)
  if (!raw) {
    const ptr = rom.getLevelL1Pointer(index)
    return {
      ...named,
      levelDataUnavailable: ptr
        ? `the Layer 1 pointer $${hex6(ptr)} does not address this ROM's data`
        : `slot ${hex3s(index)} has no Layer 1 pointer`,
    }
  }

  // Header, screen count and object count never read isVertical (see
  // SmwRom.buildLevelExitGraph for the same reasoning), so a ROM whose
  // VerticalTable read is unavailable still reports the rest of the map;
  // only orientation itself goes absent, with why.
  const verticalTable = rom.getVerticalTable()
  const parsed = parseLevelObjects(raw, verticalTable.ok ? verticalTable.table : [])
  const h = parsed.header

  // Sprites live behind their own pointer. A stream that will not parse, or
  // a ROM whose sprite pointer read is unavailable, is not a reason to
  // refuse the rest of the map: the count is reported absent, with why.
  const spritePtr = rom.getLevelSpritePointer(index)
  let spriteCount: number | undefined
  let spriteUnavailable: string | undefined
  if (spritePtr === null) {
    const site = rom.getSpritePointerSite()
    spriteUnavailable = site.ok
      ? `no sprite data at the pointer for slot ${hex3s(index)}`
      : site.reason
  } else {
    const spriteData = rom.rom.readAt(spritePtr, 0x200)
    if (!spriteData) {
      spriteUnavailable = `no sprite data at the pointer for slot ${hex3s(index)}`
    } else {
      try {
        spriteCount = parseLevelSprites(spriteData, verticalTable.ok && parsed.isVertical).length
      } catch (e) {
        spriteUnavailable = `the sprite stream did not parse: ${(e as Error).message}`
      }
    }
  }

  return {
    ...named,
    headerBytes: h.raw,
    screens: parsed.screens,
    levelMode: h.levelMode,
    isVertical: verticalTable.ok ? parsed.isVertical : undefined,
    orientationUnavailable: verticalTable.ok ? undefined : verticalTable.reason,
    objectCount: parsed.terminated ? parsed.objects.length : undefined,
    objectsUnavailable: parsed.terminated
      ? undefined
      : 'the object stream did not reach its $FF terminator, so the count cannot be trusted',
    spriteCount,
    spriteUnavailable,
    // Labels match LevelParser's own field names so a reader can follow
    // each one back to its ASM citation.
    header: [
      { label: 'Screens', value: String(h.levelLength) },
      { label: 'Level mode', value: `$${hex2(h.levelMode)}` },
      { label: 'Object tileset', value: `$${hex2(h.objectTileset)}` },
      { label: 'Sprite tileset', value: `$${hex2(h.spriteSet)}` },
      { label: 'FG palette', value: `$${hex2(h.fgPalette)}` },
      { label: 'BG palette', value: `$${hex2(h.bgPalette)}` },
      { label: 'Sprite palette', value: `$${hex2(h.spritePalette)}` },
      { label: 'Back area color', value: `$${hex2(h.bgColor)}` },
      { label: 'Music', value: `$${hex2(h.music)}` },
      { label: 'Time limit', value: `$${hex2(h.timeLimit)}` },
      { label: 'Item memory', value: `$${hex2(h.itemMemory)}` },
      { label: 'Vertical scroll', value: `$${hex2(h.verticalScroll)}` },
      { label: 'Layer 3 priority', value: h.layer3Priority ? 'yes' : 'no' },
    ],
    gfxAssignmentNote:
      [levelGfxAssignmentNote(rom.rom), filterSomeRamNote(rom.rom, h.objectTileset, h.spriteSet)]
        .filter(Boolean)
        .join(' ') || undefined,
  }
}
