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
import { parseLevelObjects, parseLevelSprites } from '../../../../src/rom/LevelParser'
import { levelNameForSlot } from '../../../../src/rom/SmwLevelNames'
import {
  deriveOverworldEntrances,
  type OverworldEntranceIndex,
} from '../../../../src/rom/OverworldEntrances'
import type { MapDetailsDto } from '../common/project-protocol'

const hex = (n: number, w = 2): string => `$${n.toString(16).toUpperCase().padStart(w, '0')}`

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
        ? `the Layer 1 pointer ${hex(ptr, 6)} does not address this ROM's data`
        : `slot ${hex(index, 3)} has no Layer 1 pointer`,
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
      ? `no sprite data at the pointer for slot ${hex(index, 3)}`
      : site.reason
  } else {
    const spriteData = rom.rom.readAt(spritePtr, 0x200)
    if (!spriteData) {
      spriteUnavailable = `no sprite data at the pointer for slot ${hex(index, 3)}`
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
      { label: 'Level mode', value: hex(h.levelMode) },
      { label: 'Object tileset', value: hex(h.objectTileset) },
      { label: 'Sprite tileset', value: hex(h.spriteSet) },
      { label: 'FG palette', value: hex(h.fgPalette) },
      { label: 'BG palette', value: hex(h.bgPalette) },
      { label: 'Sprite palette', value: hex(h.spritePalette) },
      { label: 'Back area color', value: hex(h.bgColor) },
      { label: 'Music', value: hex(h.music) },
      { label: 'Time limit', value: hex(h.timeLimit) },
      { label: 'Item memory', value: hex(h.itemMemory) },
      { label: 'Vertical scroll', value: hex(h.verticalScroll) },
      { label: 'Layer 3 priority', value: h.layer3Priority ? 'yes' : 'no' },
    ],
  }
}
