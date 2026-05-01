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
import { PSwitchRevealBehavior } from '../../../../src/rom/model/tiles/behaviors/PSwitchRevealBehavior'
import { editorStore, resetEditorStore } from '../fixtures/stores'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

function makeQuad(tag: number): SubtileQuad {
  const sub = () =>
    new SubTile(
      new Char(tag, new StaticPixelsBehavior(new Uint8Array(64))),
      0,
      false,
      false,
      false,
    )
  return [sub(), sub(), sub(), sub()]
}

describe('PSwitchRevealBehavior behavior', () => {
  beforeEach(resetEditorStore)

  it('returns the revealed quad regardless of P-switch state', () => {
    const quad = makeQuad(1)
    const b = new PSwitchRevealBehavior(quad)
    editorStore.setPSwitch(false)
    expect(b.selectQuad()).toBe(quad)
    editorStore.setPSwitch(true)
    expect(b.selectQuad()).toBe(quad)
  })

  it('selectAlpha returns offAlpha when P-switch inactive', () => {
    const b = new PSwitchRevealBehavior(makeQuad(1), 0.5)
    editorStore.setPSwitch(false)
    expect(b.selectAlpha()).toBe(0.5)
  })

  it('selectAlpha returns 1 when P-switch active', () => {
    const b = new PSwitchRevealBehavior(makeQuad(1), 0.5)
    editorStore.setPSwitch(true)
    expect(b.selectAlpha()).toBe(1)
  })

  it('respects a custom offAlpha override', () => {
    const b = new PSwitchRevealBehavior(makeQuad(1), 0.25)
    editorStore.setPSwitch(false)
    expect(b.selectAlpha()).toBe(0.25)
    editorStore.setPSwitch(true)
    expect(b.selectAlpha()).toBe(1)
  })

  it('alpha is reactive to editorStore.pSwitchActive changes', () => {
    const b = new PSwitchRevealBehavior(makeQuad(1))
    editorStore.setPSwitch(false)
    const a = computed(() => b.selectAlpha())
    expect(a.value).toBe(0.5)
    editorStore.setPSwitch(true)
    expect(a.value).toBe(1)
    editorStore.setPSwitch(false)
    expect(a.value).toBe(0.5)
  })
})

describe.skipIf(!existsSync(ROM_PATH))('TileFactory P-switch reveal wiring (vanilla ROM)', () => {
  it('$27/$28/$29/$2A all wear PSwitchRevealBehavior', () => {
    // $27/$28/$29 are strict ports of `CODE_00F545`. $2A is included as
    // an editor-UX inclusion: its native Map16 visual is transparent in
    // many tilesets, but vanilla level data uses it for "hidden coin"
    // arrow patterns the designer needs to see — so we substitute the
    // $2B coin artwork at 50% opacity (full opacity when the editor's
    // blue P-switch toggle is on). The tile retains its $2A identity in
    // the level grid; only the rendered visual changes.
    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const chars = buildChars(vram)
    const tiles = buildTiles(rom.rom, header.objectTileset, chars)

    for (const id of [0x27, 0x28, 0x29, 0x2A]) {
      const tile = tiles.get(id)
      expect(tile, `tile $${id.toString(16)}`).toBeInstanceOf(Tile)
      expect(tile!.behavior, `behavior of $${id.toString(16)}`).toBeInstanceOf(PSwitchRevealBehavior)
      expect(tile!.id, `id of $${id.toString(16)}`).toBe(id)
    }
  })

  it('silver doors ($27/$28) use palette 4 override', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0x105)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const chars = buildChars(vram)
    const tiles = buildTiles(rom.rom, header.objectTileset, chars)

    for (const id of [0x27, 0x28]) {
      const behavior = tiles.get(id)!.behavior as PSwitchRevealBehavior
      for (const sub of behavior.revealedQuad) {
        expect(sub.palette, `subtile palette in $${id.toString(16)}`).toBe(4)
      }
    }
  })
})
