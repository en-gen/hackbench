import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { RomFile } from '../../../src/rom/RomFile'
import {
  isLevelModeVertical,
  parseLevelHeader,
  parseLevelSprites,
} from '../../../src/rom/LevelParser'
import { moveSpriteX, moveObjectX } from '../../../src/rom/LevelEdits'
import { applyPatches, build, flatten, exportable } from '../../../src/rom/PatchLayer'
import { encodeIps, decodeIps } from '../../../src/rom/Ips'
import { buildMapPayload } from '../../../src/rom/model/MapBuilder'
import { deleteSprite } from '../../../src/rom/LevelEdits'
import { VANILLA, hasRom, romPath } from '../support/corpus'

/**
 * The edit pipeline against a real cart: locate a sprite in the ROM's own
 * stream, move it, stack the layer, and confirm the moved sprite is what the
 * ROM now parses as. This is the host half of click-to-edit, minus the
 * VS Code plumbing (EditSession wraps exactly these calls).
 *
 * Swept across levels rather than asserted on one, because a single-case pass
 * here would say nothing about whether the byte layout holds generally.
 */
const ROM_PATH = romPath(VANILLA)

describe.skipIf(!hasRom(VANILLA))('edit pipeline against a real ROM', () => {
  const rom = (): SmwRom => SmwRom.open(ROM_PATH)

  interface Level {
    id: number
    raw: Buffer
    sprites: ReturnType<typeof parseLevelSprites>
    spriteOffset: number
    isVertical: boolean
  }

  /** Levels that actually have a sprite with room to move. */
  function movableLevels(smw: SmwRom, want: number): Level[] {
    const verticalTable = smw.requireVerticalTable()
    const out: Level[] = []
    for (let id = 0x001; id < 0x200 && out.length < want; id++) {
      const l1 = smw.getLevelRawData(id)
      const ptr = smw.getLevelSpritePointer(id)
      if (!l1 || l1.length < 5 || ptr === null) continue
      const offset = smw.rom.fileOffsetOf(ptr)
      const data = smw.rom.readAt(ptr, 0x200)
      if (offset === null || !data) continue
      const isVertical = isLevelModeVertical(parseLevelHeader(l1).levelMode, verticalTable)
      const sprites = parseLevelSprites(data, isVertical)
      // Needs a sprite whose X nibble can move right without leaving its screen.
      const byteIndex = isVertical ? 0 : 1
      if (!sprites.some(s => ((s.raw[byteIndex] >> 4) & 0x0f) < 0x0f)) continue
      out.push({ id, raw: data, sprites, spriteOffset: offset, isVertical })
    }
    return out
  }

  it('finds enough levels with movable sprites to be worth sweeping', () => {
    expect(movableLevels(rom(), 12).length).toBeGreaterThanOrEqual(12)
  })

  it('moves a sprite and the ROM parses it at the new position, across 12 levels', () => {
    const smw = rom()
    const levels = movableLevels(smw, 12)
    const base = new Uint8Array(smw.rom.buffer)

    for (const lv of levels) {
      const byteIndex = lv.isVertical ? 0 : 1
      const i = lv.sprites.findIndex(s => ((s.raw[byteIndex] >> 4) & 0x0f) < 0x0f)
      const before = lv.sprites[i]

      const layer = moveSpriteX(lv.raw, lv.spriteOffset, i, 1, lv.isVertical)
      const patched = applyPatches(base, layer.patches)

      const reread = new SmwRom(RomFile.fromBytes(ROM_PATH, patched))
      const ptr = reread.getLevelSpritePointer(lv.id)!
      const after = parseLevelSprites(reread.rom.readAt(ptr, 0x200)!, lv.isVertical)[i]

      expect(after.spriteId, `level $${lv.id.toString(16)} sprite id changed`).toBe(before.spriteId)
      expect(after.screen, `level $${lv.id.toString(16)} sprite changed screen`).toBe(before.screen)
      expect(after.y, `level $${lv.id.toString(16)} sprite changed row`).toBe(before.y)
      expect(after.x, `level $${lv.id.toString(16)} sprite did not move`).toBe(before.x + 1)
    }
  })

  /**
   * Why a layer is frozen at edit time rather than re-derived from the base.
   *
   * Two "move one tile right" edits must move the sprite two tiles. Deriving
   * both against the BASE computes the same destination twice, and flattening
   * them moves it one. That is the bug this asserts against, and it is the
   * reason EditSession patches the current state and stores the bytes.
   */
  it('a second edit builds on the first, not on the base', () => {
    const smw = rom()
    const lv = movableLevels(smw, 1)[0]
    const base = new Uint8Array(smw.rom.buffer)
    const byteIndex = lv.isVertical ? 0 : 1
    const i = lv.sprites.findIndex(s => ((s.raw[byteIndex] >> 4) & 0x0f) < 0x0e)
    const startX = lv.sprites[i].x

    const spritesOf = (bytes: Uint8Array) => {
      const r = new SmwRom(RomFile.fromBytes(ROM_PATH, bytes))
      return parseLevelSprites(r.rom.readAt(r.getLevelSpritePointer(lv.id)!, 0x200)!, lv.isVertical)
    }
    const rawOf = (bytes: Uint8Array) => {
      const r = new SmwRom(RomFile.fromBytes(ROM_PATH, bytes))
      return r.rom.readAt(r.getLevelSpritePointer(lv.id)!, 0x200)!
    }

    // Correct: each layer derived against the state it applies to.
    const one = build(base, [moveSpriteX(lv.raw, lv.spriteOffset, i, 1, lv.isVertical, 'a')])
    const two = build(one, [moveSpriteX(rawOf(one), lv.spriteOffset, i, 1, lv.isVertical, 'b')])
    expect(spritesOf(one)[i].x).toBe(startX + 1)
    expect(spritesOf(two)[i].x).toBe(startX + 2)

    // Wrong: both derived from the base. Same byte, same value, one tile.
    const bothFromBase = build(base, [
      moveSpriteX(lv.raw, lv.spriteOffset, i, 1, lv.isVertical, 'a'),
      moveSpriteX(lv.raw, lv.spriteOffset, i, 1, lv.isVertical, 'b'),
    ])
    expect(spritesOf(bothFromBase)[i].x).toBe(startX + 1)
  })

  it('dropping the top layer rebuilds the state before it', () => {
    const smw = rom()
    const lv = movableLevels(smw, 1)[0]
    const base = new Uint8Array(smw.rom.buffer)
    const byteIndex = lv.isVertical ? 0 : 1
    const i = lv.sprites.findIndex(s => ((s.raw[byteIndex] >> 4) & 0x0f) < 0x0e)
    const a = moveSpriteX(lv.raw, lv.spriteOffset, i, 1, lv.isVertical, 'a')
    const one = build(base, [a])
    const rawOne = new SmwRom(RomFile.fromBytes(ROM_PATH, one))
    const b = moveSpriteX(
      rawOne.rom.readAt(rawOne.getLevelSpritePointer(lv.id)!, 0x200)!,
      lv.spriteOffset,
      i,
      1,
      lv.isVertical,
      'b',
    )

    expect(build(base, [a, b])).not.toEqual(one)
    expect(build(base, [a])).toEqual(one) // undo is dropping b, not inverting it
  })

  it('an object edit reaches the ROM too', () => {
    const smw = rom()
    const id = 0x105
    const raw = smw.getLevelRawData(id)!
    const off = smw.rom.fileOffsetOf(smw.getLevelL1Pointer(id)!)!
    const layer = moveObjectX(raw, off, 0, 1, smw.requireVerticalTable())
    const patched = applyPatches(new Uint8Array(smw.rom.buffer), layer.patches)
    expect(patched[layer.patches[0].offset]).not.toBe(smw.rom.buffer[layer.patches[0].offset])
  })

  it('a layer survives a round trip through a real IPS file', () => {
    const smw = rom()
    const lv = movableLevels(smw, 1)[0]
    const base = new Uint8Array(smw.rom.buffer)
    const byteIndex = lv.isVertical ? 0 : 1
    const i = lv.sprites.findIndex(s => ((s.raw[byteIndex] >> 4) & 0x0f) < 0x0f)
    const layer = moveSpriteX(lv.raw, lv.spriteOffset, i, 1, lv.isVertical)

    const throughFile = decodeIps(encodeIps(layer.patches))
    expect(throughFile).not.toBeNull()
    expect(applyPatches(base, throughFile!)).toEqual(applyPatches(base, layer.patches))
  })

  it('preview-scope layers are excluded from an export', () => {
    const smw = rom()
    const lv = movableLevels(smw, 1)[0]
    const byteIndex = lv.isVertical ? 0 : 1
    const i = lv.sprites.findIndex(s => ((s.raw[byteIndex] >> 4) & 0x0f) < 0x0f)
    const edit = moveSpriteX(lv.raw, lv.spriteOffset, i, 1, lv.isVertical)
    const preview = {
      id: 'demo-freeze',
      label: 'freeze',
      scope: 'preview' as const,
      patches: [{ offset: 0x1c1f, value: 0 }],
    }

    expect(flatten([edit, preview])).toHaveLength(2)
    expect(exportable([edit, preview])).toEqual([edit])
  })
})

