/**
 * #1050: no game code copied into the sprite level loader or its synthetic cart. A fixture is hand-written (a
 * minimal sequence that does the job) and shipping code names game code by fingerprint (SubmapFlagGate.ts's
 * spanFingerprint), never by its bytes.
 *
 * Two layers. (1) The ASSEMBLED synthetic carts (buildSyntheticRom and the Layer 3 cart): no 8-byte window of
 * theirs is one of the windows this branch's earlier heads held that also occur in the game, kept ONLY as
 * SHA-256 so this file carries no game bytes. Source spelling cannot hide a copy from this layer (the first
 * version of the gate read the source, and `OP.REP, 0x30, OP.LDA_DP, ...` assembled to the same 12 vanilla
 * bytes). (2) The source text of the files: no denied window among its 0x.. literals, and no run of more than
 * seven literals in the files this branch wrote whole.
 *
 * Evidence scope: this gate covers only the windows listed here and the assembled carts, so it catches their
 * return and a planted window, not an arbitrary new copy. A broader whole-ROM window sweep is planned as
 * tools/scripts/rom-window-probe.mjs (in review). Windows with
 * fewer than three distinct byte values are ignored, as padding. The older fixtures in syntheticSpriteRom.ts,
 * syntheticGm11Spans.ts and LevelLoader.ts's SHAPES predate #842 and still hold game bytes; they are out of
 * this gate's deny list on purpose and reported in the PR.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { layer3Cart } from '../support/layer3Cart'
import { buildSyntheticRom } from '../support/syntheticSpriteRom'

const ROOT = join(__dirname, '..', '..', '..')
const FILES = [
  'src/rom/sprites/interp/LevelLoader.ts',
  'test/suite/support/syntheticGm11Spans.ts',
  'test/suite/support/syntheticLayer3.ts',
  'test/suite/support/syntheticLoaderStandIns.ts',
  'test/suite/support/syntheticSpriteRom.ts',
  'test/suite/support/syntheticDrawProbes.ts',
  'test/suite/support/syntheticGrinder.ts',
  'test/suite/support/layer3Cart.ts',
]
/** Files this branch wrote or rewrote whole: every literal run in them is held to the bound. */
const BOUNDED = [
  'test/suite/support/syntheticLayer3.ts',
  'test/suite/support/syntheticLoaderStandIns.ts',
  'test/suite/support/syntheticDrawProbes.ts',
  'test/suite/support/layer3Cart.ts',
]
const MAX_RUN = 7

/** Windows that occur in the game and that only the stand-ins of head 098d6571 held (the loader tails, the Layer 3 table, ids 34-36); the older ids' own idioms recur in code outside this branch and are not listed. */
const DENIED_ASSEMBLED: readonly string[] = [
  '0a9aff2a30dee75f50868c06af1cd9cacca96c0375afb1bc194114b2c8baaefb',
  '38152625db64fb606fc33516c4d84772493859d038b39f1b746679a32ca7b00e',
  '4a457f4cc99c6130304ea932992f14f0e67a0903ad195a3e4606258fe2a9bbbe',
  '5623f9f56646473785bf5a96c3ae23e30b5c4422c94d0d3b32d9535dd22ed337',
  '6da9a87dd899c29d0bca77e0b72f27461eb31cdbdc98f3730bd9bee38a57cf05',
  '757fbb900a0930d6858f3d09335ca0942e427477380ce81aeaa7f2c292d80363',
  '8d468da1607caf8aab23e7f1a575ab4068b176ab87b924e11aa5df49f466deb2',
  'a7db31e80119a6b4ebf4fe30d0b8d948c8452e6d8838d37c93796ec0bac698fd',
  'e11992c63a85f9e00e7c6554c6b06a177cb59cc310b743fc2e4276c24a850dab',
  'eae545fb3c5329d3fd14572f880eb82a1e67443f6fb2990b31533d64bda6aa3f',
]

