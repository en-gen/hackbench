// The ROM-window probe (tools/scripts/rom-window-probe.mjs). Every ROM here is
// PRNG bytes built in the test, so this runs in CI with no corpus.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM without types
import {
  bytesHits,
  commentMode,
  locateVanillaRom,
  stripComments,
  textHits,
  textRuns,
  windowSet,
} from '../../../tools/scripts/lib/rom-windows.mjs'
import { resolveRomDir, VANILLA } from '../support/corpus'

const REPO = join(__dirname, '../../..')
const CLI = join(REPO, 'tools/scripts/rom-window-probe.mjs')

function prng(n: number, seed = 0x1234abcd): Uint8Array {
  const out = new Uint8Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = s >>> 24
  }
  return out
}
const hex = (b: ArrayLike<number>) => Array.from(b, x => x.toString(16).padStart(2, '0')).join(' ')
const ROM = prng(4096)
const SET = windowSet(ROM)
const dir = mkdtempSync(join(tmpdir(), 'rom-window-probe-'))
const put = (name: string, data: Uint8Array | string) => {
  const p = join(dir, name)
  writeFileSync(p, data)
  return p
}
const romFile = put('fake.sfc', ROM)
const probe = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  })

describe('window set and filter', () => {
  it('(a) a planted 8-byte copy is a hit, as text and as assembled bytes', () => {
    const run = ROM.subarray(100, 108)
    expect(textHits(`db ${hex(run)}`, SET)).toMatchObject([{ at: 1, windows: 1 }])
    const blob = new Uint8Array([1, 2, 3, ...run, 9])
    expect(bytesHits(blob, SET, 8)).toMatchObject([{ at: 3, windows: 1 }])
  })
  it('(b) a 7-byte copy stays green', () => {
    const run = ROM.subarray(100, 107)
    expect(textHits(`db ${hex(run)}`, SET)).toEqual([])
    expect(bytesHits(new Uint8Array([...run, 0xee]), SET, 8)).toEqual([])
  })
  it('(c) a low-variety window is filtered', () => {
    const rom = prng(64)
    rom.set([0, 0, 0, 0, 0, 0, 0, 1], 20)
    const set = windowSet(rom)
    expect(textHits('db 00 00 00 00 00 00 00 01', set)).toEqual([])
    expect(bytesHits(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), set, 8)).toEqual([])
  })
  it('(d) a 512-byte copier header is stripped', () => {
    const withHeader = new Uint8Array(512 + ROM.length)
    withHeader.set(ROM, 512)
    expect(windowSet(withHeader)).toEqual(SET)
  })
  it('never holds a window that straddles the copier header and the body', () => {
    const header = prng(512, 77)
    const withHeader = new Uint8Array(512 + ROM.length)
    withHeader.set(header)
    withHeader.set(ROM, 512)
    const straddle = [...header.subarray(508), ...ROM.subarray(0, 4)]
    expect(new Set(straddle).size).toBeGreaterThanOrEqual(3)
    expect(bytesHits(Uint8Array.from(straddle), windowSet(withHeader), 8)).toEqual([])
  })
  it('tokenizes 0x literals and decimal lists with line numbers', () => {
    const run = ROM.subarray(300, 308)
    const dec = `x\n[${Array.from(run).join(', ')}]`
    expect(textHits(dec, SET)).toMatchObject([{ at: 2, windows: 1 }])
    expect(
      textHits(Array.from(run, b => '0x' + b.toString(16).padStart(2, '0')).join(', '), SET),
    ).toHaveLength(1)
  })
})

describe('ROM lookup', () => {
  it('matches corpus.ts for the same env', () => {
    const exists = (p: string) => p.includes(join('tools-x', 'hackbench-tools', 'roms'))
    for (const env of [
      { HACKBENCH_ROMS: join(dir, 'r') },
      { HACKBENCH_TOOLS: join(dir, 't') },
      {},
    ]) {
      const repo = join(dir, 'tools-x', 'hackbench')
      expect(locateVanillaRom(env, repo, exists)).toBe(
        join(resolveRomDir(env, repo, exists), VANILLA),
      )
    }
  })
})

