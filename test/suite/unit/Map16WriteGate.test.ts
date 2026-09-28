/**
 * The Map16 WRITE path: every decision it makes
 * (`gateQuadrantWrite` in theia/extension/src/node/map16-decode.ts).
 *
 * Nothing exercised this path before: the capacity gate, the per-layer
 * extent and the full-word mask were all unproven, with a cartridge and
 * without one.
 *
 * The gate is a PURE function rather than a method on `Map16ServiceImpl`,
 * and that is what makes these cases run in CI. The service imports
 * `@theia/core/shared/inversify`; the unit job does not install the
 * `theia/` workspace, so a test that reaches it fails to LOAD there while
 * passing on any machine that happens to have the workspace installed. An
 * earlier version of this file did exactly that, and none of its cases ever
 * ran in CI. Same shape as a safeguard proven only when the cartridge is
 * present, and the same extraction `previewId` got for the same reason.
 *
 * Every fixture is SYNTHETIC, built in the test.
 *
 * What is left on the service is the container half: resolving the working
 * copy and handing the op to `WorkingRomRegistry.setWord`. The three cases
 * at the bottom pin that wiring, and are `skipIf`-gated on the workspace so
 * they run for a developer and skip visibly in CI rather than taking the
 * whole file down with them.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { FULL_WORD_MASK } from '../../../src/rom/PaletteOp'
import { loromToOffset } from '../../../src/rom/addressing'
import { RomFile } from '../../../src/rom/RomFile'
import { MAP16_BG_TILES, MAP16_TILE_BYTES } from '../../../src/rom/Map16'
import { GFX_TILES, VRAM_CHAR_BASE } from '../../../src/rom/GfxLoader'
import { map16Stub } from '../support/syntheticMap16'
import {
  gateQuadrantWrite,
  type Map16WriteGate,
} from '../../../theia/extension/src/node/map16-decode'
import {
  MAP16_CHAR_SPACE_END,
  MAP16_TILESET_COUNT,
  Map16Field,
  Map16Layer,
} from '../../../theia/extension/src/common/map16-protocol'

/** Whether the Theia workspace is installed - see this file's doc comment. */
const theiaInstalled = existsSync(
  resolve(__dirname, '../../../theia/node_modules/@theia/core/package.json'),
)

/**
 * A 512 KB stub with the Map16 engine code planted and `pointerBytes` as the
 * fill loops' `CPX` bound (bank_05.asm:237). `null` adds a second count site
 * that disagrees, so the L1 (foreground) count is unresolvable while the L2
 * (background) table still reads 512.
 */
function stubRomBytes(pointerBytes: number | null): Uint8Array {
  return map16Stub(pointerBytes === null ? { extraCount: 0x200 } : { bgBound: pointerBytes })
}

function gate(
  bytes: Uint8Array,
  layer: Map16Layer,
  tileId: number,
  field: Map16Field = 'charNum',
  value: number = 0x12,
): Map16WriteGate {
  return gateQuadrantWrite(
    RomFile.fromBytes('stub.sfc', bytes),
    0,
    layer,
    tileId,
    'tr',
    field,
    value,
  )
}

/** The op, or a failed expectation naming the refusal. */
function writeOf(result: Map16WriteGate): { romAddr: number; oldHex: string; newHex: string } {
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error(result.reason)
  const { romAddr, oldHex, newHex } = result.write
  return { romAddr, oldHex, newHex }
}

function reasonOf(result: Map16WriteGate, status: 'unavailable' | 'refused'): string {
  expect(result.status).toBe(status)
  if (result.status !== status) throw new Error('expected a refusal')
  return result.reason
}

describe('gateQuadrantWrite: the capacity gate', () => {
  it('refuses when the cartridge fill loop cannot be resolved, rather than assuming 512', () => {
    // Gated BEFORE any address is resolved: a write landing at a guessed
    // address is worse than a refused edit.
    expect(gate(stubRomBytes(null), 'fg', 0).status).toBe('unavailable')
  })

  it('refuses when the table is larger than the loader can walk', () => {
    const reason = reasonOf(gate(stubRomBytes(0x1000), 'fg', 0), 'unavailable') // 2048 tiles
    expect(reason).toContain('2048')
    expect(reason).toContain('en-gen/hackbench#41')
  })

  it('refuses a tile id past the count this cartridge actually reports', () => {
    const reason = reasonOf(gate(stubRomBytes(0x0200), 'fg', 300), 'refused') // 256 tiles
    expect(reason).toContain('256')
  })

  it('refuses a tile id that is negative or not a whole number', () => {
    expect(gate(stubRomBytes(0x0400), 'bg', -1).status).toBe('refused')
    expect(gate(stubRomBytes(0x0400), 'bg', 1.5).status).toBe('refused')
  })
})