/** Windows of the 877d0ad7 source literals (GM12 call site, Layer 3 and loader stand-ins) that occur in the game. */
const DENIED_SOURCE: readonly string[] = [
  '08de8d7f642c678752f43014cfc521662cd894509797286d30eb156da5927fc6',
  '0a9aff2a30dee75f50868c06af1cd9cacca96c0375afb1bc194114b2c8baaefb',
  '15af07540faa2e999b5cae533487c6aad1a30213c5282e34cf2f0ff03f5efb2a',
  '252afbdc116839fccc8696935214500a6d28e2b267232f699a6b1bab81d72af4',
  '2d6ed8f3244e208bff05f98618a08a7cf14d00e20d0999e0e1617b69ca8558e9',
  '302c1b1140d4493562b50e50acccebf2f2f190ccb84e20dd0bd1a096c33e2f5e',
  '30c5062b53aaa990f039457553daa78bab703cc5345acb5419a235cfc0f03a48',
  '33df4de4faafd7fe6d604e2f89db0ac94c54dc90bd9b5d62a2aed33fb5cf7adf',
  '3ad5c2dd8f3e41f9e8a8c27f430e996a26835279aee86fd6ad7a7f40fe6f26bc',
  '3c98252662e4c1b2bec11b85e56cb22e874526f202321b22e14f1035b4cd61ac',
  '410324de8f99d34692da0ce842a1b610b4954e60d72c7625dca66866aa11d29a',
  '414f765305bb678989d2437d9585267367af74fc6573da1f17cca641efbd4b14',
  '49b54f7e344e99c0ee24c016728b75e59fc4a0f80dcdbc7e5cc9c402b9529312',
  '4a457f4cc99c6130304ea932992f14f0e67a0903ad195a3e4606258fe2a9bbbe',
  '55eb778ce992b03e38d11962a40ed0eef225b38cdaeffb38b103cbd9eb166331',
  '5623f9f56646473785bf5a96c3ae23e30b5c4422c94d0d3b32d9535dd22ed337',
  '5cd478466703c8e96f0d8344cd12eaf35563c73cf4cd5b67aec95081ffe64c6b',
  '5da52ae3cffea1fdff76ae73b25924c0e8a61a7b4a8029e34116d49433958b87',
  '6d42e055c2e5818c7bccf775a4ca674825ebccf5364bf73f61ca58f2cb74f7bd',
  '74e852b875fda5012c4b36e3b28aee984514481c68f0f52fc247eecd255ab50b',
  '757fbb900a0930d6858f3d09335ca0942e427477380ce81aeaa7f2c292d80363',
  '784e4113b7ff38d5a69adcdaeb433cd271644591c2fe42c5067912bcfebb5a82',
  '7c43b426cd45f00435ca573a4424df5ceea091996da30384d6b91b4423893814',
  '86c5095fa52a57598788ff00ccd5c746a590855f2a9f5d4eeb39e5ca87b8bb20',
  '89e6b2155163d555093f0f7bb4592e4b5c9a7a1b0fd9f32d6d584e806e57a7db',
  '908782da454317b7c96d52e79e5f7f616fbe948c8469a1efe8a9c2c9c9b56dee',
  'a7db31e80119a6b4ebf4fe30d0b8d948c8452e6d8838d37c93796ec0bac698fd',
  'b79ef19e2860d52b9ec06759e54014b24f85a143fc7181575f0e069f1d9db64e',
  'c280f5dd6c4e10e19c993ab5735a6ce02beb4b1ef0634c67d3f680041ed4a315',
  'cd4e174ae4bf6ffa522d406c4118117859d92b1f1f44bc4051210aab24705341',
  'ce2c18b1ecaa2c22ceddc33bfd78f42ff1bc8f7e7725c00db4a2b852360b116e',
  'cf3a56ff5c59f505c62eafc306c7ec4afc95f3608bc7a186dfa8021cd0332fdf',
  'cf4243517c54950a51475e2f996b868e30a0a85fd0455f1bc5b06126cf64b062',
  'd14bcc936c9090d02b8fa25d105f17e1def2af7173b1e74a00fda18164e4c3d4',
  'd71d2025d92188cca3a5f09ba102e7bc352db35a5b79b178f06d1c52d931c25c',
  'e03d63b521fa38e96e652c75968889982e52e6b29db8f05d216f5f162c947121',
  'eae545fb3c5329d3fd14572f880eb82a1e67443f6fb2990b31533d64bda6aa3f',
  'f47365f33471b00d92ba8efa4952873c8fffc8781d00172c7a148b86615c7118',
  'fa7c43f4bf49b8902dba40cca1f991e6b673f669aa9d5efa6daa2bf61306a66a',
]

