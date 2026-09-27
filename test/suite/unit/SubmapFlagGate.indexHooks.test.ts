/**
 * The two hooks recognized on CODE_05D83E's path (#667), on synthetic ROMs:
 * Lunar Magic's midway JML at $05D842 and a JSL table loader at $05D89B.
 * Every pinned byte is load-bearing, and a hook that leaves for anywhere but
 * the stock code is refused.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { fingerprint } from '../../../src/rom/Fingerprint'
import {
  LOAD_HOOKS,
  MIDWAY_BUILDS,
  MIDWAY_HELPERS,
  entryPathMismatches,
  spanFingerprint,
  type MidwayHookBuild,
  type SpanBuild,
} from '../../../src/rom/SubmapFlagGate'
import { blankStockRom, flip, SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'

// Off bank $05, so a helper resolved in the wrong bank goes red.
const HOOK_AT = 0x06e900
const HELPER_AT = 0x06ea00
const LOADER_AT = 0x05eb00

/** A made-up build: JSR helper, JML $05D847, JML $05D8A2, then filler the fingerprint pins. */
// prettier-ignore
const HOOK = [
  0x20, HELPER_AT & 0xff, HELPER_AT >> 8 & 0xff,
  0x5c, 0x47, 0xd8, 0x05,
  0x5c, 0xa2, 0xd8, 0x85,
  0xa9, 0x01, 0x6b,
]
const MASK = [1, 2, 4, 5, 6, 8, 9, 10]
const HELPER = [0xad, 0xbf, 0x13, 0x60]
const BUILD: MidwayHookBuild = {
  length: HOOK.length,
  helperAt: 0,
  indexAt: 3,
  overrideAt: 7,
  fingerprint: spanFingerprint(Uint8Array.from(HOOK), MASK)!,
}
const HELPERS = [{ length: HELPER.length, fingerprint: fingerprint(Uint8Array.from(HELPER))! }]

function midway(): RomFile {
  const rom = blankStockRom()
  rom.writeAt(0x05d842, [0x5c, HOOK_AT & 0xff, (HOOK_AT >> 8) & 0xff, HOOK_AT >> 16])
  rom.writeAt(HOOK_AT, HOOK)
  rom.writeAt(HELPER_AT, HELPER)
  return rom
}

/** The two loaders as measured on the hack store, literal so a changed table goes red. */
// prettier-ignore
const LOADERS = [
  [0x08, 0xc2, 0x30, 0xbf, 0x00, 0xd0, 0x7e, 0x29, 0xff, 0x00, 0x8d, 0xbf, 0x13, 0x28, 0x6b],
  [0x8b, 0x4b, 0xab, 0xbf, 0x00, 0xd0, 0x7e, 0xc9, 0x01, 0xd0, 0x0a, 0xaf, 0x5c, 0x03, 0x70,
    0xd0, 0x04, 0xbf, 0x00, 0xd0, 0x7e, 0xab, 0x6b],
]

function loader(i: number): RomFile {
  const rom = blankStockRom()
  rom.writeAt(0x05d89b, [0x22, LOADER_AT & 0xff, (LOADER_AT >> 8) & 0xff, LOADER_AT >> 16])
  rom.writeAt(LOADER_AT, LOADERS[i]!)
  return rom
}

const failing = (
  rom: RomFile,
  builds: readonly MidwayHookBuild[] = [BUILD],
  helpers: readonly SpanBuild[] = HELPERS,
): string[] =>
  entryPathMismatches(rom, SYNTHETIC_FINGERPRINTS.entry, builds, helpers).flatMap(r => r ?? [])

describe('recognized builds', () => {
  it('pins the measured midway builds and helpers', () => {
    // prettier-ignore
    expect(MIDWAY_BUILDS).toEqual([
      { length: 83, helperAt: 15, indexAt: 51, overrideAt: 55, fingerprint: '68a4ef896c9733c485c8d324623a63bd02aeb0710307264c5d78abde8a345d9a' },
      { length: 91, helperAt: 23, indexAt: 59, overrideAt: 63, fingerprint: '992b39151651c1909d6817595de7d23b0edb01b0a38f03d7930760917e65fc07' },
      { length: 112, helperAt: 44, indexAt: 80, overrideAt: 84, fingerprint: '40bd680d20247be983bad917e8510595a94b10ebca7fd0c264ade1f651af7862' },
      { length: 115, helperAt: 15, indexAt: 72, overrideAt: 76, fingerprint: '293008f1233ad979f3bb176a5d838100f8ae9f7a788f2f6f7e5c711d2d0533fc' },
      { length: 108, helperAt: 48, indexAt: 84, overrideAt: 36, fingerprint: '37e3b1095ba0e2387d0bfee5a0c11a3f4b8853e9c404b8f02ab7f957cbd7307d' },
      { length: 125, helperAt: 48, indexAt: 101, overrideAt: 36, fingerprint: '666ae121229d3d6b1ca989657470ab3d4ed0a460e663d8da189f78caf35871f5' },
    ])
    // prettier-ignore
    expect(MIDWAY_HELPERS).toEqual([
      { length: 55, fingerprint: 'bd376469488b88004a0560305a4204240f228b197666c6931ca136f066a0d25e' },
      { length: 72, fingerprint: 'd59a371c9deb23c7fc60c827fb8a8a40a9db3ac8426d302f108ce347daccbf43' },
    ])
    expect(LOAD_HOOKS).toEqual(LOADERS)
  })
})