describe('gateQuadrantWrite: the two layers are gated separately', () => {
  // Each layer is gated on its own table.
  it('writes to the Layer 2 table on a cartridge whose FOREGROUND table is refused', () => {
    const bytes = map16Stub({}, ['slopes'])
    expect(gate(bytes, 'fg', 0).status).toBe('unavailable')

    const write = writeOf(gate(bytes, 'bg', 400, 'charNum', 0x123))
    // word 2 of the 8-byte entry is TR, column-major per Map16.ts.
    expect(write.romAddr).toBe(MAP16_BG_TILES + 400 * MAP16_TILE_BYTES + 4)
  })

  it('writes to the Layer 2 table when the FOREGROUND loop cannot be found at all', () => {
    expect(gate(stubRomBytes(null), 'bg', 0).status).toBe('ok')
  })

  it('still refuses a tile id past the Layer 2 table own extent', () => {
    // The bound is the L2 (background) fill loop's own CPX immediate.
    const reason = reasonOf(gate(stubRomBytes(0x0400), 'bg', 512), 'refused')
    expect(reason).toContain('Layer 2 preset table')
  })
})

/**
 * The RPC surface, which is the ONLY way any of these values can arrive:
 * the palette accordion offers rendered characters from loaded sheets and
 * the toggles send booleans, so every case here is about a caller that is
 * not the UI. The protocol says such a value is refused; before this it was
 * coerced, truncated, or thrown on.
 */
describe('gateQuadrantWrite: values only an RPC caller can send', () => {
  it('keeps MAP16_CHAR_SPACE_END in step with the slot bases it is derived from', () => {
    // Declared in map16-protocol.ts rather than imported from the ROM layer,
    // so this is the cross-check that stops the two drifting apart.
    expect(MAP16_CHAR_SPACE_END).toBe(VRAM_CHAR_BASE.an1 + GFX_TILES)
  })

  it('refuses a character in tilemap space, which renders as whatever sits there', () => {
    const reason = reasonOf(gate(stubRomBytes(0x0400), 'bg', 3, 'charNum', 0x2ab), 'refused')
    expect(reason).toContain('tilemap space')
    // And the last real character is still accepted, so the bound is not
    // off by one in the safe direction.
    expect(gate(stubRomBytes(0x0400), 'bg', 3, 'charNum', MAP16_CHAR_SPACE_END - 1).status).toBe(
      'ok',
    )
  })

  it('refuses a boolean for a numeric field rather than writing character 1', () => {
    // `Number(true)` is 1, a perfectly legal character, so a type check is
    // the only thing between this and a successful-looking wrong write.
    expect(gate(stubRomBytes(0x0400), 'bg', 3, 'charNum', true as never).status).toBe('refused')
  })

  it('refuses a string for a numeric field rather than coercing it', () => {
    expect(gate(stubRomBytes(0x0400), 'bg', 3, 'colorRow', '3' as never).status).toBe('refused')
  })

  it('refuses a number for a boolean field rather than taking it as truthy', () => {
    expect(gate(stubRomBytes(0x0400), 'bg', 3, 'priority', 2 as never).status).toBe('refused')
    expect(gate(stubRomBytes(0x0400), 'bg', 3, 'priority', true).status).toBe('ok')
  })

  it('refuses a field name that is not a subtile field, rather than throwing on undefined', () => {
    // The switch had no default, so this returned `undefined` and the caller
    // formatted it as a word and threw a TypeError.
    const reason = reasonOf(gate(stubRomBytes(0x0400), 'bg', 3, 'wat' as never, 1), 'refused')
    expect(reason).toContain('not a Map16 subtile field')
  })

  it('refuses a tileset outside the table rather than throwing from the address lookup', () => {
    const rom = stubRomBytes(0x0400)
    for (const tileset of [-1, MAP16_TILESET_COUNT, 1.5]) {
      const result = gateQuadrantWrite(
        RomFile.fromBytes('stub.sfc', rom),
        tileset,
        'bg',
        3,
        'tr',
        'charNum',
        0x101,
      )
      expect(result.status).toBe('refused')
    }
  })
})

