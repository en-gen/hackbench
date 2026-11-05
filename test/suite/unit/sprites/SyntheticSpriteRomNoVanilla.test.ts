/**
 * ROM-byte clean-up (CastleFlames): the synthetic sprite cart carries no vanilla SMW bytes. Every cart
 * `buildSyntheticRom` can produce (the default, plus each option on its own) is scanned for an 8-byte
 * window (3+ distinct values) that occurs anywhere in the vanilla ROM; each hit is reported as an SNES
 * address. Needs the vanilla ROM, so it is gated on it; CI without a cart runs only the planted block's
 * synthetic half (the checker's behaviour on a hand-made window).
 */
import { describe, expect, it } from 'vitest'
import { hasRom, romPath, VANILLA } from '../../support/corpus'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'
import {
  loadVanillaBytes,
  snesOf,
  summarize,
  vanillaHits,
  windowSet,
  WINDOW,
} from '../../support/vanillaWindows'

const LOADERS = ['lead', 'jump', 'callsite', 'pointers', 'entrance', 'data', 'scroll', 'update', 'scrollTail', 'updateTail', 'updateOperand', 'scrollRtl', 'updateRts', 'scrollPop', 'layer3', 'gm12', 'gm12Bpl', 'gm12Jsr', 'reset'] as const // prettier-ignore

/** Every option on its own, and the default. A defect option changes a few bytes of the default's regions. */
export const VARIANTS: [string, SyntheticOptions][] = [
  ['default', {}],
  ['initShift', { initShift: 0x31 }],
  ['noTileWrite', { noTileWrite: true }],
  ['badLoop', { badLoop: true }],
  ['dupLoop', { dupLoop: true }],
  ['badExecutePtr', { badExecutePtr: true }],
  ['badDispatch', { badDispatch: true }],
  ['badInitTables', { badInitTables: true }],
  ['badGetRand', { badGetRand: true }],
  ['fastRomGetRand', { fastRomGetRand: true }],
  ...LOADERS.map((k): [string, SyntheticOptions] => [`badLoader ${k}`, { badLoader: k }]),
  ...(['jml', 'loop', 'rts'] as const).map((k): [string, SyntheticOptions] => [`updateHook ${k}`, { updateHook: k }]), // prettier-ignore
  ['loaderCop', { loaderCop: true }],
  ...(['head', 'status', 'dispatch'] as const).map((k): [string, SyntheticOptions] => [`badSpawn ${k}`, { badSpawn: k }]), // prettier-ignore
  ['spawnTimer', { spawnTimer: 0x44 }],
  ['spawnLoop', { spawnLoop: true }],
  ['alteredGrinder', { alteredGrinder: true }],
  ['grinderDrawsOnce', { grinderDrawsOnce: true }],
  ['grinderDrawsTwice', { grinderDrawsTwice: true }],
  ['grinderDrawsOnPass1', { grinderDrawsOnPass1: true }],
  ['grinderDrawsFromPass1', { grinderDrawsFromPass1: true }],
  ['id31IsGrinder', { id31IsGrinder: true }],
  ['initFarCull', { initFarCull: true }],
  ['mainStepsBack', { initFarCull: true, mainStepsBack: true }],
  ['grinderInitShifts', { grinderInitShifts: true }],
  ['grinderInitDelta', { grinderInitDelta: [0x123, -0x45] }],
  ['grinderAliases', { grinderAliases: true }],
  ['grinderPrelude', { grinderPrelude: true }],
  ['grinderCell At3', { grinderCell: 'At3' }],
  ['grinderCell Not3', { grinderCell: 'Not3' }],
  ['grinderLocksOnPass', { grinderLocksOnPass: 2 }],
  ['grinderWideX', { grinderWideX: true }],
  ['irqCommand', { irqCommand: 0x80 }],
  ['eeries', { eeries: {} }],
  ['eeries stream', { eeries: { stream: [0x51, 0xb3, 0xe0, 0xff] } }],
  ['eeries spacing', { eeries: { spacing: [-0x30, -0x18, 0x18, 0x30] } }],
  ['eeries room', { eeries: { room: 6 } }],
  ['eeries travel', { eeries: { travel: true } }],
]

describe('the window checker', () => {
  const vanilla = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff)
  const set = windowSet(vanilla)
  it('flags a planted vanilla window at its SNES address', () => {
    const cart = new Uint8Array(0x10000)
    cart.set(vanilla.subarray(10, 10 + WINDOW), 0x8004) // bank 1, $800C... file offset 0x8004
    expect(vanillaHits(cart, set)).toEqual([snesOf(0x8004)])
    expect(snesOf(0x8004)).toBe('$01:8004')
  })
  it('does not flag a window with fewer than 3 distinct values, or a near miss', () => {
    const flat = new Uint8Array(32)
    expect(vanillaHits(flat, windowSet(flat))).toEqual([])
    const two = new Uint8Array(32).map((_, i) => i & 1)
    expect(vanillaHits(two, windowSet(two))).toEqual([])
    const miss = Uint8Array.from(vanilla.subarray(10, 10 + WINDOW))
    miss[3] ^= 1
    expect(vanillaHits(miss, set)).toEqual([])
  })
  it('summarize joins adjacent hits into one range', () => {
    expect(summarize(['$02:8000', '$02:8001', '$02:8002', '$02:9000'])).toEqual(['$02:8000..8002 x3', '$02:9000 x1']) // prettier-ignore
  })
})

/**
 * Regions of the cart this gate would allow to hold a vanilla window. It is empty and must stay empty: a reader in
 * src/ that fixes the game's own bytes is made to run or fingerprint the code instead (the way CastleFlames.ts and
 * SubmapFlagGate.ts do), and a fixture operand is changed so the window is gone. The ratchet below needs no ROM, so
 * CI goes red the moment an entry is added.
 */
interface Region {
  from: number
  to: number
  why: string
}
export const ALLOWED: readonly Region[] = []

/** What is wrong with `regions`: any entry at all, since the list is held at empty. */
export function allowListProblems(regions: readonly Region[]): string[] {
  return regions.map(r => `${r.why}: the allow list must stay empty (#1073)`)
}

describe('the allow list ratchet', () => {
  it('the list is empty', () => {
    expect(allowListProblems(ALLOWED)).toEqual([])
  })
  it('planted: one entry makes it red', () => {
    expect(allowListProblems([{ from: 0x1000, to: 0x1000, why: 'r' }])).toEqual([
      'r: the allow list must stay empty (#1073)',
    ])
  })
})

describe.skipIf(!hasRom(VANILLA))(
  'the synthetic sprite cart holds no vanilla byte window (corpus gate)',
  () => {
    // Built inside the case: a skipped describe still runs its body.
    let cached: Set<string> | undefined
    const vanilla = () => (cached ??= windowSet(loadVanillaBytes(romPath(VANILLA))))
    const hitsOf = (opts: SyntheticOptions) =>
      vanillaHits(new Uint8Array(buildSyntheticRom(opts).buffer), vanilla())

    it('planted: 8 vanilla bytes written into a blank cart are flagged at that offset', () => {
      const v = loadVanillaBytes(romPath(VANILLA))
      const cart = new Uint8Array(8 * 0x8000)
      const real = v.subarray(0x14000, 0x14000 + WINDOW)
      expect(new Set(real).size).toBeGreaterThanOrEqual(3)
      cart.set(real, 0x14000)
      expect(vanillaHits(cart, vanilla())).toContain(snesOf(0x14000))
    })

    it.each(VARIANTS)('%s: has no vanilla window', (_, opts) => {
      expect(summarize(hitsOf(opts))).toEqual([])
    })
  },
)
