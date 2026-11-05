/**
 * ROM-byte clean-up (CastleFlames): the synthetic sprite cart carries no vanilla SMW bytes. The default cart and
 * each `SyntheticOptions` field (VARIANTS: one variant set per field, mostly the option alone; mainStepsBack carries
 * initFarCull and the grinderInitDelta values also run with grinderAliases; the values real tests use for
 * grinderInitDelta; spawnTimer and initShift swept over 0..255; not combinations of options) are scanned for an 8-byte
 * window (3+ distinct values) that occurs anywhere in the vanilla ROM; each hit is reported as an SNES
 * address. The scan needs the vanilla ROM and is gated on it. The no-ROM half, which CI runs, is the checker's
 * planted cases, the empty allow list ratchet and the variant coverage check; a vanilla window itself is only
 * caught where the ROM is present.
 */
import { readFileSync } from 'node:fs'
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

type Variant = [string, SyntheticOptions]
const one = (name: string, o: SyntheticOptions): Variant[] => [[name, o]]
const each = <T>(name: string, vals: readonly T[], f: (v: T) => SyntheticOptions): Variant[] =>
  vals.map((v): Variant => [`${name} ${JSON.stringify(v)}`, f(v)])
/** The grinderInitDelta values real tests use, so the gate scans the bytes those tests build (with and without aliases). */
const DELTAS: (readonly [number, number])[] = [[8, 0], [12, 0], [0, 0], [0x180, 0], [-0x140, 0], [0, -0x140], [0, -0x80], [1, 1], [4, 0], [0x10, 0], [0x123, -0x45]] // prettier-ignore

/**
 * One variant set per SyntheticOptions field. The guard is the runtime check below, which reads the interface from
 * syntheticSpriteRom.ts as text and fails on a field with no entry here (tsconfig.test.json does not typecheck this
 * file, so the mapped type alone guards nothing in CI). `uncovered` fails when an entry is empty or a variant leaves
 * its field unset. A variant is the option on its own, except mainStepsBack (with initFarCull) and the
 * grinderInitDelta values that also set grinderAliases.
 */
export const BY_OPTION: { [K in keyof SyntheticOptions]-?: Variant[] } = {
  initShift: one('initShift', { initShift: 0x31 }),
  initFarCull: one('initFarCull', { initFarCull: true }),
  mainStepsBack: one('mainStepsBack', { initFarCull: true, mainStepsBack: true }),
  noTileWrite: one('noTileWrite', { noTileWrite: true }),
  badLoop: one('badLoop', { badLoop: true }),
  dupLoop: one('dupLoop', { dupLoop: true }),
  badExecutePtr: one('badExecutePtr', { badExecutePtr: true }),
  badDispatch: one('badDispatch', { badDispatch: true }),
  badInitTables: one('badInitTables', { badInitTables: true }),
  badGetRand: one('badGetRand', { badGetRand: true }),
  fastRomGetRand: one('fastRomGetRand', { fastRomGetRand: true }),
  badLoader: each('badLoader', LOADERS, k => ({ badLoader: k })),
  updateHook: each('updateHook', ['jml', 'loop', 'rts'] as const, k => ({ updateHook: k })),
  loaderCop: one('loaderCop', { loaderCop: true }),
  badSpawn: each('badSpawn', ['head', 'status', 'dispatch'] as const, k => ({ badSpawn: k })),
  spawnTimer: one('spawnTimer', { spawnTimer: 0x44 }),
  spawnLoop: one('spawnLoop', { spawnLoop: true }),
  alteredGrinder: one('alteredGrinder', { alteredGrinder: true }),
  grinderDrawsOnce: one('grinderDrawsOnce', { grinderDrawsOnce: true }),
  grinderDrawsTwice: one('grinderDrawsTwice', { grinderDrawsTwice: true }),
  grinderDrawsOnPass1: one('grinderDrawsOnPass1', { grinderDrawsOnPass1: true }),
  grinderDrawsFromPass1: one('grinderDrawsFromPass1', { grinderDrawsFromPass1: true }),
  id31IsGrinder: one('id31IsGrinder', { id31IsGrinder: true }),
  grinderInitShifts: one('grinderInitShifts', { grinderInitShifts: true }),
  grinderInitDelta: [
    ...each('grinderInitDelta', DELTAS, d => ({ grinderInitDelta: d })),
    ...each('grinderInitDelta+aliases', DELTAS, d => ({
      grinderInitDelta: d,
      grinderAliases: true,
    })),
  ],
  grinderAliases: one('grinderAliases', { grinderAliases: true }),
  grinderPrelude: one('grinderPrelude', { grinderPrelude: true }),
  grinderCell: each('grinderCell', ['At3', 'Not3'] as const, c => ({ grinderCell: c })),
  grinderLocksOnPass: one('grinderLocksOnPass', { grinderLocksOnPass: 2 }),
  grinderWideX: one('grinderWideX', { grinderWideX: true }),
  irqCommand: one('irqCommand', { irqCommand: 0x80 }),
  eeries: [
    ...one('eeries', { eeries: {} }),
    ...one('eeries stream', { eeries: { stream: [0x51, 0xb3, 0xe0, 0xff] } }),
    ...one('eeries spacing', { eeries: { spacing: [-0x30, -0x18, 0x18, 0x30] } }),
    ...one('eeries room', { eeries: { room: 6 } }),
    ...one('eeries room 0', { eeries: { room: 0 } }),
    ...one('eeries travel', { eeries: { travel: true } }),
  ],
}

