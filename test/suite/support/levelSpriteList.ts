/**
 * A map's own sprite list as the grader must build it: a vertical level swaps the meaning of the
 * sprite stream's X and Y fields (MapBuilder.ts:100 decides the same way). Test oracle only.
 */
import {
  isLevelModeVertical,
  parseLevelHeader,
  parseLevelSprites,
} from '../../../src/rom/LevelParser'
import type { LevelSprite } from '../../../src/rom/LevelParser'

export function levelSpriteList(
  spriteData: Uint8Array,
  rawL1: Uint8Array,
  verticalTable: readonly number[],
): LevelSprite[] {
  const vertical = isLevelModeVertical(parseLevelHeader(rawL1).levelMode, verticalTable)
  return parseLevelSprites(spriteData, vertical)
}
