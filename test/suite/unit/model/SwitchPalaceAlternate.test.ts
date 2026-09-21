import { describe, it, expect, beforeEach } from 'vitest'
import { computed } from '@vue/reactivity'
import { existsSync } from 'fs'
import { loadVram } from '../../../../src/rom/GfxLoader'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { Tile, type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { buildTiles } from '../../../../src/rom/model/tiles/TileFactory'
import { SwitchPalaceAlternateBehavior } from '../../../../src/rom/model/tiles/behaviors/SwitchPalaceAlternateBehavior'
import { editorStore, resetEditorStore } from '../fixtures/stores'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

function setSwitches(state: readonly [boolean, boolean, boolean, boolean]): void {
  for (let c = 0; c < 4; c++) editorStore.setSwitchPalace(c as 0 | 1 | 2 | 3, state[c])
}

function makeQuad(tag: number): SubtileQuad {
  const sub = () =>
    new SubTile(new Char(tag, new StaticPixelsBehavior(new Uint8Array(64))), 0, false, false, false)
  return [sub(), sub(), sub(), sub()]
}

describe('SwitchPalaceAlternateBehavior behavior', () => {
  beforeEach(resetEditorStore)

  it('returns the off quad when the color slot is false', () => {
    const off = makeQuad(1)
    const on = makeQuad(2)
    const b = new SwitchPalaceAlternateBehavior(off, on, 0)
    setSwitches([false, false, false, false])
    expect(b.selectQuad()).toBe(off)
  })

  it('returns the on quad when the color slot is true', () => {
    const off = makeQuad(1)
    const on = makeQuad(2)
    const b = new SwitchPalaceAlternateBehavior(off, on, 2)
    setSwitches([false, false, true, false])
    expect(b.selectQuad()).toBe(on)
  })

  it('reads only the specific color slot, not others', () => {
    const off = makeQuad(1)
    const on = makeQuad(2)
    const b = new SwitchPalaceAlternateBehavior(off, on, 1) // green
    // yellow + red + blue on, green off → still returns off
    setSwitches([true, false, true, true])
    expect(b.selectQuad()).toBe(off)
  })

  it('computed() invalidates only when switchPalaceState changes', () => {
    const off = makeQuad(1)
    const on = makeQuad(2)
    const b = new SwitchPalaceAlternateBehavior(off, on, 0)
    setSwitches([false, false, false, false])
    const reactive = computed(() => b.selectQuad())

    expect(reactive.value).toBe(off)

    editorStore.setPalAnimFrame(5)
    expect(reactive.value).toBe(off) // unrelated; cached

    editorStore.setSwitchPalace(0, true)
    expect(reactive.value).toBe(on)
  })
})

describe.skipIf(!existsSync(ROM_PATH))('TileFactory switch-palace wiring (vanilla ROM)', () => {
  beforeEach(resetEditorStore)

  it('$06A-$06D and $16A-$16D all wear SwitchPalaceAlternateBehavior', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const chars = buildChars(vram)
    const tiles = buildTiles(rom.rom, header.objectTileset, chars)

    for (let c = 0; c < 4; c++) {
      const off = tiles.get(0x06a + c)!
      const on = tiles.get(0x16a + c)!
      expect(off, `off $${(0x06a + c).toString(16)}`).toBeInstanceOf(Tile)
      expect(on, `on $${(0x16a + c).toString(16)}`).toBeInstanceOf(Tile)
      expect(off.behavior).toBeInstanceOf(SwitchPalaceAlternateBehavior)
      expect(on.behavior).toBeInstanceOf(SwitchPalaceAlternateBehavior)
    }

    // With color 0 set, $06A and $16A both select the "on" quad
    setSwitches([true, false, false, false])
    const off06A = tiles.get(0x06a)!
    const on16A = tiles.get(0x16a)!
    const q1 = off06A.behavior as SwitchPalaceAlternateBehavior
    const q2 = on16A.behavior as SwitchPalaceAlternateBehavior
    expect(q1.selectQuad()).toBe(q1.on)
    expect(q2.selectQuad()).toBe(q2.on)
  })
})
