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

const LOADERS = ['lead', 'jump', 'callsite', 'pointers', 'entrance', 'data', 'scroll', 'update', 'scrollTail', 'updateTail', 'updateOperand', 'scrollRtl', 'updateRts', 'scrollPop'] as const // prettier-ignore

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
 * Windows this gate still allows, each a small region of the cart where a runner or reader shape in src/ fixes the
 * game's own bytes, or this fixture keeps the game's semantics (its operand choice is the cost of the test, not
 * of the reader). `hits` is the exact number of windows whose first byte is in the region (SNES addresses, bank << 16 | addr), at most over the variants:
 * a count that rises or drops fails until it is updated here, and a region that no longer hits must be deleted.
 * A region spans at most MAX_SPAN bytes. Removing one needs the reader to recognize the code by fingerprint
 * instead (the way CastleFlames.ts and SubmapFlagGate.ts do).
 */
interface Region {
  from: number
  to: number
  hits: number
  why: string
}
const MAX_SPAN = 0x40
const ALLOWED: Region[] = [
  { from: 0x02a8ac, to: 0x02a8ac, hits: 1, why: 'ShellSprites.ts PATH: the generator floor compare and its fixed branch; the compare operands have the vanilla values, chosen so the shell logic keeps its vanilla meaning' }, // prettier-ignore
  { from: 0x02a97c, to: 0x02a97c, hits: 1, why: 'ShellSprites.ts PATH: the status compare and the number step; operand values chosen as the vanilla ones' }, // prettier-ignore
  // Owned by the Golf Team (LevelLoader, GM11 spans, OverworldAreas): their cleanup removes these.
  { from: 0x0096f4, to: 0x009720, hits: 21, why: 'GM11 call sites (LevelLoader.ts): Golf Team' },
  { from: 0x00a633, to: 0x00a648, hits: 7, why: 'Mario entrance setup (LevelLoader.ts): Golf Team' },
  { from: 0x00f6d5, to: 0x00f6e8, hits: 10, why: 'UpdateScreenPosition (LevelLoader.ts): Golf Team' },
  { from: 0x05d790, to: 0x05d7c0, hits: 24, why: 'CODE_05D796 prologue (LevelLoader.ts): Golf Team' },
] // prettier-ignore

/** What is wrong with `regions` given the hits (SNES addresses as numbers, the form `ALLOWED` uses) each variant produced; empty when it holds. */
export function allowListProblems(
  regions: readonly Region[],
  hitsByVariant: readonly number[][],
): string[] {
  const out: string[] = []
  for (const r of regions) {
    if (r.to - r.from + 1 > MAX_SPAN) out.push(`${r.why}: spans more than ${MAX_SPAN} bytes`)
    const most = Math.max(
      0,
      ...hitsByVariant.map(h => h.filter(o => o >= r.from && o <= r.to).length),
    )
    if (most !== r.hits) out.push(`${r.why}: ${most} hits, listed as ${r.hits}`)
  }
  return out
}

/** The SNES address of a "$BB:AAAA" string as a number (bank << 16 | addr), the form `ALLOWED` uses. NOT a file offset. */
const snesNumber = (h: string): number => {
  const [bank, addr] = h
    .slice(1)
    .split(':')
    .map(x => parseInt(x, 16)) as [number, number]
  return (bank << 16) | addr
}
const allowed = (h: string) => ALLOWED.find(r => snesNumber(h) >= r.from && snesNumber(h) <= r.to)

describe('the allow list checker', () => {
  const region = { from: 0x1000, to: 0x1010, hits: 2, why: 'r' }
  it('passes when the count matches', () => {
    expect(allowListProblems([region], [[0x1000, 0x1005], [0x1000]])).toEqual([])
  })
  it('planted: a region with no hits is red', () => {
    expect(allowListProblems([{ ...region, hits: 2 }], [[0x2000]])).toEqual([
      'r: 0 hits, listed as 2',
    ])
  })
  it('planted: a count that rises or drops is red', () => {
    expect(allowListProblems([region], [[0x1000, 0x1001, 0x1002]])).toEqual([
      'r: 3 hits, listed as 2',
    ])
    expect(allowListProblems([region], [[0x1000]])).toEqual(['r: 1 hits, listed as 2'])
  })
  it('planted: a region widened past MAX_SPAN is red', () => {
    expect(allowListProblems([{ ...region, to: 0x0fffff }], [[0x1000, 0x1005]])).toEqual([
      'r: spans more than 64 bytes',
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

    it('planted: 8 vanilla bytes written into a blank cart are flagged at that offset, and not allowed', () => {
      const v = loadVanillaBytes(romPath(VANILLA))
      const cart = new Uint8Array(8 * 0x8000)
      const real = v.subarray(0x14000, 0x14000 + WINDOW)
      expect(new Set(real).size).toBeGreaterThanOrEqual(3)
      cart.set(real, 0x14000)
      expect(vanillaHits(cart, vanilla())).toContain(snesOf(0x14000))
      expect(allowed(snesOf(0x14000))).toBeUndefined()
    })

    it.each(VARIANTS)('%s: every vanilla window of it is in an allowed region', (_, opts) => {
      expect(summarize(hitsOf(opts).filter(h => !allowed(h)))).toEqual([])
    })

    it('the allow list is bounded and every region hits exactly as often as listed (ratchet)', () => {
      expect(
        allowListProblems(
          ALLOWED,
          VARIANTS.map(([, o]) => hitsOf(o).map(snesNumber)),
        ),
      ).toEqual([])
    }, 60_000)
  },
)
