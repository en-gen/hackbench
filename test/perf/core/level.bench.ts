import { describe, it } from 'vitest'
import { parseLevelObjects, LevelObject } from '../../../src/rom/LevelParser'
import { expandMap } from '../../../src/rom/ObjectExpander'
import { RomFile } from '../../../src/rom/RomFile'
import {
  ADDR_TILESET_DISPATCH,
  ADDR_TILESET0_HANDLERS,
} from '../../../src/rom/objectHandlers/romData'
import { SYNTHETIC_VERTICAL_TABLE } from '../../suite/support/verticalTable'
import { perfCase } from '../support/perfCase'

// A repeating, valid standard-object triplet (see LevelParser.test.ts for the
// byte layout): objNo=2, x=5, y=3, settings=0x10. Not ROM content - hand-built
// per the documented byte format.
function levelBuffer(objectCount: number): Buffer {
  const objects: number[] = []
  for (let i = 0; i < objectCount; i++) objects.push(0x03, 0x25, 0x10)
  return Buffer.from([0, 0, 0, 0, 0, ...objects, 0xff])
}

describe('core.level.parseObjects', () => {
  it('synthetic-small', async () => {
    const buf = levelBuffer(10)
    await perfCase('core.level.parseObjects.synthetic-small', 'ms', 'lower', () => {
      parseLevelObjects(buf, SYNTHETIC_VERTICAL_TABLE)
    })
  })

  it('synthetic-large', async () => {
    const buf = levelBuffer(500)
    await perfCase('core.level.parseObjects.synthetic-large', 'ms', 'lower', () => {
      parseLevelObjects(buf, SYNTHETIC_VERTICAL_TABLE)
    })
  })
})

// Wires exactly one dispatchable object (tileset 0, object number 1, drawing
// tile 0x02), the same minimal path ObjectExpander.test.ts uses, so
// expandMap actually runs a handler rather than only building the empty
// grid. Not ROM content: an all-zero 4 MB buffer with the LoROM mode byte set
// and three long pointers patched in by hand.
function makeMockRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('mock.smc', buf)
  rom.writeAt(ADDR_TILESET_DISPATCH, [0x4b, 0xa4, 0x0d]) // tileset 0 -> CODE_0DA44B
  rom.writeAt(ADDR_TILESET0_HANDLERS, [0xc3, 0xa8, 0x0d]) // obj 1 -> CODE_0DA8C3
  rom.writeAt(0x0da8b4, [0x02]) // handler's tile-id operand
  return rom
}

function makeObj(x: number, y: number, screen: number): LevelObject {
  return {
    type: 'standard',
    screen,
    x,
    y,
    objectNumber: 1,
    settings: 0,
    newScreen: screen > 0,
    highCoord: false,
    raw: [0, 0, 0],
    objectType: 1,
    param: 0,
  }
}

function objectsAcross(screens: number, perScreen: number): LevelObject[] {
  const objects: LevelObject[] = []
  for (let s = 0; s < screens; s++) {
    for (let i = 0; i < perScreen; i++) objects.push(makeObj(i % 16, (i + s) % 27, s))
  }
  return objects
}

describe('core.level.objectExpand', () => {
  it('synthetic-small', async () => {
    const rom = makeMockRom()
    const objects = objectsAcross(1, 10)
    await perfCase('core.level.objectExpand.synthetic-small', 'ms', 'lower', () => {
      expandMap(objects, 1, rom, 0)
    })
  })

  it('synthetic-large', async () => {
    const rom = makeMockRom()
    const objects = objectsAcross(20, 10)
    await perfCase('core.level.objectExpand.synthetic-large', 'ms', 'lower', () => {
      expandMap(objects, 20, rom, 0)
    })
  })
})