const h2 = (b: number) => b.toString(16).padStart(2, '0')
// One window rendered as source text in each supported form.
const FORMS: Record<string, (w: ArrayLike<number>) => string> = {
  bare: w => hex(w),
  dollar: w => Array.from(w, b => '$' + b.toString(16)).join(', '),
  'dollar upper': w => Array.from(w, b => '$' + h2(b).toUpperCase()).join(' '),
  '0x': w => Array.from(w, b => '0x' + b.toString(16)).join(', '),
  decimal: w => `[${Array.from(w).join(', ')}]`,
  'decimal, multi-line': w => `[${Array.from(w).join(',\n  ')}]`,
  mixed: w =>
    Array.from(w, (b, i) =>
      i % 3 === 0 ? '0x' + b.toString(16) : i % 3 === 1 ? String(b) : '$' + b.toString(16),
    ).join(', '),
  'trailing comments': w => Array.from(w, b => `0x${h2(b)}, // LDA $05 be ad de`).join('\n'),
  'block comments': w => Array.from(w, b => `0x${h2(b)}, /* ad\n be */`).join('\n'),
}

describe('sweep', () => {
  // A window with exactly d distinct values, planted in a fresh fake ROM.
  const planted = (d: number) => {
    const w = Array.from({ length: 8 }, (_, i) => 0x30 + (i % d) * 0x11)
    const rom = prng(1024, 99 + d)
    rom.set(w, 300)
    return { w, set: windowSet(rom) }
  }
  for (let d = 2; d <= 8; d++)
    for (const [name, render] of Object.entries(FORMS))
      it(`${d} distinct values, ${name}`, () => {
        const { w, set } = planted(d)
        expect(textHits(render(w), set).length > 0).toBe(d >= 3)
        expect(textHits(render(w.slice(0, 7)), set)).toEqual([])
        expect(bytesHits(Uint8Array.from(w), set, 8).length > 0).toBe(d >= 3)
      })
  it('does not read comment markers inside strings', () => {
    const w = hex(ROM.subarray(100, 108))
    for (const text of [
      `const u = 'http://x'; db ${w}`,
      `const g = "src/*"
${w}
/* end */`,
      `const t = \`a // b\`, ${w}`,
    ])
      expect(textHits(text, SET)).toHaveLength(1)
    expect(stripComments("x // c\n'a//b'")).toBe("x     \n'a//b'")
  })
  it('knows which files have which comments', () => {
    expect(['a.asm', 'a.INC', 'a.s'].map(commentMode)).toEqual(['asm', 'asm', 'asm'])
    expect(['a.ts', 'a.mjs', 'a.cjs', 'a.js', 'a.tsx'].map(commentMode)).toEqual(
      Array(5).fill('js'),
    )
    expect(['a.md', 'a.lua', 'a.txt'].map(commentMode)).toEqual(['none', 'none', 'none'])
  })
  it('reads a one-digit 0x token', () => {
    const w = [9, 1, 15, 3, 10, 5, 2, 7]
    const rom = prng(256, 3)
    rom.set(w, 60)
    expect(textHits('0x9, 0x1, 0xf, 0x3, 0xa, 0x5, 0x2, 0x7', windowSet(rom))).toHaveLength(1)
  })
  it('finds the first and last window of the ROM', () => {
    for (const at of [0, ROM.length - 8]) {
      const w = ROM.subarray(at, at + 8)
      expect(new Set(w).size).toBeGreaterThanOrEqual(3)
      expect(bytesHits(w, SET, 8)).toHaveLength(1)
      expect(textHits(hex(w), SET)).toHaveLength(1)
    }
  })
  it('keeps two runs in one input separate', () => {
    const a = hex(ROM.subarray(100, 108))
    const b = hex(ROM.subarray(200, 208))
    expect(textHits(`${a}\nlet x = 1\n${b}`, SET).map(h => h.at)).toEqual([1, 3])
    const blob = Uint8Array.from([...ROM.subarray(100, 108), 0xee, ...ROM.subarray(200, 208)])
    expect(bytesHits(blob, SET, 8).map(h => [h.at, h.windows])).toEqual([
      [0, 1],
      [9, 1],
    ])
  })
  it('counts overlapping windows of one run once', () => {
    expect(bytesHits(ROM.subarray(50, 60), SET, 8)).toMatchObject([{ at: 0, windows: 3 }])
  })
  it('does not read a value over 255 as a byte', () => {
    const w = [10, 20, 0, 30, 40, 50, 60, 70]
    const rom = prng(256, 5)
    rom.set(w, 40)
    const set = windowSet(rom)
    expect(textHits(w.join(', '), set)).toHaveLength(1)
    expect(textHits('10, 20, 256, 30, 40, 50, 60, 70', set)).toEqual([])
    const top = Uint8Array.from([255, 1, 2, 3, 4, 5, 6, 7])
    expect(textHits('255, 1, 2, 3, 4, 5, 6, 7', windowSet(top))).toHaveLength(1)
  })
})

