/**
 * #1050: no game code copied into the sprite level loader or its synthetic cart. A fixture is
 * hand-written (a minimal sequence that does the job), and shipping code names long game code by
 * fingerprint (src/rom/Fingerprint.ts), never by its bytes. Two checks per file: no run of eight or
 * more hex byte literals (a literal run that long is a copy, not a sequence written for the test), and
 * none of the 8-byte windows that earlier heads of this branch held verbatim, kept here ONLY as their
 * SHA-256 so the gate carries no game bytes. Evidence scope: the runs this gate can see are 0x.. literals
 * (comments stripped) joined by whitespace and commas; it does not look at assembled bytes.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')
const FILES = [
  'src/rom/sprites/interp/LevelLoader.ts',
  'test/suite/support/syntheticGm11Spans.ts',
  'test/suite/support/syntheticLayer3.ts',
  'test/suite/support/syntheticLoaderStandIns.ts',
]
/** Files held to the run-length bound; LevelLoader's older shape literals (pre-#842) are not. */
const BOUNDED = FILES.slice(2)
const MAX_RUN = 7

/** SHA-256 of each 8-byte window of the flagged runs at head 877d0ad7 (3+ distinct values). */
/** Windows of the GM12 call site's old literal in LevelLoader.ts (its other shape literals predate #842). */
const DENIED_SRC: readonly string[] = [
  'ce2c18b1ecaa2c22ceddc33bfd78f42ff1bc8f7e7725c00db4a2b852360b116e',
  'cf3a56ff5c59f505c62eafc306c7ec4afc95f3608bc7a186dfa8021cd0332fdf',
  'd14bcc936c9090d02b8fa25d105f17e1def2af7173b1e74a00fda18164e4c3d4',
  'f47365f33471b00d92ba8efa4952873c8fffc8781d00172c7a148b86615c7118',
]
/** Windows of every run the synthetic support files held at 877d0ad7. */
const DENIED_FIXTURE: readonly string[] = [
  '00e55b8b1d4b93062373ac0d5282e6f1f5f53c63c9b39265615105cd71bcb8c6',
  '02f67a2e7826f6341d499cefd6bb9c11b914f7fe22a5cad4dcce1a65bdc3dbbb',
  '0789eefe1efbd0341a235990abed059fcdcf49082d24dbd85051be8954d939db',
  '08de8d7f642c678752f43014cfc521662cd894509797286d30eb156da5927fc6',
  '0a5b81218c3ff7b6294dcabb4888edc8c04f807b512355824746f8d69b56d909',
  '0a9aff2a30dee75f50868c06af1cd9cacca96c0375afb1bc194114b2c8baaefb',
  '0b141962dfa7fd2450f96123ea2e551e7b639c220482369dfd9d27fcec355b91',
  '1196fa233e5747ccab3487d21aec3f464f60bf569241f4312329dc8061efcd72',
  '15af07540faa2e999b5cae533487c6aad1a30213c5282e34cf2f0ff03f5efb2a',
  '1fe853f1436ba443f3ed135657587ca62e0fa9b13ed74ed33d4043efe4510268',
  '252afbdc116839fccc8696935214500a6d28e2b267232f699a6b1bab81d72af4',
  '2d6ed8f3244e208bff05f98618a08a7cf14d00e20d0999e0e1617b69ca8558e9',
  '302c1b1140d4493562b50e50acccebf2f2f190ccb84e20dd0bd1a096c33e2f5e',
  '30c5062b53aaa990f039457553daa78bab703cc5345acb5419a235cfc0f03a48',
  '33df4de4faafd7fe6d604e2f89db0ac94c54dc90bd9b5d62a2aed33fb5cf7adf',
  '33e47f9a1bcca29d4e011022a6478b37a06d3b01be4d1d0da65f3b3eab6ec91a',
  '3415092545a2744639b1b06d012293f9e5884e91076ff8c8c2ccec71a6a71d0b',
  '3490f2e04588e767c4855a82119ff22f0ed76c17aa5cf33a9b880cc21e1ed58e',
  '372a579adb37b31bd37986d24c932811b3ce0623cd322d4faa672d0426fabf8c',
  '3ad5c2dd8f3e41f9e8a8c27f430e996a26835279aee86fd6ad7a7f40fe6f26bc',
  '3c98252662e4c1b2bec11b85e56cb22e874526f202321b22e14f1035b4cd61ac',
  '410324de8f99d34692da0ce842a1b610b4954e60d72c7625dca66866aa11d29a',
  '414f765305bb678989d2437d9585267367af74fc6573da1f17cca641efbd4b14',
  '42b017ec16a0f3d72d395a864d3702038d93534cfdbc102c72e62c4b07fd89d7',
  '485cd06ef2d873a7542c02cba67c27f68f5122b9c00214af685e717907b8d063',
  '49b54f7e344e99c0ee24c016728b75e59fc4a0f80dcdbc7e5cc9c402b9529312',
  '4a457f4cc99c6130304ea932992f14f0e67a0903ad195a3e4606258fe2a9bbbe',
  '55eb778ce992b03e38d11962a40ed0eef225b38cdaeffb38b103cbd9eb166331',
  '5623f9f56646473785bf5a96c3ae23e30b5c4422c94d0d3b32d9535dd22ed337',
  '57a4f3c1eb26de081972fd9a64f97cbe59158290dcb97da421fdc058e6487a92',
  '5cd478466703c8e96f0d8344cd12eaf35563c73cf4cd5b67aec95081ffe64c6b',
  '5da52ae3cffea1fdff76ae73b25924c0e8a61a7b4a8029e34116d49433958b87',
  '6b5d2009853806f457328a28e3b09a04f03878f5e84200e157c7752ef3791a03',
  '6d42e055c2e5818c7bccf775a4ca674825ebccf5364bf73f61ca58f2cb74f7bd',
  '6e8c8d96820d212ac5d0dd559ed0c907b72e5d11a0c0ccc1507f471ef17a181c',
  '74e852b875fda5012c4b36e3b28aee984514481c68f0f52fc247eecd255ab50b',
  '757fbb900a0930d6858f3d09335ca0942e427477380ce81aeaa7f2c292d80363',
  '784e4113b7ff38d5a69adcdaeb433cd271644591c2fe42c5067912bcfebb5a82',
  '7993eb45eb6e3b423cb560104fdf3ccad6ba40079b7bfc3727bd6e274851b371',
  '79a222f8e1c30bcaa0e9965cfd188b84f3f552abc3d39cb5cb2387432b8029d5',
  '7c43b426cd45f00435ca573a4424df5ceea091996da30384d6b91b4423893814',
  '808497e12747aa545b486f5114b0e79e0416d6e0f5d19ea4854fd9b707c04d5d',
  '827cfb14e7b06a6b6dafa0d32c76317ae736faf0b90b4ce756fbf84f4ae83091',
  '86c5095fa52a57598788ff00ccd5c746a590855f2a9f5d4eeb39e5ca87b8bb20',
  '89e6b2155163d555093f0f7bb4592e4b5c9a7a1b0fd9f32d6d584e806e57a7db',
  '8a8293c0569f528975626a36daafc686c1cff9a9f18a42bc8a0bc4810fd714bc',
  '8e30532607bda024adab90ccf11ed9ab207f5d06b04806ed93ef7891db45aeda',
  '908782da454317b7c96d52e79e5f7f616fbe948c8469a1efe8a9c2c9c9b56dee',
  '994db223578ebf7b8435e2c2fd9b8f10fcc1fb161e5b6814df39ff05280cb9f6',
  'a4dfb100a0edd98c67b3423fc4a4805cee52471e50dc68995d736ded6405a524',
  'a7db31e80119a6b4ebf4fe30d0b8d948c8452e6d8838d37c93796ec0bac698fd',
  'b21771637813175fbcc6a34642c53c53829f9883ebe88e44e9c8b58a8c632273',
  'b79ef19e2860d52b9ec06759e54014b24f85a143fc7181575f0e069f1d9db64e',
  'c280f5dd6c4e10e19c993ab5735a6ce02beb4b1ef0634c67d3f680041ed4a315',
  'cd4e174ae4bf6ffa522d406c4118117859d92b1f1f44bc4051210aab24705341',
  'ce2c18b1ecaa2c22ceddc33bfd78f42ff1bc8f7e7725c00db4a2b852360b116e',
  'ce9d90555e83c43859eda58dd9ef431c9f10a7bd202c2f28de565819cd4362d2',
  'cf3a56ff5c59f505c62eafc306c7ec4afc95f3608bc7a186dfa8021cd0332fdf',
  'cf4243517c54950a51475e2f996b868e30a0a85fd0455f1bc5b06126cf64b062',
  'd0f0d606d3f78f3851ef26e46cdb6b9fd9feabafe567f2aa4b0bd10dc854451c',
  'd14bcc936c9090d02b8fa25d105f17e1def2af7173b1e74a00fda18164e4c3d4',
  'd71d2025d92188cca3a5f09ba102e7bc352db35a5b79b178f06d1c52d931c25c',
  'e03d63b521fa38e96e652c75968889982e52e6b29db8f05d216f5f162c947121',
  'e273835e4e3b849bccd7eb4da6cb4fde71d4afbee761d9d2a9dd533f6d049285',
  'eae545fb3c5329d3fd14572f880eb82a1e67443f6fb2990b31533d64bda6aa3f',
  'eb0f853f4258f628f8b88a806cb265bf49de8a4cef46008d932572d2880721fb',
  'ed5a925d44fb521ebbea8d4e99fbce944067253d0768a5cc270720ab7a2c625f',
  'f2fe1f581b59170960e0977c59b9b6658a7677a973af89e65845426e8be93c94',
  'f7839365dff3549a0ebd2549fd24de2a92ef3d2c72109841a07b82685cc295be',
  'fa7c43f4bf49b8902dba40cca1f991e6b673f669aa9d5efa6daa2bf61306a66a',
  'facd922f3db9a66ff92c9e1579c56775ebe2c15a22a76f6fe3a350ce110116de',
]
const DENIED_BY_FILE: Record<string, ReadonlySet<string>> = {
  [FILES[0]]: new Set(DENIED_SRC),
  [FILES[1]]: new Set(DENIED_FIXTURE),
  [FILES[2]]: new Set(DENIED_FIXTURE),
  [FILES[3]]: new Set(DENIED_FIXTURE),
}

