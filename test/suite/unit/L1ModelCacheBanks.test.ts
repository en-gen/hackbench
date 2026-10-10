/**
 * The map model cache hands the project's data banks to the RomFile it builds
 * a model from, and rebuilds when they change (#755).
 */
import { describe, it, expect } from 'vitest'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import type { DataBanks } from '../../../src/rom/DataBanks'
import type { SwitchFlagsDto } from '../../../theia/extension/src/common/project-protocol'

const FLAGS = {} as SwitchFlagsDto

function spy() {
  const seen: (DataBanks | undefined)[] = []
  const cache = new L1ModelCache(rom => {
    seen.push(rom.rom.dataBanks)
    return { ok: false, reason: 'spy' }
  })
  return { cache, seen }
}
/** A cart SmwRom accepts: LoROM map mode byte set. */
const blank = (): Uint8Array => Object.assign(new Uint8Array(0x80000), { 0x7fd5: 0x20 })
const banks = (bank: number): DataBanks => ({ objectCode: { bank } })

describe('L1ModelCache data banks', () => {
  it('builds with the banks given for those bytes, and without them when none were given', () => {
    const { cache, seen } = spy()
    const a = blank()
    cache.get(a, 'x.sfc', 1, FLAGS)
    const b = blank()
    cache.useBanks(b, banks(0x0e))
    cache.get(b, 'x.sfc', 1, FLAGS)
    expect(seen).toEqual([undefined, banks(0x0e)])
  })

  it('drops the models of the same bytes when the banks change, and keeps them when they do not', () => {
    const { cache, seen } = spy()
    const a = blank()
    cache.useBanks(a, banks(0x0d))
    cache.get(a, 'x.sfc', 1, FLAGS)
    cache.useBanks(a, banks(0x0d))
    cache.get(a, 'x.sfc', 1, FLAGS)
    expect(seen).toHaveLength(1)
    cache.useBanks(a, banks(0x2d))
    cache.get(a, 'x.sfc', 1, FLAGS)
    expect(seen).toEqual([banks(0x0d), banks(0x2d)])
  })

  it('drops a model built before any banks were registered when the first banks arrive', () => {
    const { cache, seen } = spy()
    const a = blank()
    cache.get(a, 'x.sfc', 1, FLAGS)
    cache.useBanks(a, banks(0x2d))
    cache.get(a, 'x.sfc', 1, FLAGS)
    expect(seen).toEqual([undefined, banks(0x2d)])
  })
})
