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
import { filterSomeRamNote, levelGfxAssignmentNote } from '../../../../src/rom/GfxLoader'
import {
  deriveOverworldEntrances,
  type OverworldEntranceIndex,
} from '../../../../src/rom/OverworldEntrances'
import type { MapDetailsDto } from '../common/project-protocol'

const hex = (n: number, w = 2): string => `$${n.toString(16).toUpperCase().padStart(w, '0')}`

/**
 * Read one map's details from `rom`. A slot whose level data cannot be read
 * returns the reason, never an empty map (see MapDetailsDto).
 */
export function buildMapDetails(
  rom: SmwRom,
  index: number,
  entrances?: OverworldEntranceIndex,
): MapDetailsDto {
  // Read once so "no name" and "mapping unreadable" stay distinguishable,
  // the same shape as verticalTable and the sprite site below.
  const nameResult = levelNameForSlot(rom.rom, entrances ?? deriveOverworldEntrances(rom), index)
  const named = { index, nameUnavailable: nameResult.reason }

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

  // The header and the object walk never read isVertical (see
  // SmwRom.buildLevelExitGraph for the same reasoning), so a ROM whose
  // VerticalTable read is unavailable still reports the rest of the map;
  // only orientation itself is reported unavailable, with why.
  const verticalTable = rom.getVerticalTable()
  const parsed = parseLevelObjects(raw, verticalTable.ok ? verticalTable.table : [])
  const h = parsed.header

  // Sprites live behind their own pointer. A stream that will not parse, or
  // a ROM whose sprite pointer read is unavailable, is not a reason to
  // refuse the rest of the map: the sprites are reported unavailable, with why.
  const spritePtr = rom.getLevelSpritePointer(index)
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
        parseLevelSprites(spriteData, verticalTable.ok && parsed.isVertical)
      } catch (e) {
        spriteUnavailable = `the sprite stream did not parse: ${(e as Error).message}`
      }
    }
  }

  return {
    ...named,
    levelMode: h.levelMode,
    orientationUnavailable: verticalTable.ok ? undefined : verticalTable.reason,
    objectsUnavailable: parsed.terminated
      ? undefined
      : 'the object stream did not reach its $FF terminator, so the object list may be cut short',
    spriteUnavailable,
    gfxAssignmentNote:
      [levelGfxAssignmentNote(rom.rom), filterSomeRamNote(rom.rom, h.objectTileset, h.spriteSet)]
        .filter(Boolean)
        .join(' ') || undefined,
  }
}