const sha = (b: ArrayLike<number>): string =>
  createHash('sha256')
    .update(Buffer.from(Array.from(b)))
    .digest('hex')
const trivial = (w: ArrayLike<number>): boolean => new Set(Array.from(w)).size < 3

/** Runs of 0x.. byte literals, comments stripped. */
export function byteRuns(text: string): number[][] {
  const code = text.replace(/\/\/[^\n]*/g, '')
  const re = /0x[0-9a-fA-F]{2}(?![0-9a-zA-Z_])(?:[\s,]+0x[0-9a-fA-F]{2}(?![0-9a-zA-Z_]))*/g
  return [...code.matchAll(re)].map(m =>
    (m[0].match(/0x[0-9a-fA-F]{2}/g) ?? []).map(x => parseInt(x, 16)),
  )
}
/** Count of non-trivial 8-byte windows of `bytes` whose SHA-256 is in `denied`. */
export function deniedIn(bytes: ArrayLike<number>, denied: ReadonlySet<string>): number {
  const a = Array.from(bytes)
  let n = 0
  for (let i = 0; i + 8 <= a.length; i++) {
    const w = a.slice(i, i + 8)
    if (!trivial(w) && denied.has(sha(w))) n++
  }
  return n
}
const deniedInText = (text: string, denied: ReadonlySet<string>): number =>
  byteRuns(text).reduce((n, r) => n + deniedIn(r, denied), 0)

/** All eight banks of a synthetic cart as one byte array. */
const bytesOf = (rom: ReturnType<typeof buildSyntheticRom>): number[] =>
  [0, 1, 2, 3, 4, 5, 6, 7].flatMap(b => Array.from(rom.readAt((b << 16) | 0x8000, 0x8000)))

const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8')
const ASM = new Set(DENIED_ASSEMBLED)
const SRC = new Set(DENIED_SOURCE)

describe('no copied game code in the Layer 3 loader work (#1050)', () => {
  it.each([
    ['plain', () => buildSyntheticRom()],
    ['Layer 3 cart', () => layer3Cart(0, 1)],
  ])('the assembled %s holds none of the denied 8-byte windows', (_n, make) => {
    expect(deniedIn(bytesOf(make()), ASM)).toBe(0)
  })
  it.each(FILES)('%s holds none of the denied windows in its literals', f => {
    expect(deniedInText(read(f), SRC)).toBe(0)
  })
  it.each(BOUNDED)('%s has no run of more than ' + MAX_RUN + ' byte literals', f => {
    expect(Math.max(0, ...byteRuns(read(f)).map(r => r.length))).toBeLessThanOrEqual(MAX_RUN)
  })
  it('the deny lists are non-empty and the scanners see runs (a gate over nothing passes)', () => {
    expect(ASM.size).toBeGreaterThan(5)
    expect(SRC.size).toBeGreaterThan(30)
    expect(byteRuns('x = [0x01, 0x02,\n 0x03] // 0x09, 0x08')).toEqual([[1, 2, 3]])
    expect(bytesOf(buildSyntheticRom()).length).toBe(8 * 0x8000)
  })
  it('goes red on a planted window in an assembled cart and in a source literal', () => {
    const planted = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
    const deny = new Set([sha(planted)])
    const rom = buildSyntheticRom()
    expect(deniedIn(bytesOf(rom), deny)).toBe(0)
    rom.writeAt(0x03ff00, planted)
    expect(deniedIn(bytesOf(rom), deny)).toBe(1)
    const text = 'put(0, [0x00, ' + planted.map(b => '0x' + b.toString(16)).join(', ') + '])'
    expect(deniedInText(text, deny)).toBe(1)
    expect(deniedInText(text, new Set())).toBe(0)
    expect(deniedIn([0, 0, 0, 0, 0, 0, 0, 0, 0], new Set([sha([0, 0, 0, 0, 0, 0, 0, 0])]))).toBe(0)
  })
})