describe('CLI', () => {
  const hit = put('hit.txt', `// a\ndb ${hex(ROM.subarray(500, 508))}\n`)
  const clean = put('clean.txt', `db ${hex(prng(8, 7))}\n`)
  const blob = put('hit.bin', new Uint8Array([5, 5, ...ROM.subarray(10, 18)]))
  it('exits 1 with HIT lines and a TOTAL', () => {
    const r = probe(['--rom', romFile, hit])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(`HIT ${hit}:2 windows=1`)
    expect(r.stdout).toContain('TOTAL files=1 filesWithHits=1 hitWindows=1')
    expect(r.stdout).not.toContain(hex(ROM.subarray(500, 508)))
  })
  it('exits 0 when clean', () => {
    const r = probe(['--rom', romFile, clean])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('TOTAL files=1 filesWithHits=0 hitWindows=0')
  })
  it('--bin reports offsets', () => {
    const r = probe(['--rom', romFile, '--bin', blob])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('offset=0x2 windows=1')
  })
  it('finds the ROM through the env lookup', () => {
    put('Super Mario World (USA).vanilla.sfc', ROM)
    expect(probe([hit], { HACKBENCH_ROMS: dir }).status).toBe(1)
  })
  it('exits 2 with SKIP on stderr when no ROM exists', () => {
    const r = probe([hit], { HACKBENCH_ROMS: join(dir, 'nowhere') })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('SKIP: vanilla ROM not found (looked:')
  })
  it('exits 2 for an explicit --rom that does not exist', () => {
    const r = probe(['--rom', join(dir, 'missing.sfc'), hit])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('missing.sfc')
  })
  it('--repo never moves the ROM lookup', () => {
    // A copy of the probe beside tools A; --repo points at a tree beside tools B, which alone holds
    // the window. The lookup must find A (this checkout) and so see no hit.
    const mk = (name: string, romBytes: Uint8Array) => {
      const base = join(dir, name)
      mkdirSync(join(base, 'hackbench-tools', 'roms'), { recursive: true })
      mkdirSync(join(base, 'repo'), { recursive: true })
      writeFileSync(join(base, 'hackbench-tools', 'roms', VANILLA), romBytes)
      return base
    }
    const a = mk('toolsA', prng(4096, 11))
    const b = mk('toolsB', prng(4096, 22))
    const copy = join(a, 'repo')
    cpSync(join(REPO, 'tools/scripts'), join(copy, 'tools/scripts'), { recursive: true })
    cpSync(join(REPO, 'test/suite/support/corpus.cjs'), join(copy, 'test/suite/support/corpus.cjs'))
    const file = put(
      'onlyB.txt',
      `db ${hex(prng(4096, 22).subarray(100, 108))}
`,
    )
    const r = spawnSync(
      process.execPath,
      [join(copy, 'tools/scripts/rom-window-probe.mjs'), '--repo', join(b, 'repo'), file],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
    )
    expect(r.stdout).toContain('TOTAL files=1 filesWithHits=0')
    expect(r.status).toBe(0)
  })
  it('prints earlier HIT lines before exiting 2 on an unreadable file', () => {
    const r = probe(['--rom', romFile, hit, join(dir, 'absent.txt')])
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('HIT ')
    expect(r.stderr).toContain('ERROR')
  })
  it('exits 2 with no input', () => {
    expect(probe(['--rom', romFile]).status).toBe(2)
  })
  it('reads comments by file type', () => {
    const lines = (f: (b: number) => string) => Array.from(ROM.subarray(100, 108), f).join('\n')
    const asm = put(
      'c.asm',
      lines(b => `.db $${h2(b)} ; be ad de`),
    )
    const md = put(
      'c.md',
      lines(b => `${h2(b)} // be ad de`),
    )
    const ts = put(
      'c.ts',
      lines(b => `0x${h2(b)}, // be ad de`),
    )
    expect(probe(['--rom', romFile, asm]).status).toBe(1)
    expect(probe(['--rom', romFile, ts]).status).toBe(1)
    expect(probe(['--rom', romFile, md]).status).toBe(0)
  })
  it('exits 2 when git fails', () => {
    const r = probe(['--rom', romFile, '--repo', dir, '--git-range', 'nope..nada'])
    expect(r.status).toBe(2)
  })

  describe('argument errors', () => {
    const clean = put('clean.ts', 'const a = 1\n')
    it.each([
      ['a trailing --rom', [clean, '--rom']],
      ['a trailing --git-range', ['--rom', romFile, '--git-range']],
      ['a trailing --repo', ['--rom', romFile, '--repo']],
      ['a flag as the --rom value', ['--rom', '--bin', clean]],
      ['files together with --git-range', ['--rom', romFile, '--git-range', 'HEAD', clean]],
    ])('exits 2 on %s', (_n, a) => {
      expect(probe(a as string[]).status).toBe(2)
    })
  })

  describe('textRuns line numbers', () => {
    it('numbers lines correctly and in linear time on a large file', () => {
      const n = 40000
      const text = Array.from({ length: n }, (_, i) => `db $${(i % 200).toString(16)}`).join('\n')
      const t0 = Date.now()
      const runs = textRuns(text, 5, 'asm')
      expect(Date.now() - t0).toBeLessThan(3000)
      const lines = runs.flatMap((r: { lines: number[] }) => r.lines)
      expect(lines.length).toBe(n)
      expect(lines[0]).toBe(5)
      expect(lines[n - 1]).toBe(5 + n - 1)
    })
  })

  describe('--git-range', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rom-window-repo-'))
    const git = (...a: string[]) =>
      spawnSync(
        'git',
        [
          ...['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t'],
          ...['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath='],
          ...a,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '' },
        },
      )
    const write = (name: string, data: Uint8Array | string) => writeFileSync(join(repo, name), data)
    const w = (a: number) => hex(ROM.subarray(a, a + 8))
    git('init', '-q')
    git('config', 'diff.noprefix', 'true')
    write('del.txt', `db ${w(700)}\nkeep\n`)
    write(
      'old.txt',
      `db ${w(1900)}
x
`,
    )
    write('two.txt', 'a\nb\nc\nd\ne\nf\ng\n')
    write('half.txt', `${hex(ROM.subarray(2100, 2104))}\n`)
    write('gone.txt', 'bye\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    write('del.txt', 'keep\n')
    write('two.txt', `db ${w(900)}\nb\nc\nd\ne\nf\ndb ${w(1100)}\n`)
    write('++ odd.txt', `++ x\ndb ${w(1300)}\n`)
    write('é.txt', `db ${w(1500)}\n`)
    write(
      'old.txt',
      `db ${w(1900)}
x
y
`,
    )
    write('plain.txt', 'nothing here\n')
    write('half.txt', `${hex(ROM.subarray(2100, 2104))}\n${hex(ROM.subarray(2104, 2108))}\n`)
    rmSync(join(repo, 'gone.txt'))
    write('cart.bin', Uint8Array.from([0, 0, 0, ...ROM.subarray(1700, 1708), 0, 0]))
    git('add', '.')
    git('commit', '-qm', 'change')
    const r = probe(['--rom', romFile, '--repo', repo, '--git-range', 'HEAD~1..HEAD'])
    const out = r.stdout.split('\n')
    it('exits 1 and counts every touched file', () => {
      expect(r.status).toBe(1)
      expect(out).toContain('TOTAL files=8 filesWithHits=5 hitWindows=6')
    })
    it('finds both hunks of one file', () => {
      expect(out).toContain('HIT two.txt:1 windows=1')
      expect(out).toContain('HIT two.txt:7 windows=1')
    })
    it('ignores deleted lines and pre-existing runs', () => {
      expect(r.stdout).not.toContain('del.txt')
      expect(r.stdout).not.toContain('old.txt')
    })
    it('survives header lookalikes, non-ASCII names and noprefix config', () => {
      expect(out).toContain('HIT ++ odd.txt:2 windows=1')
      expect(out).toContain('HIT é.txt:1 windows=1')
    })
    it('catches a run that starts on an unchanged line and ends on an added one', () => {
      expect(out).toContain('HIT half.txt:1 windows=1')
    })
    it('reads a..b, a...b and a lone rev alike', () => {
      for (const spec of ['HEAD~1...HEAD', 'HEAD~1']) {
        const r2 = probe(['--rom', romFile, '--repo', repo, '--git-range', spec])
        expect(r2.stdout.split('\n').filter(l => l.startsWith('HIT')).length).toBe(6)
      }
    })
    it('a...b diffs from the merge base, not from a', () => {
      git('checkout', '-q', '-b', 'side', 'HEAD~1')
      write(
        'side.txt',
        `db ${w(2300)}
`,
      )
      git('add', 'side.txt')
      git('commit', '-qm', 'side')
      git('checkout', '-q', '-')
      const r2 = probe(['--rom', romFile, '--repo', repo, '--git-range', 'HEAD...side'])
      expect(r2.stdout.split('\n')).toContain('HIT side.txt:1 windows=1')
      expect(r2.stdout).toContain('TOTAL files=1 ')
    })
    it('a lone rev reads the worktree, not the old blob', () => {
      write(
        'plain.txt',
        `nothing
db ${w(2500)}
`,
      )
      const r2 = probe(['--rom', romFile, '--repo', repo, '--git-range', 'HEAD'])
      expect(r2.status).toBe(1)
      expect(r2.stdout.split('\n')).toContain('HIT plain.txt:2 windows=1')
      git('checkout', '--', 'plain.txt')
    })
    it('a lone rev also scans untracked files, text and binary', () => {
      write(
        'fresh.ts',
        `const x = [0x00, ${w(2700)
          .split(' ')
          .map(b => '0x' + b)
          .join(', ')}]\n`,
      )
      write('fresh.bin', Uint8Array.from([0, 0, ...ROM.subarray(2900, 2908), 0]))
      const r2 = probe(['--rom', romFile, '--repo', repo, '--git-range', 'HEAD'])
      expect(r2.status).toBe(1)
      expect(r2.stdout.split('\n')).toContain('HIT fresh.ts:1 windows=1')
      expect(r2.stdout.split('\n')).toContain('HIT fresh.bin offset=0x2 windows=1')
      rmSync(join(repo, 'fresh.ts'))
      rmSync(join(repo, 'fresh.bin'))
    })
    it('prints hits before an error, and a bad range is exit 2', () => {
      expect(probe(['--rom', romFile, '--repo', repo, '--git-range', 'HEAD...nope']).status).toBe(2)
    })
    it('scans untracked files from the repo root when run from a subdirectory', () => {
      mkdirSync(join(repo, 'sub'), { recursive: true })
      write('top-fresh.txt', `db ${w(3000)}\n`)
      const r2 = probe(['--rom', romFile, '--repo', join(repo, 'sub'), '--git-range', 'HEAD'])
      expect(r2.status).toBe(1)
      expect(r2.stdout.split('\n')).toContain('HIT top-fresh.txt:1 windows=1')
      rmSync(join(repo, 'top-fresh.txt'))
    })
    it('does not let a textconv driver turn a binary file into a text one', () => {
      write('conv.dat', Uint8Array.from([0, 0, ...ROM.subarray(3200, 3208), 0]))
      write('.gitattributes', 'conv.dat diff=hexy\n')
      git('config', 'diff.hexy.textconv', 'cat')
      git('add', '.')
      git('commit', '-qm', 'conv')
      const r2 = probe(['--rom', romFile, '--repo', repo, '--git-range', 'HEAD~1..HEAD'])
      expect(r2.stdout.split('\n')).toContain('HIT conv.dat offset=0x2 windows=1')
    })
    it('scans binary files as bytes', () => {
      expect(out).toContain('HIT cart.bin offset=0x3 windows=1')
    })
  })
})
