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

describe('rom-window rule, a synthetic ROM injected through the lookup seam', () => {
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
    cpSync(join(REPO, 'test/suite/support/corpus.cjs'), join(dir, 'test/suite/support/corpus.cjs'))
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

  it('CLI with a ROM exits 1 naming the line; with none it exits 0 and says "not checked"', () => {
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
    expect(green.stderr.toString()).toContain('rom-window rule not checked: no ROM')

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
})

// Builders that assemble a synthetic cart. Add a new one here: the guard below fails until you do.
const BUILDERS: Record<string, () => Uint8Array> = {
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
}
// Support modules the builders above come from, and helper-only ones that assemble no cart.
const COVERED = ['syntheticAreas', 'bgModeRom', 'l3Rom', 'syntheticCart', 'syntheticGfxCart', 'syntheticMap16', 'syntheticOverworld', 'syntheticPlatforms', 'syntheticPSwitch', 'syntheticRegistryRom', 'syntheticRom', 'syntheticSpriteRom'] // prettier-ignore
const NOT_BUILDERS = ['syntheticSpcUpload', 'syntheticEeries', 'syntheticGm11Spans', 'syntheticGrinder', 'syntheticMode7', 'l2UploaderRom'] // prettier-ignore

// Windows each builder shares with the vanilla ROM today (one machine, 2026-10-28, windows not runs).
// Reported to the BA under #1053; builders are NOT changed here. Delete an entry when its builder is
// cleaned; the gate for a builder not listed is zero.
const KNOWN_HITS: Record<string, number> = { stub: 5, blankStockRom: 76, syntheticOverworldRom: 1295, buildSyntheticRom: 2, platformCart: 1, pswitchRom: 26, buildCart: 57, bgModeRom: 9, modeTablesRom: 20, productionCart: 7 } // prettier-ignore

describe('4a: synthetic ROM builders carry no vanilla window', () => {
  it('every builder-shaped support module is listed (a new one must be added)', () => {
    const files = readdirSync(join(REPO, 'test/suite/support'))
      .filter(f => /^synthetic.*\.ts$|Rom\.ts$/.test(f))
      .map(f => f.replace(/\.ts$/, ''))
    expect(files.filter(f => !COVERED.includes(f) && !NOT_BUILDERS.includes(f))).toEqual([])
  })

  it('the sweep can fail: a window copied into a builder output is found', () => {
    const source = prng(2048, 0xabc)
    const out = prng(256, 0xdef)
    out.set(source.subarray(500, 512), 100)
    expect(bytesHits(out, windowSet(source)).length).toBeGreaterThan(0)
  })

  describe.skipIf(!hasRom(VANILLA))('against the vanilla ROM', () => {
    const real = windowSet(hasRom(VANILLA) ? readFileSync(romPath(VANILLA)) : new Uint8Array(0))
    it.each(Object.keys(BUILDERS))('%s: zero vanilla windows', name => {
      const hits = bytesHits(BUILDERS[name]!(), real)
      // Counts only, never bytes. A builder over its baseline fails; one under it must lower it.
      const windows = hits.reduce((n: number, h: { windows: number }) => n + h.windows, 0)
      expect(windows).toBe(KNOWN_HITS[name] ?? 0)
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