/**
 * The patched ROM the editor renders from has to be usable by the host-side
 * readers, not just parseable.
 *
 * RomFile.buffer is TYPE-ASSERTED as a Buffer while it may hold a plain
 * Uint8Array, and host readers call Buffer-only methods on it. Handing them a
 * Uint8Array throws inside buildMapPayload, whose catch keeps the PREVIOUS
 * model: the level's tiles updated and its sprites did not, so a deleted
 * sprite stayed on screen while the emulator showed it gone.
 */
describe.skipIf(!hasRom(VANILLA))('a patched ROM renders', () => {
  const LEVEL = 0x001

  function patched(bytes: Uint8Array): SmwRom {
    return new SmwRom(RomFile.fromBytes(ROM_PATH, Buffer.from(bytes)))
  }

  it('builds a map payload after an edit, with one fewer sprite', () => {
    const smw = SmwRom.open(ROM_PATH)
    const ptr = smw.getLevelSpritePointer(LEVEL)!
    const raw = smw.rom.readAt(ptr, 0x200)!
    const before = buildMapPayload(smw, LEVEL, {}).sprites.length

    const layer = deleteSprite(raw, smw.rom.fileOffsetOf(ptr)!, 0)
    const after = buildMapPayload(
      patched(build(new Uint8Array(smw.rom.buffer), [layer])),
      LEVEL,
      {},
    )

    expect(after.sprites.length).toBe(before - 1)
  })

  it('throws when handed a raw Uint8Array, which is why Buffer.from is required', () => {
    const smw = SmwRom.open(ROM_PATH)
    const bytes = new Uint8Array(smw.rom.buffer)
    const asUint8 = new SmwRom(RomFile.fromBytes(ROM_PATH, bytes))
    // Guards the fix: if this ever stops throwing, RomFile has been made safe
    // for Uint8Array and the Buffer.from calls can go.
    expect(() => buildMapPayload(asUint8, LEVEL, {})).toThrow()
  })
})

/**
 * The sharing hazard that makes the editor's warning necessary.
 *
 * If this ever reports zero, the guard in MapEditorProvider looks like dead
 * weight and someone will delete it. It is not: sprite data is reached by a
 * per-level pointer and those pointers are not all distinct, so patching a
 * stream in place edits every level pointing at it.
 */
describe.skipIf(!hasRom(VANILLA))('shared sprite data', () => {
  it('multiple real levels share one sprite pointer in the vanilla cart', () => {
    const smw = SmwRom.open(ROM_PATH)
    const byPtr = new Map<number, number[]>()
    for (let id = 0; id < 0x200; id++) {
      const ptr = smw.getLevelSpritePointer(id)
      const l1 = smw.getLevelRawData(id)
      // Only levels that actually render something can be harmed.
      if (ptr === null || !l1 || l1.length <= 5 || l1[5] === 0xff) continue
      byPtr.set(ptr, [...(byPtr.get(ptr) ?? []), id])
    }
    const shared = [...byPtr.values()].filter(ids => ids.length > 1)
    expect(shared.length).toBeGreaterThan(0)
    // The worst case is well past two, so the warning has to name a list.
    expect(Math.max(...shared.map(s => s.length))).toBeGreaterThanOrEqual(6)
  })
})
