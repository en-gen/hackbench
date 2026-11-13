import { describe } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { SWITCH_FLAGS_UNCLEARED } from '../../../src/rom/ObjectExpander'
import { readObjectInputs } from '../../../src/rom/objects/ObjectInputs'
import { recognizeObjects } from '../../../src/rom/objects/Recognize'
import { hasRom, romPath, VANILLA } from '../../suite/support/corpus'
import { stamp, type Piece } from '../../suite/support/objectMaps'
import { perfCase } from '../support/perfCase'

// Finding Objects on a map (#1237). The synthetic case is 20 screens of platforms drawn as pieces
// (left edge, interior, right edge); the corpus cases are the largest vanilla maps, with a
// definition derived from its own pieces. Both are gated with describe.skipIf or need no ROM.
const [TL, WL, TR, WR, FTOP, DIRT] = [11, 12, 13, 14, 15, 16]

function platforms(count: number): Piece[] {
  const pieces: Piece[] = []
  for (let k = 0; k < count; k++) {
    const x = 2 + (k % 20) * 15
    const y = 3 + ((k * 5) % 18)
    const w = 6 + (k % 5)
    pieces.push(
      { x, y, w: 1, h: 3, tile: (r: number) => (r === y ? TL : WL) },
      { x: x + 1, y, w: w - 2, h: 24 - y, tile: (r: number) => (r === y ? FTOP : DIRT) },
      { x: x + w - 1, y, w: 1, h: 3, tile: (r: number) => (r === y ? TR : WR) },
    )
  }
  return pieces
}

describe('core.objects.recognize', () => {
  const map = stamp(platforms(60), 20 * 16, 27)
  const definition = { id: 'p', name: 'P', tileset: 0, edge: [TL, WL, TR, WR], fill: [FTOP, DIRT] }
  perfCase('core.objects.recognize.synthetic-20-screens', () => recognizeObjects(map, [definition]))
})

// The largest vanilla maps by screens and stored pieces are $10A and $125 (32 screens); $105 is mid-size.
// `recognize` is the recognizer alone; `find` is the whole read (expand with footprint, then recognize).
for (const slot of [0x10a, 0x125, 0x105]) {
  const name = slot.toString(16)
  describe.skipIf(!hasRom(VANILLA))(`core.objects.corpus-${name}`, () => {
    // Built on first use: a skipped describe body still runs, and there is no ROM to read then.
    let ready: (() => unknown) | undefined
    const definitionOf = (inputs: { footprint: { tile: number }[]; tileset: number }) => {
      const counts = new Map<number, number>()
      for (const f of inputs.footprint) counts.set(f.tile, (counts.get(f.tile) ?? 0) + 1)
      const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t)
      return { id: 'x', name: 'X', tileset: inputs.tileset, edge: ranked.slice(1, 8), fill: ranked.slice(0, 1) } // prettier-ignore
    }
    const map = () => new SmwRom(RomFile.load(romPath(VANILLA)))
    perfCase(`core.objects.recognize.corpus-${name}`, () => {
      if (!ready) {
        const inputs = readObjectInputs(map(), slot, SWITCH_FLAGS_UNCLEARED)
        if (!inputs.ok) throw new Error(inputs.reason)
        const definition = definitionOf(inputs)
        ready = () => recognizeObjects(inputs, [definition])
      }
      return ready()
    })
    let rom: SmwRom | undefined
    perfCase(`core.objects.find.corpus-${name}`, () => {
      rom ??= map()
      const inputs = readObjectInputs(rom, slot, SWITCH_FLAGS_UNCLEARED)
      if (!inputs.ok) throw new Error(inputs.reason)
      return recognizeObjects(inputs, [definitionOf(inputs)])
    })
  })
}
