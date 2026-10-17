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
 * Windows this gate still allows, each a region of the cart where a runner or reader shape in src/ fixes the
 * game's own opcodes (or operands this fixture cannot move), so a window there is the SHAPE, not copied code.
 * Removing one needs the reader to recognize the code by fingerprint instead (the way CastleFlames.ts and
 * SubmapFlagGate.ts do). A region that no longer hits in any variant fails the ratchet below: delete it.
 */
const ALLOWED: { from: number; to: number; why: string }[] = [
  { from: 0x0086fa, to: 0x008715, why: 'EXECUTE_PTR_SHAPE (SpriteDispatch.ts): 9 fixed opcodes in a row' },
  { from: 0x01808c, to: 0x0180b0, why: 'resolveLoop core (SpriteDispatch.ts): the countdown, its JSR to HandleSprite, ca 10 f4' },
  { from: 0x018170, to: 0x018170, why: 'resolveTables CallSpriteInit shape: 8 fixed opcodes' },
  { from: 0x019200, to: 0x019210, why: 'LineGuided.ts ENTRY: 11 fixed opcodes of the grinder handler' },
  { from: 0x019500, to: 0x019510, why: 'the same shape (id 31 pointing at the grinder handler)' },
  { from: 0x028924, to: 0x028926, why: 'block spawn status write (SpriteDispatch.ts) at the fixed StatusOfSprInBlk operand BlockContents reads' }, // prettier-ignore
  { from: 0x02a8ac, to: 0x02a8ac, why: 'ShellSprites.ts PATH: the generator floor compare, its fixed branch, and its neighbour' },
  { from: 0x02a97c, to: 0x02a97c, why: 'ShellSprites.ts PATH: the status compare and the number step' },
  // Owned by the Golf Team (LevelLoader, GM11 spans, OverworldAreas): their cleanup removes these.
  { from: 0x0096f4, to: 0x009720, why: 'GM11 call sites (LevelLoader.ts): Golf Team' },
  { from: 0x00a633, to: 0x00a648, why: 'Mario entrance setup (LevelLoader.ts): Golf Team' },
  { from: 0x00f6d5, to: 0x00f6e8, why: 'UpdateScreenPosition (LevelLoader.ts): Golf Team' },
  { from: 0x05801e, to: 0x058030, why: 'level data loader (LevelLoader.ts): Golf Team' },
  { from: 0x05d790, to: 0x05d7c0, why: 'CODE_05D796 prologue (LevelLoader.ts): Golf Team' },
  { from: 0x05d8b1, to: 0x05d8c0, why: 'pointer loader (LevelLoader.ts): Golf Team' },
] // prettier-ignore

/** The LoROM file offset of a "$BB:AAAA" address. */
const offsetOf = (h: string): number => {
  const [bank, addr] = h
    .slice(1)
    .split(':')
    .map(x => parseInt(x, 16)) as [number, number]
  return (bank << 16) | addr
}
const allowed = (h: string) => ALLOWED.find(r => offsetOf(h) >= r.from && offsetOf(h) <= r.to)

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

    it('every allowed region still hits in some variant (ratchet: delete a region once it is clean)', () => {
      const seen = new Set<string>()
      for (const [, opts] of VARIANTS) for (const h of hitsOf(opts)) seen.add(allowed(h)?.why ?? '')
      expect(ALLOWED.filter(r => !seen.has(r.why)).map(r => r.why)).toEqual([])
    })
  },
)
