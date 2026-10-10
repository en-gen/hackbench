/**
 * The two #519/#762 ports must not refuse on the vanilla and magic ROMs: a
 * pinned offset or byte copied wrong from SMWDisX (bank_0D.asm:4385-4411,
 * 4933-4975) would refuse there and pass every synthetic test, since those
 * plant the same wrong value they check for.
 */
import { describe, it, expect } from 'vitest'
import { createGrid } from '../../../src/rom/ObjectExpander'
import { makeCursor, TileGrid, Cursor } from '../../../src/rom/objectHandlers/cursor'
import { handle_0DBA4C, staircaseVariantB } from '../../../src/rom/objectHandlers/standardHandlers'
import { freshRom, hasRom, MAGIC, VANILLA } from '../support/corpus'

const ROMS = [VANILLA, MAGIC] as const

function run(name: string, h: (c: Cursor) => void, addr: number, size: number) {
  const grid: TileGrid = createGrid(3)
  const cur = makeCursor(grid, freshRom(name), 0, 16, 2, 0x34, size)
  cur.handlerAddr = addr
  const unverified: string[] = []
  cur.draw = { vertical: false, unverified, primitives: [], draw: () => false }
  h(cur)
  return { grid, unverified }
}

// Gated per ROM, not on the pair, so a machine with only one still runs its checks.
for (const name of ROMS) {
  describe.skipIf(!hasRom(name))(`the #519/#762 ports draw on ${name}`, () => {
    it.each([
      ['0DBA4C', handle_0DBA4C, 0x0dba4c, 0x12],
      ['0DC3D8', staircaseVariantB, 0x0dc3d8, 0x21],
    ] as const)('%s refuses nothing and draws', (_n, handler, addr, size) => {
      const { grid, unverified } = run(name, handler, addr, size)
      expect(unverified).toEqual([])
      expect(grid).not.toEqual(createGrid(3))
    })
  })
}
