/**
 * The content gate's ROM-window rule (#1053): an added text file holding a run that matches an 8-byte
 * window of the vanilla ROM is blocked. The synthetic half builds PRNG ROMs in the test and runs in CI;
 * the real-ROM half needs the corpus. Planted bytes are made at test time, never printed or committed.
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkRomWindows, evaluateEntry } from '../../../tools/scripts/check-content.mjs'
import {
  isCandidate,
  windowSet,
  // @ts-expect-error plain ESM without types
} from '../../../tools/scripts/lib/rom-windows.mjs'
import { hasRom, romPath, VANILLA } from '../support/corpus'

const REPO = join(__dirname, '../../..')
const tmp = mkdtempSync(join(tmpdir(), 'cg-romwin-'))
afterAll(() => {
  if (process.platform === 'win32') spawnSync('icacls', [tmp, '/reset', '/T', '/C', '/Q']) // the unreadable-ROM case
  rmSync(tmp, { recursive: true, force: true })
})

/** The gate script plus what it imports, laid out as in the repo, so a throwaway repo can run it. */
function installGate(dir: string): void {
  mkdirSync(join(dir, 'test/suite/support'), { recursive: true })
  mkdirSync(join(dir, 'tools/scripts'), { recursive: true })
  cpSync(join(REPO, 'tools/scripts'), join(dir, 'tools/scripts'), { recursive: true })
  cpSync(join(REPO, 'test/suite/support/corpus.cjs'), join(dir, 'test/suite/support/corpus.cjs'))
}

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
      const loop4 = Uint8Array.from([9, 4, 7, 2, 9, 4, 7, 2]) // period 4, the longest ignored
      const rom2 = prng(256)
      for (const [i, w] of [ramp, wrap, loop, loop4].entries()) rom2.set(w, 20 + i * 20)
      const set2 = windowSet(rom2)
      for (const w of [ramp, wrap, loop, loop4])
        for (const n of NAMES) expect(checkRomWindows('f.ts', text(n, w), set2), n).toEqual([])
    })

    it('a comment on every line does not break a run, in either comment style', () => {
      const run = rom.subarray(300, 396) // 96 bytes, 3 per line
      const line = (i: number, c: string) =>
        `  ${Array.from(run.subarray(i * 3, i * 3 + 3), x => `0x${h2(x)}`).join(', ')}, ${c}`
      for (const style of [(i: number) => `// step ${i}`, (i: number) => `/* step ${i} */`]) {
        const body = Array.from({ length: 32 }, (_, i) => line(i, style(i))).join('\n')
        expect(
          checkRomWindows('f.ts', Buffer.from(`const a = [\n${body}\n]\n`), set),
          style(1),
        ).toHaveLength(1)
      }
    })

    it('no lookup, a lockfile and a binary blob are not scanned; any has() object is a lookup', () => {
      const t = text('hex array', planted)
      expect(checkRomWindows('f.ts', t, null)).toEqual([])
      expect(checkRomWindows('package-lock.json', t, set)).toEqual([])
      expect(checkRomWindows('f.ts', Buffer.concat([t, Buffer.from([0])]), set)).toEqual([])
      // Any object with has() is a lookup, not only a Set.
      const only = new Set([Buffer.from(planted).toString('latin1')])
      expect(checkRomWindows('f.ts', t, { has: (k: string) => only.has(k) })).toHaveLength(1)
    })
  },
)

// The CLI end to end in throwaway repos. The fake vanilla ROM is found through HACKBENCH_ROMS and must
// pass the gate's own checks: a regular file of 512 KiB with a valid LoROM checksum, built here.
const BIG = 512 * 1024
function vanillaFile(plants: Uint8Array[] = [], len = BIG, header = false): Uint8Array {
  const b = prng(len, 0xbada55)
  plants.forEach((p, i) => b.set(p, 4096 + i * 64))
  if (len >= 0x7fe0) {
    b.set([0, 0, 255, 255], 0x7fdc)
    const sum = b.reduce((n, v) => (n + v) & 0xffff, 0)
    b.set([~sum & 255, (~sum >> 8) & 255, sum & 255, sum >> 8], 0x7fdc)
  }
  return header ? Uint8Array.from([...new Uint8Array(512), ...b]) : b
}
const romsDir = (name: string, bytes?: Uint8Array | 'dir'): string => {
  const d = join(tmp, `roms-${name}`)
  mkdirSync(d, { recursive: true })
  if (bytes === 'dir') mkdirSync(join(d, VANILLA))
  else if (bytes) writeFileSync(join(d, VANILLA), bytes)
  return d
}
const cli = (dir: string, roms: string, args: string[], input?: string) =>
  spawnSync('node', ['tools/scripts/check-content.mjs', ...args], {
    cwd: dir,
    input,
    env: { ...process.env, HACKBENCH_ROMS: roms },
  })