describe('gateQuadrantWrite: the op it produces', () => {
  it('sends the FULL-word mask, because bit 15 is vertical flip and not a BGR555 pad', () => {
    const result = gate(stubRomBytes(0x0400), 'bg', 3, 'charNum', 0x1ff)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected an op')
    expect(result.write.mask).toBe(FULL_WORD_MASK)
    expect(result.write.mask).toBe(0xffff)
  })

  it('carries the word committed RIGHT NOW as `old`, read from the working copy', () => {
    const bytes = stubRomBytes(0x0400)
    const addr = MAP16_BG_TILES + 3 * MAP16_TILE_BYTES + 4
    const offset = loromToOffset(addr, bytes.length)!
    // A recognisable word at that address, then proof the gate reads it back
    // rather than re-encoding a decoded struct: a lossy codec would send a
    // wrong `old` and every stale check would compare the wrong thing.
    bytes[offset] = 0x34
    bytes[offset + 1] = 0x8c
    expect(RomFile.fromBytes('stub.sfc', bytes).readWord(addr)).toBe(0x8c34)

    const write = writeOf(gate(bytes, 'bg', 3, 'charNum', 0x123))
    expect(write.oldHex).toBe('$8C34')
    // charNum replaced, every other bit of $8C34 kept. Decoding it: bit 15
    // set is flipY, bit 14 clear is flipX, bit 13 CLEAR is priority, and
    // bits 12-10 are 3, the color row.
    expect(write.newHex).toBe('$8D23')
  })

  it('refuses a character wider than the field rather than producing a truncated op', () => {
    // The defect this prevents: $407 masked to $007 is a real, different
    // character, committed by an edit that reported success.
    expect(gate(stubRomBytes(0x0400), 'bg', 3, 'charNum', 0x407).status).toBe('refused')
  })

  it('refuses a color row wider than the 3-bit field', () => {
    expect(gate(stubRomBytes(0x0400), 'bg', 3, 'colorRow', 8).status).toBe('refused')
  })
})

interface Recorded {
  romAddr: number
  oldHex: string
  newHex: string
  mask?: number
}

interface FakeService {
  setQuadrantField: (...args: never[]) => Promise<{ status: string }>
}

/**
 * The container half: that the service returns the gate's refusal WITHOUT
 * writing, and hands the gate's own op to the registry when it passes.
 *
 * These three need `Map16ServiceImpl` itself, which cannot be imported
 * where the Theia workspace is absent, so they are gated on it and skip
 * visibly in CI. They are the only cases here that cannot run there, and
 * they pin WIRING rather than a decision: every decision above runs
 * everywhere.
 */
describe.skipIf(!theiaInstalled)('Map16ServiceImpl: what it does with the gate', () => {
  async function serviceOver(
    bytes: Uint8Array,
    status: 'ok' | 'rom-not-located' = 'ok',
  ): Promise<{ service: FakeService; writes: Recorded[] }> {
    const { Map16ServiceImpl } = await import('../../../theia/extension/src/node/map16-server')
    const writes: Recorded[] = []
    const entry = {
      status: 'ok',
      romPath: 'stub.sfc',
      project: {},
      working: { bytes: () => bytes, onDidChange: () => undefined },
    }
    const registry = {
      get: () =>
        status === 'ok' ? entry : { status: 'rom-not-located', baseRom: { title: 'STUB' } },
      setWord: (_manifest: string, request: Recorded) => {
        writes.push(request)
        // Non-ok on purpose: the service returns this without reloading, so
        // the recorded op is observable with no decodable cart behind it.
        return { status: 'stale', reason: 'fake registry: write observed, not committed' }
      },
    }
    const service = new Map16ServiceImpl()
    // Property injection, so the field is simply assigned. Constructing the
    // class directly keeps this a unit test rather than a container test.
    ;(service as unknown as { workingRoms: unknown }).workingRoms = registry
    return { service: service as unknown as FakeService, writes }
  }

  function call(
    service: FakeService,
    layer: Map16Layer,
    tileId: number,
    value = 0x12,
  ): Promise<{ status: string }> {
    return service.setQuadrantField(
      ...([
        'C:/projects/stub/hackbench.json',
        0,
        layer,
        { bg: 0, fg: 0 },
        tileId,
        'tr',
        'charNum',
        value,
      ] as never[]),
    )
  }

  it('returns a gate refusal without touching the registry', async () => {
    const { service, writes } = await serviceOver(stubRomBytes(null))
    expect((await call(service, 'fg', 0)).status).toBe('unavailable')
    expect(writes).toHaveLength(0)
  })

  it('hands the gate own op to the registry when the gate passes', async () => {
    const { service, writes } = await serviceOver(stubRomBytes(0x0400))
    await call(service, 'bg', 400, 0x123)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.romAddr).toBe(MAP16_BG_TILES + 400 * MAP16_TILE_BYTES + 4)
    expect(writes[0]!.mask).toBe(FULL_WORD_MASK)
  })

  it('passes a rom-not-located project straight through without writing', async () => {
    const { service, writes } = await serviceOver(stubRomBytes(0x0400), 'rom-not-located')
    expect((await call(service, 'fg', 0)).status).toBe('rom-not-located')
    expect(writes).toHaveLength(0)
  })
})
