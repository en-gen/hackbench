/**
 * Turning a level edit into a ROM patch layer.
 *
 * This is the missing arrow in the preview pipeline: the emulator already
 * loads base ROM plus patches, and PatchLayer.ts already stacks patches, but
 * nothing yet produced a patch from an edit. These functions do, and they do
 * it by READING the object stream rather than by knowing where things are:
 * the byte to change is located through parseLevelObjects, so a romhack that
 * relocated its level data still patches the right byte.
 */
import { parseLevelObjects, parseLevelSprites } from './LevelParser'
import { PatchLayer } from './PatchLayer'

/**
 * Move one Layer-1 object horizontally, within its own screen.
 *
 * Which byte holds X depends on the level's orientation, and that is read from
 * the header rather than assumed. Per parseLevelObjects, mirroring
 * bank_05.asm:714-724:
 *
 *   horizontal: X is the low nibble of byte 1 (byte 0 low holds Y)
 *   vertical:   X is the low nibble of byte 0 (after CODE_0585D8's swap)
 *
 * Only the low nibble moves, so an object stays on its screen. Crossing a
 * screen boundary is a different operation: it needs byte 0's new-screen flag
 * and a reordering of the stream, because screen number is derived by counting
 * that flag while walking. Throwing here is deliberate. Silently wrapping the
 * nibble would move the object to the far side of the same screen, which
 * renders as a plausible level and would pass a careless eyeball check.
 *
 * @param rawL1        the level's raw Layer-1 data, header included
 * @param l1FileOffset file offset that rawL1 was read from
 * @param objectIndex  index into parseLevelObjects(rawL1, verticalTable).objects
 * @param dx           tiles to move; negative moves left
 * @param verticalTable VerticalTable's 32 bytes, from LevelTableGate.readVerticalTable
 */
export function moveObjectX(
  rawL1: Buffer | Uint8Array,
  l1FileOffset: number,
  objectIndex: number,
  dx: number,
  verticalTable: readonly number[],
  id = `move-obj-${objectIndex}-by-${dx}`,
): PatchLayer {
  const { objects, isVertical } = parseLevelObjects(rawL1, verticalTable)
  const obj = objects[objectIndex]
  if (!obj) {
    throw new RangeError(`object ${objectIndex} does not exist; level has ${objects.length}`)
  }

  const byteIndex = isVertical ? 0 : 1
  const original = obj.raw[byteIndex]
  const currentX = original & 0x0f
  const nextX = currentX + dx
  if (nextX < 0 || nextX > 0x0f) {
    throw new RangeError(
      `moving object ${objectIndex} by ${dx} leaves its screen ` +
        `(x nibble ${currentX} -> ${nextX}); that needs a stream reorder, not a byte patch`,
    )
  }

  return {
    id,
    label: `move object ${objectIndex} ${dx > 0 ? 'right' : 'left'} ${Math.abs(dx)}`,
    patches: [
      {
        offset: l1FileOffset + obj.streamOffset + byteIndex,
        value: (original & 0xf0) | nextX,
      },
    ],
  }
}

/**
 * Move one sprite horizontally, within its own screen.
 *
 * Sprite entries are 3 bytes (bank_02.asm:5263,5279):
 *   byte 0: YYYY ee s y   (Y within screen, extra bits, screen high bit, Y high)
 *   byte 1: XXXX SSSS     (X within screen, screen number low nibble)
 *   byte 2: sprite ID
 *
 * So X lives in byte 1's HIGH nibble, and the screen number shares that byte
 * in the low nibble: a careless write to byte 1 moves the sprite to a
 * different screen instead, which renders as a plausible level.
 *
 * Vertical levels swap YYYY and XXXX (bank_02.asm:5427-5438), putting X in
 * byte 0's high nibble instead, so orientation is read rather than assumed.
 *
 * As with objects, only the nibble moves; leaving the screen would need the
 * screen number changed too and the stream kept in screen order.
 */
export function moveSpriteX(
  rawSprites: Buffer | Uint8Array,
  spritesFileOffset: number,
  spriteIndex: number,
  dx: number,
  isVertical = false,
  id = `move-sprite-${spriteIndex}-by-${dx}`,
): PatchLayer {
  const sprites = parseLevelSprites(rawSprites, isVertical)
  const sprite = sprites[spriteIndex]
  if (!sprite) {
    throw new RangeError(`sprite ${spriteIndex} does not exist; level has ${sprites.length}`)
  }

  const byteIndex = isVertical ? 0 : 1
  const original = sprite.raw[byteIndex]
  const currentX = (original >> 4) & 0x0f
  const nextX = currentX + dx
  if (nextX < 0 || nextX > 0x0f) {
    throw new RangeError(
      `moving sprite ${spriteIndex} by ${dx} leaves its screen ` +
        `(x nibble ${currentX} -> ${nextX}); that needs the screen number changed too`,
    )
  }

  return {
    id,
    label: `move sprite ${spriteIndex} ${dx > 0 ? 'right' : 'left'} ${Math.abs(dx)}`,
    scope: 'edit',
    // Low nibble preserved: for a horizontal level it is the screen number.
    patches: [
      {
        offset: spritesFileOffset + sprite.streamOffset + byteIndex,
        value: (original & 0x0f) | (nextX << 4),
      },
    ],
  }
}

/**
 * Remove a sprite from a level.
 *
 * The sprite stream is a run of 3-byte entries ending at an $FF byte 0
 * (parseLevelSprites, mirroring the game's own scan), so deleting one means
 * shifting every later entry down three bytes and re-terminating. That is
 * expressible as ordinary byte writes; nothing needs to move in the ROM.
 *
 * The three bytes at the tail of the old stream are deliberately left alone.
 * They sit AFTER the new terminator, so neither the game nor the parser ever
 * reads them, and writing them would only make the patch larger.
 *
 * Deleting is a better first edit than moving: it has no grid to snap to and
 * no screen boundary to refuse at, and whether it worked is obvious.
 */
export function deleteSprite(
  rawSprites: Buffer | Uint8Array,
  spritesFileOffset: number,
  spriteIndex: number,
  isVertical = false,
  id = `delete-sprite-${spriteIndex}`,
): PatchLayer {
  const sprites = parseLevelSprites(rawSprites, isVertical)
  const target = sprites[spriteIndex]
  if (!target) {
    throw new RangeError(`sprite ${spriteIndex} does not exist; level has ${sprites.length}`)
  }

  // Everything after the deleted entry, moved down, then the terminator.
  const tail: number[] = []
  for (const s of sprites.slice(spriteIndex + 1)) tail.push(...s.raw)
  tail.push(0xff)

  return {
    id,
    label: `delete sprite ${spriteIndex} (id $${target.spriteId.toString(16)})`,
    scope: 'edit',
    patches: tail.map((value, i) => ({
      offset: spritesFileOffset + target.streamOffset + i,
      value,
    })),
  }
}