/** Runs of 0x.. byte literals, comments stripped. */
export function byteRuns(text: string): number[][] {
  const code = text.replace(/\/\/[^\n]*/g, '')
  const re = /0x[0-9a-fA-F]{2}(?![0-9a-zA-Z_])(?:[\s,]+0x[0-9a-fA-F]{2}(?![0-9a-zA-Z_]))*/g
  return [...code.matchAll(re)].map(m =>
    (m[0].match(/0x[0-9a-fA-F]{2}/g) ?? []).map(x => parseInt(x, 16)),
  )
}
const sha = (b: number[]): string => createHash('sha256').update(Buffer.from(b)).digest('hex')
/** Denied windows found in `text`. */
export function deniedWindows(text: string, denied: ReadonlySet<string>): number {
  let n = 0
  for (const r of byteRuns(text))
    for (let i = 0; i + 8 <= r.length; i++) if (denied.has(sha(r.slice(i, i + 8)))) n++
  return n
}

const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8')

describe('no copied game code in the Layer 3 loader work (#1050)', () => {
  it.each(FILES)('%s holds none of the denied 8-byte windows', f => {
    expect(deniedWindows(read(f), DENIED_BY_FILE[f])).toBe(0)
  })
  it.each(BOUNDED)('%s has no run of more than ' + MAX_RUN + ' byte literals', f => {
    expect(Math.max(0, ...byteRuns(read(f)).map(r => r.length))).toBeLessThanOrEqual(MAX_RUN)
  })
  it('the denied set is non-empty and the scanner sees runs (a gate over nothing passes)', () => {
    expect(DENIED_SRC.length).toBeGreaterThan(3)
    expect(DENIED_FIXTURE.length).toBeGreaterThan(30)
    expect(byteRuns('x = [0x01, 0x02,\n 0x03] // 0x09, 0x08')).toEqual([[1, 2, 3]])
  })
  it('goes red on a planted window (synthetic bytes hashed into a local deny set)', () => {
    const planted = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
    const text = 'put(0, [0x00, ' + planted.map(b => '0x' + b.toString(16)).join(', ') + '])'
    expect(deniedWindows(text, new Set([sha(planted)]))).toBe(1)
    expect(deniedWindows(text, new Set())).toBe(0)
  })
})