describe('the stock test and load around the fingerprint', () => {
  // STZ _F / LDY #0 / LDA OverworldOverride / BNE; LDA.L OWLayer1Translevel,X / STA TranslevelNo.
  const pinned = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => 0x05d83e + i),
    ...[0, 1, 2, 3, 4, 5, 6].map(i => 0x05d89b + i),
  ]
  it.each(pinned)('refuses with $%s flipped', at => {
    const rom = blankStockRom()
    flip(rom, at)
    expect(failing(rom, [], [])).not.toEqual([])
  })
})

describe("Lunar Magic's midway hook at $05D842", () => {
  it('passes the path', () => {
    expect(failing(midway())).toEqual([])
  })

  it('is refused without the synthetic build, and the stock guard is still accepted', () => {
    expect(failing(midway(), MIDWAY_BUILDS, MIDWAY_HELPERS).join()).toContain(
      'not a recognized build of the hook',
    )
    expect(failing(blankStockRom(), [], [])).toEqual([])
  })

  it.each([
    ['index exit', 0x04, [0x48, 0xd8, 0x05]],
    ['index exit bank', 0x04, [0x47, 0xd8, 0x06]],
    ['override exit', 0x08, [0xa3, 0xd8, 0x85]],
  ])('refuses a %s aimed elsewhere', (_, at, bytes) => {
    const rom = midway()
    rom.writeAt(HOOK_AT + at, bytes)
    expect(failing(rom).join()).toContain('does not return to $05D847 and $05D8A2')
  })

  it('refuses a changed helper', () => {
    const rom = midway()
    flip(rom, HELPER_AT + 1)
    expect(failing(rom).join()).toContain('helper at $06EA00 is not a recognized build')
  })

  it.each([0, 1, 2, 3, 4])('refuses with site byte %i flipped', i => {
    const rom = midway()
    flip(rom, 0x05d83e + i)
    expect(failing(rom)).not.toEqual([])
  })
  it.each(HOOK.map((_, i) => i))('refuses with hook byte %i flipped', i => {
    const rom = midway()
    flip(rom, HOOK_AT + i)
    expect(failing(rom)).not.toEqual([])
  })
  it.each(HELPER.map((_, i) => i))('refuses with helper byte %i flipped', i => {
    const rom = midway()
    flip(rom, HELPER_AT + i)
    expect(failing(rom)).not.toEqual([])
  })
})

describe('the JSL table loader at $05D89B', () => {
  it.each([0, 1])('passes the path with loader %i', i => {
    expect(failing(loader(i))).toEqual([])
  })

  it.each([0, 1])('refuses loader %i reading anything but OWLayer1Translevel,X', i => {
    for (const at of LOADERS[i]!.flatMap((b, j) => (b === 0xbf ? [j] : []))) {
      const rom = loader(i)
      rom.writeAt(LOADER_AT + at + 1, [0x01])
      expect(failing(rom).join()).toContain('not a recognized loader')
    }
  })

  it('refuses a loader without the STA TranslevelNo after it', () => {
    const rom = loader(0)
    rom.writeAt(0x05d89f, [0x85, 0xbf, 0x13])
    expect(failing(rom).join()).toContain('holds no JSL before STA TranslevelNo')
  })

  it.each([0, 4, 5, 6])('refuses with site byte %i flipped', i => {
    const rom = loader(0)
    flip(rom, 0x05d89b + i)
    expect(failing(rom)).not.toEqual([])
  })
  it.each(LOADERS.flatMap((p, i) => p.map((_, j) => [i, j])))(
    'refuses loader %i with byte %i flipped',
    (i, j) => {
      const rom = loader(i)
      flip(rom, LOADER_AT + j)
      expect(failing(rom)).not.toEqual([])
    },
  )
})
