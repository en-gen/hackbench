/**
 * The content gate's ROM-window rule (#1053): an added text file holding a run that matches an
 * 8-byte window of the vanilla ROM is blocked. Every ROM in the synthetic half is PRNG bytes built
 * in the test, so it runs in CI with no corpus; the real-ROM half is gated on it. Planted bytes are
 * generated at test time and never printed or committed. The hashed no-ROM lookup is held for D155.
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkRomWindows, evaluateEntry } from '../../../tools/scripts/check-content.mjs'
import {
  bytesHits,
  isCandidate,
  windowSet,
  // @ts-expect-error plain ESM without types
} from '../../../tools/scripts/lib/rom-windows.mjs'
import { hasRom, romPath, VANILLA } from '../support/corpus'
import { stub } from '../support/syntheticAreas'
import { bgModeRom } from '../support/bgModeRom'
import { buildCart, syntheticRoutine } from '../support/syntheticGfxCart'
import { modeTablesRom, sweepLayouts } from '../support/l3Rom'
import { map16DecodeStub } from '../support/syntheticMap16'
import { syntheticOverworldRom } from '../support/syntheticOverworld'
import { platformCart } from '../support/syntheticPlatforms'
import { pswitchRom } from '../support/syntheticPSwitch'
import { fakeRom, rampRom } from '../support/syntheticRegistryRom'
import { blankStockRom } from '../support/syntheticRom'
import { buildSyntheticRom } from '../support/syntheticSpriteRom'
import { cart, productionCart } from '../support/syntheticCart'
import { layer3Cart } from '../support/layer3Cart'
import { clusterPathStandIn } from '../support/clusterPathStandIn'
import { dmaCode, routine } from '../support/marioGraphicsFixture'
import { putCompanionRoutines } from '../support/syntheticCompanion'
import { putDrawPosProbes } from '../support/syntheticDrawProbes'
import { putLoaderStandIns } from '../support/syntheticLoaderStandIns'
import { putLayer3 } from '../support/syntheticLayer3'
import { c3StructurePlants } from '../support/staircaseB'
import { SYNTHETIC_VERTICAL_TABLE } from '../support/verticalTable'
import { writeStockSkipChain } from '../support/skipChain'

const REPO = join(__dirname, '../../..')
const tmp = mkdtempSync(join(tmpdir(), 'cg-romwin-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function prng(n: number, seed = 0x5eed1234): Uint8Array {
  const out = new Uint8Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = s >>> 24
  }
  return out
}
const h2 = (b: number) => b.toString(16).padStart(2, '0')
// One planted run in each notation the gate reads.
const NOTATIONS: Record<string, (b: Uint8Array) => string> = {
  'hex array': b => `export const fixture = [${Array.from(b, x => `0x${h2(x)}`).join(', ')}]\n`,
  '$xx list': b => `export const fixture = "${Array.from(b, x => `$${h2(x)}`).join(' ')}"\n`,
  '\\x string': b => `export const fixture = "${Array.from(b, x => `\\x${h2(x)}`).join('')}"\n`,
  'hex string': b => `export const fixture = "${Array.from(b, h2).join('')}"\n`,
  'spaced hex': b => `export const fixture = "${Array.from(b, h2).join(' ')}"\n`,
}
const text = (n: string, b: Uint8Array) => Buffer.from(NOTATIONS[n]!(b))
const NAMES = Object.keys(NOTATIONS)

describe(
  'rom-window rule, a synthetic ROM injected through the lookup seam',
  { timeout: 60000 },
  () => {
    const rom = prng(4096)
    const set = windowSet(rom)
    let at = 100
    while (!isCandidate(rom.subarray(at, at + 8))) at++
    const planted = rom.subarray(at, at + 8)

    it.each(NAMES)('a planted run in %s is red, naming the line', n => {
      const hits = checkRomWindows(
        'f.ts',
        Buffer.concat([Buffer.from('// h\n'), text(n, planted)]),
        set,
      )
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({ rule: 'rom-window', path: 'f.ts' })
      expect(hits[0].where).toMatch(/^line 2, \d+ windows?$/)
      expect(evaluateEntry('f.ts', text(n, planted), set).map(h => h.rule)).toContain('rom-window')
    })

    it('7 bytes, invented bytes, all-zero and low-distinct runs pass', () => {
      const invented = prng(8, 0xfeed).map(b => b | 1)
      const lowDistinct = Uint8Array.from([1, 2, 1, 2, 1, 2, 1, 2])
      const low = prng(64)
      low.set(lowDistinct, 20)
      low.set(new Uint8Array(8), 40)
      const lowSet = windowSet(low) // present in the set: only the distinct-values filter can pass them
      expect(lowSet.size).toBeGreaterThan(0)
      for (const n of NAMES) {
        expect(checkRomWindows('f.ts', text(n, planted.subarray(0, 7)), set)).toEqual([])
        expect(checkRomWindows('f.ts', text(n, invented), set)).toEqual([])
        expect(checkRomWindows('f.ts', text(n, lowDistinct), lowSet)).toEqual([])
        expect(checkRomWindows('f.ts', text(n, new Uint8Array(8)), lowSet)).toEqual([])
      }
    })

    it('a ramp or a short loop present in the injected set passes (pattern filter)', () => {
      const ramp = Uint8Array.from([3, 7, 11, 15, 19, 23, 27, 31]) // constant step
      const wrap = Uint8Array.from([250, 253, 0, 3, 6, 9, 12, 15]) // constant step across 255 to 0
      const loop = Uint8Array.from([9, 4, 7, 9, 4, 7, 9, 4]) // period 3
      const rom2 = prng(256)
      for (const [i, w] of [ramp, wrap, loop].entries()) rom2.set(w, 20 + i * 20)
      const set2 = windowSet(rom2)
      for (const w of [ramp, wrap, loop])
        for (const n of NAMES) expect(checkRomWindows('f.ts', text(n, w), set2), n).toEqual([])
    })

    it('no lookup, a lockfile and a binary blob are not scanned', () => {
      const t = text('hex array', planted)
      expect(checkRomWindows('f.ts', t, null)).toEqual([])
      expect(checkRomWindows('package-lock.json', t, set)).toEqual([])
      expect(checkRomWindows('f.ts', Buffer.concat([t, Buffer.from([0])]), set)).toEqual([])
    })

    it('any object with has() is a lookup, not only a Set', () => {
      const only = new Set([Buffer.from(planted).toString('latin1')])
      const lookup = { has: (k: string) => only.has(k) }
      expect(checkRomWindows('f.ts', text('hex array', planted), lookup)).toHaveLength(1)
    })

    // The CLI end to end in a throwaway repo; the fake ROM is found through HACKBENCH_ROMS.
    function gateRepo(): string {
      const dir = mkdtempSync(join(tmp, 'repo-'))
      mkdirSync(join(dir, 'tools/scripts'), { recursive: true })
      mkdirSync(join(dir, 'test/suite/support'), { recursive: true })
      const src = join(REPO, 'tools/scripts')
      cpSync(join(src, 'check-content.mjs'), join(dir, 'tools/scripts/check-content.mjs'))
      cpSync(join(src, 'lib'), join(dir, 'tools/scripts/lib'), { recursive: true })
      cpSync(
        join(REPO, 'test/suite/support/corpus.cjs'),
        join(dir, 'test/suite/support/corpus.cjs'),
      )
      const g = (...a: string[]) => spawnSync('git', a, { cwd: dir })
      g('init', '-q')
      g('config', 'user.email', 't@example.com')
      g('config', 'user.name', 'T')
      writeFileSync(join(dir, 'f.ts'), text('\\x string', planted))
      g('add', 'f.ts')
      return dir
    }
    const staged = (dir: string, roms: string) =>
      spawnSync('node', ['tools/scripts/check-content.mjs', 'staged'], {
        cwd: dir,
        env: { ...process.env, HACKBENCH_ROMS: roms },
      })

    it('CLI with a ROM exits 1 naming the line; with none it exits 0 and says it did not run', () => {
      const dir = gateRepo()
      const withRom = join(tmp, 'roms-with')
      mkdirSync(withRom, { recursive: true })
      writeFileSync(join(withRom, VANILLA), rom)
      const red = staged(dir, withRom)
      expect(red.status).toBe(1)
      expect(red.stdout.toString()).toMatch(/BLOCKED \(rom-window\): f\.ts line 1, \d+ windows?/)

      const noRom = join(tmp, 'roms-none')
      mkdirSync(noRom, { recursive: true })
      const green = staged(dir, noRom)
      expect(green.status).toBe(0)
      expect(green.stderr.toString()).toMatch(/rules DID NOT RUN: no vanilla ROM/)

      // A modified file is not judged: only added files are (old content would fail every edit).
      const g = (...x: string[]) => spawnSync('git', x, { cwd: dir })
      g('commit', '-q', '-m', 'add')
      writeFileSync(join(dir, 'f.ts'), `${text('\\x string', planted)}// edit\n`)
      g('add', 'f.ts')
      expect(staged(dir, withRom).status).toBe(0)
      g('reset', '-q', '--hard')
      g('rm', '-q', '-f', 'f.ts')
      g('commit', '-q', '-m', 'rm')
      writeFileSync(join(dir, 'f.md'), text('hex array', planted))
      g('add', 'f.md')
      expect(staged(dir, withRom).status).toBe(0) // .md is excluded
    })
  },
)

describe('rom-window rule judges the net added files of a range', { timeout: 60000 }, () => {
  // develop adds a file holding a run after the feature branched; the feature merges develop. The
  // merge commit diffed against the feature parent lists that file as added (git log -m), but it is
  // not in the net diff of the range, so it must not be judged.
  const rom = prng(4096, 0x1053)
  const at = (() => {
    let i = 200
    while (!isCandidate(rom.subarray(i, i + 8))) i++
    return i
  })()
  const run = text('hex array', rom.subarray(at, at + 8))
  const roms = join(tmp, 'roms-net')
  mkdirSync(roms, { recursive: true })
  writeFileSync(join(roms, VANILLA), rom)

  function repo(): { dir: string; g: (...a: string[]) => string } {
    const dir = mkdtempSync(join(tmp, 'net-'))
    mkdirSync(join(dir, 'tools/scripts'), { recursive: true })
    mkdirSync(join(dir, 'test/suite/support'), { recursive: true })
    cpSync(
      join(REPO, 'tools/scripts/check-content.mjs'),
      join(dir, 'tools/scripts/check-content.mjs'),
    )
    cpSync(join(REPO, 'tools/scripts/lib'), join(dir, 'tools/scripts/lib'), { recursive: true })
    cpSync(join(REPO, 'test/suite/support/corpus.cjs'), join(dir, 'test/suite/support/corpus.cjs'))
    const g = (...a: string[]) => spawnSync('git', a, { cwd: dir }).stdout.toString().trim()
    g('init', '-q', '-b', 'develop')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    g('add', '-A')
    g('commit', '-q', '-m', 'base')
    g('checkout', '-q', '-b', 'feature')
    writeFileSync(join(dir, 'mine.ts'), 'export const a = 1\n')
    g('add', 'mine.ts')
    g('commit', '-q', '-m', 'feature work')
    g('checkout', '-q', 'develop')
    writeFileSync(join(dir, 'theirs.ts'), run)
    g('add', 'theirs.ts')
    g('commit', '-q', '-m', 'develop adds a run')
    g('checkout', '-q', 'feature')
    g('merge', '-q', '--no-edit', 'develop')
    return { dir, g }
  }
  const range = (dir: string, base: string, env = roms) =>
    spawnSync('node', ['tools/scripts/check-content.mjs', 'range', base, 'feature'], {
      cwd: dir,
      env: { ...process.env, HACKBENCH_ROMS: env },
    })

  it('a file merged in from develop is not judged; a file the branch adds still is', () => {
    const { dir, g } = repo()
    expect(range(dir, 'develop').status).toBe(0)
    writeFileSync(join(dir, 'planted.ts'), run)
    g('add', 'planted.ts')
    g('commit', '-q', '-m', 'plant')
    const red = range(dir, 'develop')
    expect(red.status).toBe(1)
    expect(red.stdout.toString()).toMatch(/rom-window\): planted\.ts/)
    expect(red.stdout.toString()).not.toContain('theirs.ts')
  })

  it('rom-mask is judged in the same places: an added non-markdown file, not a .md', () => {
    const { dir, g } = repo()
    const fixed = Array.from({ length: 6 }, (_, k) => `0x${h2(rom[at + 2 * k]!)}`)
    const body = `export const s = [${fixed.join(', null, ')}]
`
    writeFileSync(join(dir, 'masked.ts'), body)
    writeFileSync(join(dir, 'masked.md'), body)
    g('add', '-A')
    g('commit', '-q', '-m', 'masked')
    const out = range(dir, 'develop').stdout.toString()
    expect(out).toMatch(/BLOCKED \(rom-mask\): masked\.ts line 1, 1 slice/)
    expect(out).not.toContain('masked.md')
  })

  it('a file added then edited in the range is judged on its final content', () => {
    const { dir, g } = repo()
    writeFileSync(join(dir, 'late.ts'), 'export const b = 1\n')
    g('add', 'late.ts')
    g('commit', '-q', '-m', 'late')
    writeFileSync(join(dir, 'late.ts'), run)
    g('add', 'late.ts')
    g('commit', '-q', '-m', 'late edit')
    expect(range(dir, 'develop').status).toBe(1)
  })

  it('push mode judges against what the remote has', () => {
    const { dir, g } = repo()
    const remote = mkdtempSync(join(tmp, 'remote-'))
    spawnSync('git', ['init', '-q', '--bare', remote])
    g('remote', 'add', 'origin', remote)
    g('push', '-q', 'origin', 'develop')
    const sha = g('rev-parse', 'feature')
    const push = () =>
      spawnSync('node', ['tools/scripts/check-content.mjs', 'push', 'origin'], {
        cwd: dir,
        input: `refs/heads/feature ${sha} refs/heads/feature ${'0'.repeat(40)}
`,
        env: { ...process.env, HACKBENCH_ROMS: roms },
      })
    expect(push().status).toBe(0)
    writeFileSync(join(dir, 'planted.ts'), run)
    g('add', 'planted.ts')
    g('commit', '-q', '-m', 'plant')
    const sha2 = g('rev-parse', 'feature')
    const red = spawnSync('node', ['tools/scripts/check-content.mjs', 'push', 'origin'], {
      cwd: dir,
      input: `refs/heads/feature ${sha2} refs/heads/feature ${'0'.repeat(40)}
`,
      env: { ...process.env, HACKBENCH_ROMS: roms },
    })
    expect(red.status).toBe(1)
  })

  it('without a ROM the range and staged modes say the check did not run', () => {
    const { dir, g } = repo()
    writeFileSync(join(dir, 'planted.ts'), run)
    g('add', 'planted.ts')
    const none = join(tmp, 'roms-none-net')
    mkdirSync(none, { recursive: true })
    const s = spawnSync('node', ['tools/scripts/check-content.mjs', 'staged'], {
      cwd: dir,
      env: { ...process.env, HACKBENCH_ROMS: none },
    })
    g('commit', '-q', '-m', 'plant')
    const r = range(dir, 'develop', none)
    for (const out of [s, r]) {
      expect(out.status).toBe(0)
      expect(out.stderr.toString()).toMatch(
        /rom-window and rom-mask rules DID NOT RUN: no vanilla ROM/,
      )
      expect(out.stdout.toString() + out.stderr.toString()).not.toMatch(/\b(clean|passed|ok)\b/i)
    }
  })
})

describe('rom-mask rule: masked arrays on a synthetic PRNG ROM', () => {
  const rom = prng(4096, 0x6a5c)
  const set = windowSet(rom)
  // Fixed bytes taken from the ROM two apart, so each pair has one wildcard between; chosen with >= 3 distinct.
  const planted = (n: number, from = 300): number[] => {
    for (let at = from; ; at++) {
      const v = Array.from({ length: n }, (_, k) => rom[at + 2 * k]!)
      if (new Set(v).size >= 3) return v
    }
  }
  const x2 = (b: number) => `0x${h2(b)}`
  const FORMS: Record<string, (v: number[]) => string> = {
    null: v => `export const s = [${v.map(x2).join(', null, ')}]\n`,
    undefined: v => `export const s = [${v.map(x2).join(', undefined, ')}]\n`,
    'quoted ??': v => `export const s = [${v.map(b => `'${x2(b)}'`).join(", '??', ")}]\n`,
    'string ??': v => `export const s = "${v.map(h2).join(' ?? ')}"\n`,
  }
  const FORM_NAMES = Object.keys(FORMS)
  const scan = (t: string, lookup = set) => checkRomWindows('f.ts', Buffer.from(t), lookup)

  it.each(FORM_NAMES)('6 fixed bytes in %s form is red, naming line and slice count', f => {
    const hits = scan(`// h\n${FORMS[f]!(planted(6))}`)
    expect(hits).toEqual([{ rule: 'rom-mask', path: 'f.ts', where: 'line 2, 1 slice' }])
  })

  it.each(FORM_NAMES)('5 fixed bytes, invented bytes and no match in %s form pass', f => {
    expect(scan(FORMS[f]!(planted(5)))).toEqual([])
    expect(scan(FORMS[f]!(planted(6).map(b => (b ^ 0x55) | 1)))).toEqual([])
  })

  it('a mask with fewer than 3 distinct fixed values passes even when the ROM holds it', () => {
    const low = prng(256, 9)
    const loop = [1, 2, 1, 2, 1, 2]
    loop.forEach((b, k) => (low[40 + 2 * k] = b))
    const three = [5, 6, 7, 5, 6, 7]
    three.forEach((b, k) => (low[100 + 2 * k] = b))
    const lowSet = windowSet(low)
    for (const f of FORM_NAMES) {
      expect(scan(FORMS[f]!(loop), lowSet), f).toEqual([])
      expect(scan(FORMS[f]!(three), lowSet), f).toHaveLength(1)
    }
  })

  it('one altered byte in a 12-byte array still hits; overlapping slices merge into one hit', () => {
    const v = planted(12)
    for (const f of FORM_NAMES) {
      expect(scan(FORMS[f]!(v)), f).toEqual([{ rule: 'rom-mask', path: 'f.ts', where: 'line 1, 7 slices' }]) // prettier-ignore
      const altered = v.slice()
      altered[5] = (altered[5]! ^ 0x55) | 1
      expect(scan(FORMS[f]!(altered)), f).toEqual([{ rule: 'rom-mask', path: 'f.ts', where: 'line 1, 1 slice' }]) // prettier-ignore
    }
  })

  it('wildcard-only and unmasked runs do not reach the rule', () => {
    expect(scan('export const s = [null, null, null, null, null, null, null, null]\n')).toEqual([])
    const v = planted(6, 800)
    // Contiguous bytes of the ROM: 6 long, under the 8-byte window rule, and no wildcard.
    const contiguous = Array.from(rom.subarray(900, 906))
    expect(scan(`export const s = [${contiguous.map(x2).join(', ')}]\n`)).toEqual([])
    expect(scan(`export const s = [${v.map(x2).join(', ')}]\n`)).toEqual([])
  })

  it('a lookup with only has() skips the rule, and a comment hides nothing it should not', () => {
    const only = { has: (k: string) => set.has(k) }
    expect(scan(FORMS.null!(planted(6)), only as never)).toEqual([])
    expect(scan(`// ${FORMS.null!(planted(6))}`)).toEqual([])
  })

  // Smoke test (a planted defect, not coverage): red with the plant, green with it removed.
  it('goes red on the plant and green with the plant removed', () => {
    const file = (v: number[]) => `export const a = 1\n${FORMS.null!(v)}export const b = 2\n`
    expect(scan(file(planted(8))).map(h => h.rule)).toEqual(['rom-mask'])
    expect(scan(file(planted(8).map(b => (b ^ 0x55) | 1)))).toEqual([])
  })
})

// What a `put(snes, bytes)` or `writeAt` builder wrote, one part per call (windows across parts are not real).
const parts = (fill: (put: (at: number, bytes: number[]) => void) => void): Uint8Array[] => {
  const out: Uint8Array[] = []
  fill((_at, bytes) => out.push(Uint8Array.from(bytes)))
  return out
}
const plants = (p: [number, number[]][]) => p.map(([, bytes]) => Uint8Array.from(bytes))

// Builders that assemble synthetic code or a cart. Add a new one here AND to PIN: the guards below fail
// until you do, with no ROM needed. #1085 and #1253 own the builders; this only counts them.
const BUILDERS: Record<string, () => Uint8Array | Uint8Array[]> = {
  stub: () => stub().buffer,
  blankStockRom: () => blankStockRom().buffer,
  syntheticOverworldRom: () => syntheticOverworldRom().buffer,
  buildSyntheticRom: () => buildSyntheticRom().buffer,
  platformCart: () => platformCart().buffer,
  pswitchRom: () => pswitchRom().buffer,
  rampRom,
  fakeRom,
  map16DecodeStub: () => map16DecodeStub(),
  buildCart: () => buildCart().rom.buffer,
  bgModeRom: () => bgModeRom().buffer,
  modeTablesRom: () => modeTablesRom(sweepLayouts()).buffer,
  cart: () => cart([]).buffer,
  productionCart: () => productionCart(syntheticRoutine(24).bytes).buffer,
  layer3Cart: () => layer3Cart(1, 2).buffer,
  clusterPathStandIn: () =>
    plants([...clusterPathStandIn(), ...clusterPathStandIn({ fastRom: true })]),
  marioGraphicsFixture: () => [Uint8Array.from(routine({ at33: 1, bank: 2, top: 3, srcTop: 4, at32: 5 })), Uint8Array.from(dmaCode())], // prettier-ignore
  syntheticCompanion: () => parts(putCompanionRoutines),
  syntheticDrawProbes: () => parts(putDrawPosProbes),
  syntheticLoaderStandIns: () => parts(put => putLoaderStandIns(put, {})),
  syntheticLayer3: () => parts(putLayer3),
  staircaseB: () => plants(c3StructurePlants(0x8000)),
  verticalTable: () => Uint8Array.from(SYNTHETIC_VERTICAL_TABLE),
  skipChain: () => parts(put => writeStockSkipChain({ writeAt: put } as never)),
}
// Every support module is either a host of a builder above (value: its builders) or helper-only.
const HOSTS: Record<string, string[]> = {
  syntheticAreas: ['stub'],
  bgModeRom: ['bgModeRom'],
  l3Rom: ['modeTablesRom'],
  syntheticCart: ['cart', 'productionCart'], // prettier-ignore
  syntheticGfxCart: ['buildCart'],
  syntheticMap16: ['map16DecodeStub'],
  syntheticOverworld: ['syntheticOverworldRom'], // prettier-ignore
  syntheticPlatforms: ['platformCart'],
  syntheticPSwitch: ['pswitchRom'],
  syntheticRegistryRom: ['rampRom', 'fakeRom'], // prettier-ignore
  syntheticRom: ['blankStockRom'],
  syntheticSpriteRom: ['buildSyntheticRom'],
  layer3Cart: ['layer3Cart'], // prettier-ignore
  clusterPathStandIn: ['clusterPathStandIn'],
  marioGraphicsFixture: ['marioGraphicsFixture'], // prettier-ignore
  syntheticCompanion: ['syntheticCompanion'],
  syntheticDrawProbes: ['syntheticDrawProbes'], // prettier-ignore
  syntheticLoaderStandIns: ['syntheticLoaderStandIns'],
  syntheticLayer3: ['syntheticLayer3'], // prettier-ignore
  staircaseB: ['staircaseB'],
  verticalTable: ['verticalTable'],
  skipChain: ['skipChain'],
}
const NOT_BUILDERS = ['asm65', 'captures', 'cartBytes', 'catalogAcceptance', 'collisionBaseline', 'corpus', 'doorBlend', 'fakeAudio', 'ghSpawnReached', 'gitBash', 'gradeTimeline', 'initFacing', 'isolatedGit', 'l1AllowList', 'l1Differential', 'l2UploaderRom', 'le', 'leafGrouping', 'levelSpriteList', 'loadTimeout', 'mapInputs', 'nestedFolders', 'noRealGh', 'oracleImage', 'overworldView', 'romWindows', 'singleStep', 'spriteGrade', 'spritePosition', 'syntheticEeries', 'syntheticGm11Spans', 'syntheticGrinder', 'syntheticMode7', 'syntheticSpcUpload', 'userText', 'vanillaWindows', 'vscodeStub'] // prettier-ignore

// RATCHET (D157). Windows each builder shares with the vanilla ROM today (one machine, 2026-11-05, vanilla
// US, windows not runs). Counts fall to 0 through #1253; a count that changes, up or down, fails, and a
// builder missing here fails. Builders are NOT changed in this branch.
const PIN: Record<string, number> = { stub: 5, blankStockRom: 76, syntheticOverworldRom: 230, buildSyntheticRom: 2, platformCart: 1, pswitchRom: 26, rampRom: 0, fakeRom: 0, map16DecodeStub: 0, buildCart: 57, bgModeRom: 9, modeTablesRom: 20, cart: 0, productionCart: 7, layer3Cart: 2, clusterPathStandIn: 0, marioGraphicsFixture: 0, syntheticCompanion: 0, syntheticDrawProbes: 0, syntheticLoaderStandIns: 0, syntheticLayer3: 0, staircaseB: 0, verticalTable: 0, skipChain: 0 } // prettier-ignore

describe('4a: synthetic ROM builders carry no vanilla window', () => {
  const files = readdirSync(join(REPO, 'test/suite/support'))
    .filter(f => f.endsWith('.ts'))
    .map(f => f.replace(/\.ts$/, ''))

  it('every support module is a builder host or listed helper-only (a new one must be added)', () => {
    const known = [...Object.keys(HOSTS), ...NOT_BUILDERS]
    expect(files.filter(f => !known.includes(f))).toEqual([])
    expect(known.filter(f => !files.includes(f))).toEqual([]) // a stale entry
    expect(Object.keys(HOSTS).filter(f => NOT_BUILDERS.includes(f))).toEqual([])
  })

  it('BUILDERS, the hosts and the pin name the same builders (a new one fails until pinned)', () => {
    expect(Object.keys(PIN).sort()).toEqual(Object.keys(BUILDERS).sort())
    expect(Object.values(HOSTS).flat().sort()).toEqual(Object.keys(BUILDERS).sort())
  })

  it('the sweep can fail: a window copied into a builder output is found', () => {
    const source = prng(2048, 0xabc)
    const out = prng(256, 0xdef)
    out.set(source.subarray(500, 512), 100)
    expect(bytesHits(out, windowSet(source)).length).toBeGreaterThan(0)
  })

  describe.skipIf(!hasRom(VANILLA))('against the vanilla ROM', () => {
    const real = windowSet(hasRom(VANILLA) ? readFileSync(romPath(VANILLA)) : new Uint8Array(0))
    it.each(Object.keys(BUILDERS))('%s: pinned vanilla windows', name => {
      const out = BUILDERS[name]!()
      const windows = [out].flat().reduce(
        (n: number, b: Uint8Array) => n + bytesHits(b, real).reduce((m: number, h: { windows: number }) => m + h.windows, 0), // prettier-ignore
        0,
      )
      // Counts only, never bytes.
      expect(windows, name).toBe(PIN[name])
    })
  })
})

describe.skipIf(!hasRom(VANILLA))('rom-window rule against the real vanilla ROM', () => {
  it('a planted run of 8 real bytes is red in every notation; an invented run passes', () => {
    const rom = readFileSync(romPath(VANILLA))
    const real = windowSet(rom)
    let at = 0x8000
    while (!isCandidate(rom.subarray(at, at + 8))) at++
    const planted = rom.subarray(at, at + 8)
    for (const n of NAMES)
      expect(checkRomWindows('f.ts', text(n, planted), real), n).toHaveLength(1)
    const invented = prng(8, 0x77).map(b => b | 1)
    expect(real.has(Buffer.from(invented).toString('latin1'))).toBe(false)
    expect(checkRomWindows('f.ts', text('hex array', invented), real)).toEqual([])
  })
})
