/**
 * The content index reaches the spawn (#566): inside `romArt`, a sprite item's `index` (the resolver's
 * SpriteInBlock index) and its block's position become the inputs the game's spawn is run with. The runner and the
 * interpreter drawer are replaced by recorders, so no ROM is needed and what is asserted is the wiring only.
 */
import { describe, expect, it, vi } from 'vitest'

const drawn: number[] = []
const calls: { id: number; slot: number; inputs: Record<number, number> | undefined }[] = []

vi.mock('../../../src/rom/sprites/interp/SpriteRunner', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/rom/sprites/interp/SpriteRunner')>()),
  runOnce: (
    _rom: unknown,
    id: number,
    seed: { slot: number },
    opts: { spawn?: { inputs: Record<number, number> } },
  ) => {
    calls.push({ id, slot: seed.slot, inputs: opts.spawn?.inputs })
    return { id, passes: [], dependsOn: [], steps: [], refusal: 'recorded' }
  },
}))
vi.mock('../../../theia/extension/src/node/map-sprites', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../theia/extension/src/node/map-sprites')>()),
  // The drawer the real one would build: runs the caller's `run` once per sprite, as `interpDrawer` does.
  interpDrawer:
    (
      _rom: unknown,
      _index: number,
      _model: unknown,
      run: (r: unknown, id: number, s: { slot: number }) => unknown,
    ) =>
    (s: { spriteId: number; index: number }) => {
      drawn.push(s.index)
      run(_rom, s.spriteId, { slot: 7 })
      return { ok: false, reason: 'refused: recorded' }
    },
}))

import { romArt } from '../../../theia/extension/src/node/map-block-contents'

describe('romArt hands the spawn its inputs', () => {
  const model = { vram: {}, colors: [] } as never
  const item = (index: number, sprite = 0x74) => ({
    kind: 'sprite' as const,
    sprite,
    index,
    status: 8,
    label: '',
  })

  it('seeds the content index from the item, and the block position from its cell', () => {
    calls.length = 0
    romArt({} as never, 0x105, model).sprite(item(9), 0x12, 5)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputs).toMatchObject({ 0x05: 9, 0x9a: 0x20, 0x9b: 0x01, 0x98: 80, 0x99: 0 })
  })

  it('follows the item: another index, another cell, another input', () => {
    calls.length = 0
    const art = romArt({} as never, 0x105, model)
    art.sprite(item(3), 1, 1)
    art.sprite(item(11, 0x80), 2, 3)
    expect(calls.map(c => [c.inputs![0x05], c.inputs![0x9a], c.inputs![0x98]])).toEqual([
      [3, 16, 16],
      [11, 32, 48],
    ])
  })

  it('never hands the drawer a list index: a block-spawned sprite must not read an unrelated SpriteLoadStatus entry', () => {
    // Index 0 would read list entry 0's status ($1938) and could take the start-of-level screen-fixed placement.
    drawn.length = 0
    romArt({} as never, 0x105, model).sprite(item(1), 0, 0)
    expect(drawn).toEqual([-1])
  })

  it('runs the spawn in the machine slot the caller names, not the seed the drawer was handed', () => {
    calls.length = 0
    romArt({} as never, 0x105, model).sprite(item(1), 0, 0)
    expect(calls[0]!.slot).toBe(0)
    expect(calls[0]!.inputs).toBeDefined()
  })
})