/** The cart `buildSyntheticRom()` makes, and every option's variants. */
export const VARIANTS: Variant[] = [['default', {}], ...Object.values(BY_OPTION).flat()]

/** The fields of `by` with no variant, or with variants that never set the field: empty when coverage holds. */
export function uncovered(by: Record<string, Variant[]>): string[] {
  return Object.entries(by)
    .filter(
      ([k, vs]) =>
        vs.length === 0 || vs.some(([, o]) => (o as Record<string, unknown>)[k] === undefined),
    )
    .map(([k]) => k)
}

/** The field names of the `SyntheticOptions` interface in `src` (2-space-indented `name?:` lines), read as text. */
export function optionFields(src: string): string[] {
  const body = /export interface SyntheticOptions \{\r?\n([\s\S]*?)\r?\n\}/.exec(src)?.[1] ?? ''
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map(m => m[1]!)
}
/** What is wrong between the interface fields in `src` and the keys of `by`: a parser that found few fields, a field with no entry, an entry for no field. */
export function fieldProblems(src: string, by: Record<string, unknown>): string[] {
  const fields = optionFields(src)
  const keys = Object.keys(by)
  return [
    ...(fields.length < 30 ? [`the parser found only ${fields.length} fields`] : []),
    ...fields.filter(f => !keys.includes(f)).map(f => `no variant entry for ${f}`),
    ...keys.filter(k => !fields.includes(k)).map(k => `entry ${k} is no field`),
  ]
}

describe('the variant list covers every option', () => {
  const SRC = readFileSync(new URL('../../support/syntheticSpriteRom.ts', import.meta.url), 'utf8')
  it('every interface field has variants that set it, and every entry is a field', () => {
    expect(fieldProblems(SRC, BY_OPTION)).toEqual([])
    expect(uncovered(BY_OPTION)).toEqual([])
  })
  it('planted: a missing key, an extra key, or a parser that finds nothing is red', () => {
    const names = Array.from({ length: 32 }, (_, i) => `f${i}`)
    const src = ['export interface SyntheticOptions {', ...names.map(n => `  ${n}?: boolean`), '}'].join('\n') // prettier-ignore
    const full = Object.fromEntries(names.map(n => [n, []]))
    expect(fieldProblems(src, full)).toEqual([])
    const less = Object.fromEntries(Object.entries(full).filter(([k]) => k !== 'f7'))
    expect(fieldProblems(src, less)).toEqual(['no variant entry for f7'])
    expect(fieldProblems(src, { ...full, zz: [] })).toEqual(['entry zz is no field'])
    expect(fieldProblems('', {})).toEqual(['the parser found only 0 fields'])
  })
  it('planted: a mixed list, or an undefined value, does not count as setting the field', () => {
    const good: Variant = ['g', { badLoop: true }]
    expect(uncovered({ badLoop: [good, ['h', { dupLoop: true }]] })).toEqual(['badLoop'])
    expect(uncovered({ grinderCell: [['u', { grinderCell: undefined }]] })).toEqual(['grinderCell'])
    expect(uncovered({ badLoop: [good] })).toEqual([])
  })
  it('planted: a field with its variants removed, or variants that do not set it, is red', () => {
    expect(uncovered({ a: [], b: [['b', { badLoop: true }]], c: [['c', { badLoop: true }]] })).toEqual(['a', 'b', 'c']) // prettier-ignore
  })
})

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
    expect(allowListProblems([{ why: 'r' }])).toEqual(['r: the allow list must stay empty (#1073)'])
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

    // Immediates a test can set to any byte: every value must stay clear, not only the one in VARIANTS.
    it.each(['spawnTimer', 'initShift'] as const)(
      '%s: no value 0..255 has a vanilla window',
      key => {
        const bad: number[] = []
        for (let v = 0; v < 256; v++) if (hitsOf({ [key]: v }).length > 0) bad.push(v)
        expect(bad).toEqual([])
      },
      120_000,
    )

    it.each(VARIANTS)('%s: has no vanilla window', (_, opts) => {
      expect(summarize(hitsOf(opts))).toEqual([])
    })
  },
)