// Deny this user read access (icacls on Windows, chmod elsewhere); a root user may still read it.
const denyRead = (f: string) =>
  process.platform === 'win32'
    ? spawnSync('icacls', [f, '/deny', `${process.env.USERNAME}:(R)`])
    : spawnSync('chmod', ['000', f])
const NOT_RUN = /rule DID NOT RUN: /
const ident = ['-c', 'user.email=t@e.com', '-c', 'user.name=T']

describe('rom-window rule through the CLI', { timeout: 120000 }, () => {
  const win = (() => {
    const r = prng(4096, 0x1053)
    let i = 200
    while (!isCandidate(r.subarray(i, i + 8))) i++
    return r.subarray(i, i + 8)
  })()
  const run = text('hex array', win)
  const roms = romsDir('good', vanillaFile([win]))
  const none = romsDir('none')
  type Repo = { dir: string; g: (...a: string[]) => string }

  // develop adds theirs.ts (a run) after the feature branched; the feature merges develop.
  function repo(): Repo {
    const dir = mkdtempSync(join(tmp, 'net-'))
    installGate(dir)
    const g = (...a: string[]) =>
      spawnSync('git', [...ident, ...a], { cwd: dir })
        .stdout.toString()
        .trim()
    g('init', '-q', '-b', 'develop')
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
  const commitFile = (r: Repo, name: string, body: Buffer | string) => {
    writeFileSync(join(r.dir, name), body)
    r.g('add', '-A')
    r.g('commit', '-q', '-m', name)
  }
  const range = (dir: string, env = roms) => cli(dir, env, ['range', 'develop', 'feature'])
  const bare = () => {
    const remote = mkdtempSync(join(tmp, 'remote-'))
    spawnSync('git', ['init', '-q', '--bare', remote])
    return remote
  }
  const push = (r: Repo, env = roms) =>
    cli(
      r.dir,
      env,
      ['push', 'origin'],
      `refs/heads/feature ${r.g('rev-parse', 'feature')} x ${'0'.repeat(40)}\n`,
    )
  const out = (p: { stdout: Buffer; stderr: Buffer }) => `${p.stdout}${p.stderr}`
  it('staged: red naming the line; modified, .md and clean pass; a rename and comments count', () => {
    const dir = mkdtempSync(join(tmp, 'st-'))
    installGate(dir)
    const g = (...a: string[]) => spawnSync('git', [...ident, ...a], { cwd: dir })
    g('init', '-q')
    writeFileSync(join(dir, 'f.ts'), text('\\x string', win))
    g('add', 'f.ts')
    const red = cli(dir, roms, ['staged'])
    expect(red.status).toBe(1)
    expect(red.stdout.toString()).toMatch(/BLOCKED \(rom-window\): f\.ts line 1, \d+ windows?/)
    g('commit', '-q', '-m', 'add')
    writeFileSync(join(dir, 'f.ts'), `${text('\\x string', win)}// edit\n`)
    g('add', 'f.ts')
    expect(cli(dir, roms, ['staged']).status).toBe(0) // modified, not added
    g('reset', '-q', '--hard')
    g('mv', 'f.ts', 'renamed.ts')
    expect(cli(dir, roms, ['staged']).stdout.toString()).toContain('renamed.ts') // --no-renames
    g('reset', '-q', '--hard')
    g('rm', '-q', '-f', 'f.ts')
    writeFileSync(join(dir, 'f.md'), run)
    g('add', 'f.md')
    expect(cli(dir, roms, ['staged']).status).toBe(0) // .md is excluded
    // A path ending in cmd or mmd is not markdown, and a comment is scanned too (both public).
    writeFileSync(join(dir, 'fix.cmd'), run)
    writeFileSync(join(dir, 'fix.mmd'), run)
    writeFileSync(join(dir, 'c.ts'), `// ${run}`)
    g('add', '-A')
    const o = cli(dir, roms, ['staged']).stdout.toString()
    for (const f of ['fix.cmd', 'fix.mmd', 'c.ts']) expect(o).toContain(`rom-window): ${f}`)
    expect(o).not.toContain('f.md')
  })

  it('range: a file merged in from develop is not judged; one the branch adds is', () => {
    const r = repo()
    expect(range(r.dir).status).toBe(0)
    commitFile(r, 'planted.ts', run)
    const red = range(r.dir)
    expect(red.status).toBe(1)
    expect(red.stdout.toString()).toMatch(/rom-window\): planted\.ts/)
    expect(red.stdout.toString()).not.toContain('theirs.ts')
  })

  it.each(['first-parent', 'combined', 'dense-combined', 'off'])(
    'range: a file only a merge adds is judged with log.diffMerges=%s',
    mode => {
      const r = repo()
      r.g('config', 'log.diffMerges', mode)
      r.g('checkout', '-q', '-b', 'side', 'develop~1')
      commitFile(r, 'side.ts', 'export const s = 1\n')
      r.g('checkout', '-q', 'feature')
      r.g('merge', '-q', '--no-commit', '--no-ff', 'side')
      writeFileSync(join(r.dir, 'resolved.ts'), run) // added by the merge itself
      r.g('add', '-A')
      r.g('commit', '-q', '-m', 'merge side')
      expect(range(r.dir).stdout.toString()).toContain('rom-window): resolved.ts')
    },
  )

  it('range: a run committed then removed or rewritten is blocked; a later edit is not judged', () => {
    const r = repo()
    commitFile(r, 'gone.ts', run)
    r.g('rm', '-q', 'gone.ts')
    r.g('commit', '-q', '-m', 'remove')
    commitFile(r, 'rew.ts', run)
    commitFile(r, 'rew.ts', 'export const b = 2\n')
    const o = range(r.dir).stdout.toString()
    expect(o).toContain('rom-window): gone.ts')
    expect(o).toContain('rom-window): rew.ts')
    const late = repo()
    commitFile(late, 'late.ts', 'export const b = 1\n')
    commitFile(late, 'late.ts', run) // modified, so never judged: the known limit
    expect(range(late.dir).status).toBe(0)
  })

  describe('push', () => {
    const withRemote = () => {
      const r = repo()
      r.g('remote', 'add', 'origin', bare())
      r.g('push', '-q', 'origin', 'develop')
      return r
    }
    it('judges what the remote does not have; a merge of develop stays green', () => {
      const r = withRemote()
      expect(push(r).status).toBe(0)
      commitFile(r, 'planted.ts', run)
      expect(push(r).status).toBe(1)
    })

    it('stays green when the remote moved on to commits this clone does not have', () => {
      const r = withRemote()
      const other = join(tmp, `other-${Math.random()}`)
      spawnSync('git', ['clone', '-q', '-b', 'develop', r.g('remote', 'get-url', 'origin'), other])
      const gc = (...a: string[]) => spawnSync('git', [...ident, ...a], { cwd: other })
      writeFileSync(join(other, 'newer.txt'), 'x\n')
      gc('add', '-A')
      gc('commit', '-q', '-m', 'develop moved')
      gc('push', '-q', 'origin', 'develop')
      const p = push(r) // ls-remote names a develop tip we lack; origin/develop names the old one
      expect(p.status, out(p)).toBe(0)
    })

    // A tracking ref the remote no longer backs must not hide a run. Each case leaves origin/<name> at a
    // commit holding a run while the remote advertises something else (or nothing) for that name.
    describe('a stale remote-tracking ref hides nothing', () => {
      const stale = () => {
        const r = withRemote()
        commitFile(r, 'planted.ts', run)
        r.g('push', '-q', 'origin', 'feature')
        const other = join(tmp, `stale-${Math.random()}`)
        spawnSync('git', [
          'clone',
          '-q',
          '-b',
          'feature',
          r.g('remote', 'get-url', 'origin'),
          other,
        ])
        const gc = (...a: string[]) => spawnSync('git', [...ident, ...a], { cwd: other })
        return { r, gc }
      }
      it('origin pointed at an empty repository while origin/develop holds a run', () => {
        const r = withRemote()
        r.g('remote', 'set-url', 'origin', bare())
        expect(push(r).status).toBe(1) // theirs.ts is in no ref the remote has
      })
      it('the remote force-pushed the run away and this clone has not fetched', () => {
        const { r, gc } = stale()
        gc('push', '-q', '-f', 'origin', 'feature~1:refs/heads/feature')
        expect(push(r).status).toBe(1)
      })
      it('the branch was deleted on the remote, not pruned, and is pushed again', () => {
        const { r, gc } = stale()
        gc('push', '-q', 'origin', ':feature')
        expect(push(r).status).toBe(1)
      })
    })

    it('an empty remote, or one whose tips are all unknown here, still judges every added file', () => {
      const r = repo()
      r.g('remote', 'add', 'origin', bare())
      const empty = push(r)
      expect(empty.status).toBe(1)
      expect(empty.stdout.toString()).toContain('theirs.ts')
      const stranger = join(tmp, `stranger-${Math.random()}`)
      mkdirSync(stranger)
      const gu = (...a: string[]) => spawnSync('git', [...ident, ...a], { cwd: stranger })
      gu('init', '-q', '-b', 'stranger')
      gu('commit', '-q', '--allow-empty', '-m', 'unrelated')
      gu('push', '-q', r.g('remote', 'get-url', 'origin'), 'stranger')
      expect(push(r).status).toBe(1)
    })
  })

  it('says it did not run: staged, range, push and history, with a reason each', () => {
    const r = repo()
    commitFile(r, 'planted.ts', run)
    r.g('remote', 'add', 'origin', bare())
    const runs = [
      cli(r.dir, none, ['staged']),
      range(r.dir, none),
      push(r, none),
      cli(r.dir, none, ['history']),
    ]
    for (const p of runs) {
      expect(p.stderr.toString()).toMatch(NOT_RUN)
      expect(out(p)).not.toMatch(/\b(clean|passed|ok)\b/i)
    }
    for (const p of runs.slice(0, 3)) expect(p.stderr.toString()).toContain('no vanilla ROM')
    expect(runs[3]!.stderr.toString()).toContain('history mode')
    expect(runs[3]!.stderr.toString()).not.toContain('no vanilla ROM')
  })

  const BAD: [string, () => string][] = [
    ['0 bytes', () => romsDir('b0', new Uint8Array(0))],
    ['7 bytes', () => romsDir('b7', new Uint8Array(7))],
    ['truncated', () => romsDir('btr', vanillaFile([win]).subarray(0, 400 * 1024))],
    ['wrong bytes at full size', () => romsDir('bwr', prng(BIG, 7))],
    ['a corrupted byte', () => romsDir('bco', Uint8Array.from(vanillaFile([win]), (v, i) => (i === 9000 ? v ^ 1 : v)))], // prettier-ignore
    ['a directory', () => romsDir('bdir', 'dir')],
    // Over 2 GiB: readFileSync refuses it with ERR_FS_FILE_TOO_LARGE, so the size is judged from stat.
    ['over 2 GiB', () => { const d = romsDir('bhuge', new Uint8Array(0)); truncateSync(join(d, VANILLA), 3 * 1024 ** 3); return d }], // prettier-ignore
    // Unreadable (EPERM): read access denied to this user; skipped if the denial does not take.
    ['unreadable', () => { const d = romsDir('bperm', vanillaFile([win])); const f = join(d, VANILLA); denyRead(f); try { readFileSync(f) } catch { return d } return romsDir('bnone') }], // prettier-ignore
  ]
  it.each(BAD)(
    'a vanilla-path file that is not a usable ROM (%s): did not run, no crash',
    (_n, make) => {
      const r = repo()
      commitFile(r, 'planted.ts', run)
      const p = range(r.dir, make())
      expect(p.status).toBe(0)
      expect(p.stderr.toString()).toMatch(/DID NOT RUN: the file at the vanilla ROM path (is not a regular file|is \d+ bytes|cannot be read|fails its internal checksum)/) // prettier-ignore
      expect(p.stderr.toString()).not.toMatch(/\bat .*\.mjs|Error:/)
    },
  )

  it('a valid ROM with a copier header is used; the ROM is not read when no file qualifies; a gitlink is skipped', () => {
    const r = repo()
    commitFile(r, 'planted.ts', run)
    expect(range(r.dir, romsDir('hdr', vanillaFile([win], BIG, true))).status).toBe(1)
    const m = repo() // only a modified file is staged: nothing qualifies, so a bad ROM is never opened
    commitFile(m, 'mine.ts', 'export const a = 3\n')
    writeFileSync(join(m.dir, 'mine.ts'), 'export const a = 4\n')
    m.g('add', '-A')
    const p = cli(m.dir, romsDir('bdir2', 'dir'), ['staged'])
    expect(p.status).toBe(0)
    expect(p.stderr.toString()).not.toContain('not a regular file')
    // A gitlink in the diff is skipped.
    r.g('update-index', '--add', '--cacheinfo', `160000,${r.g('rev-parse', 'HEAD')},sub`)
    expect(cli(r.dir, roms, ['staged']).status).toBe(0)
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
