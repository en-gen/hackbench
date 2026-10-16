/**
 * The sprite report (#828) on synthetic grades: CI has no ROM and no captures.
 * Page counts, refusals, the commit and the contact sheet; the grader itself is
 * covered by spriteGrade.captures.test.ts.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { spawnSync } from 'child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SpriteModel } from '../../../src/rom/sprites/interp/SpriteRunner'
import { runSprite } from '../../../src/rom/sprites/interp/SpriteRunner'
import { loadLevelState } from '../../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import { CAPTURE_DIR, VANILLA, freshRom, hasCaptures, hasRom } from '../support/corpus'
import { timelineFor } from '../support/gradeTimeline'
import { isolatedGit, isolateProcessGit } from '../support/isolatedGit'
import { slow } from '../support/loadTimeout'
import { grade } from '../support/spriteGrade'
import { unzip } from '../../../tools/scripts/capture_render'
import {
  VERDICTS,
  buildReport,
  contactSheet,
  encodePng,
  isInside,
  hardwareSource,
  LEVEL_START_LABEL,
  renderPieces,
  type ReportRow,
  type ReportVerdict,
} from '../../../tools/scripts/spriteReport'
import {
  frameSamples,
  gradeCaptures,
  gradedFrame,
  hardwareCells,
  hardwareFrame,
  hackbenchRepo,
  isValidationRepo,
  oamOrder,
  placeReport,
  run,
  type Graded,
  type Io,
} from '../../../tools/scripts/spriteReportRun'

// Wraps cpSync so one test can make the copy throw partway; everything else is the real fs.
vi.mock('fs', async orig => {
  const a = await orig<typeof import('fs')>()
  return { ...a, cpSync: vi.fn(a.cpSync) }
})

const tmp = mkdtempSync(join(tmpdir(), 'sprite-report-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
// The code under test spawns git with process.env, so isolate the process too (#890).
let restoreGit = (): void => {}
beforeAll(() => {
  restoreGit = isolateProcessGit(join(tmp, 'git-env'))
})
afterAll(() => restoreGit())
const git = (cwd: string, ...a: string[]): string => {
  const r = isolatedGit(cwd, join(tmp, 'no-hooks'), ...a)
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} exited ${r.status}: ${r.stderr}`)
  return r.stdout
}

// Git-heavy tests (30 to 45 git spawns each). Measured worst case: 12 copies of this file at once,
// n=12, one 32-CPU machine shared with other work: 8479 ms for the clone-spellings test, 5.4 s for
// the others (some were cut off by the 5 s default, so their true worst is higher). 20 s is local-load
// headroom, not a CI number; slow() keeps CI's 60 s floor.
const GIT_HEAVY = slow(20_000)

const COUNTS: Record<ReportVerdict, number> = {
  exact: 4,
  shape: 3,
  close: 2,
  wrong: 1,
  empty: 2,
  refused: 1,
}
const rows = (): ReportRow[] =>
  VERDICTS.flatMap((v, vi) =>
    Array.from({ length: COUNTS[v] }, (_, i) => ({
      map: '00' + vi,
      id: vi * 16 + i,
      slot: i,
      verdict: v,
      ours: `img/${v}${i}.png`,
    })),
  )
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length

describe('buildReport', () => {
  const files = buildReport(rows(), { sha: 'abc', dirty: false })
  it('has one page per verdict whose row count equals the input count', () => {
    for (const v of VERDICTS) {
      expect(count(files.get(`${v}.md`)!, /^### Sprite/gm)).toBe(COUNTS[v])
      expect(count(files.get(`${v}.md`)!, /^- \[ \] corrupted$/gm)).toBe(COUNTS[v])
    }
  })
  it('puts every sprite on exactly one verdict page and lists every one in the index', () => {
    const total = rows().length
    const ids = [...files]
      .filter(([k]) => k !== 'index.md')
      .flatMap(([, t]) => [...t.matchAll(/<a id="([^"]+)">/g)].map(m => m[1]))
    expect(ids).toHaveLength(total)
    expect(new Set(ids).size).toBe(total)
    const index = files.get('index.md')!
    for (const id of ids) expect(index).toContain(`#${id})`)
    expect(count(index, /^- [0-9A-F]{2} map/gm)).toBe(total)
  })
  it('states each page count in its header and each count and the total in the index', () => {
    for (const v of VERDICTS)
      expect(files.get(`${v}.md`)).toContain(`# ${v} (${COUNTS[v]})
`)
    const index = files.get('index.md')!
    expect(index).toContain(`${rows().length} graded.`)
    for (const v of VERDICTS) expect(index).toContain(`[${v}](${v}.md): ${COUNTS[v]}`)
  })
  it('keeps anchors apart for rows sharing map, id and slot', () => {
    const same = ['exact', 'exact', 'wrong'].map((verdict): ReportRow => ({
      map: '001',
      id: 5,
      slot: 2,
      verdict: verdict as ReportVerdict,
    }))
    const page = buildReport(same, { sha: 'x', dirty: false })
    const ids = [...page.get('exact.md')!.matchAll(/<a id="([^"]+)">/g)].map(m => m[1])
    expect(new Set(ids).size).toBe(2)
    const index = page.get('index.md')!
    for (const id of ids) expect(index).toContain(`(exact.md#${id})`)
    expect(index).toMatch(/\(wrong\.md#m001-s05-2-2\)/)
  })
  it('links ours and hardware images, and says so when one is absent', () => {
    const page = buildReport(
      [
        { map: '001', id: 1, slot: 0, verdict: 'exact', ours: 'img/a.png', hardware: 'img/b.png' },
        { map: '001', id: 2, slot: 0, verdict: 'empty' },
      ],
      { sha: 'x', dirty: false },
    )
    expect(page.get('exact.md')).toContain('![ours](img/a.png) | ![hardware](img/b.png)')
    expect(page.get('empty.md')).toContain('none drawn')
  })
})

describe('isInside', () => {
  it('is true for the root and below, false for siblings and parents', () => {
    expect(isInside(join(tmp, 'a', 'b'), tmp)).toBe(true)
    expect(isInside(tmp, tmp)).toBe(true)
    expect(isInside(tmp + '-other', tmp)).toBe(false)
    expect(isInside(join(tmp, '..'), tmp)).toBe(false)
  })
  it('follows a junction out of the root, and into it', () => {
    const [root, other] = [join(tmp, 'jroot'), join(tmp, 'jother')]
    mkdirSync(root)
    mkdirSync(other)
    symlinkSync(root, join(other, 'link'), 'junction')
    expect(isInside(join(other, 'link', 'x', 'y'), root)).toBe(true)
    symlinkSync(other, join(root, 'out'), 'junction')
    expect(isInside(join(root, 'out', 'x'), root)).toBe(false)
  })
  it.skipIf(process.platform !== 'win32')('ignores case on win32 paths', () => {
    expect(isInside(join(tmp.toUpperCase(), 'A'), tmp.toLowerCase())).toBe(true)
  })
})

const img = (n: number): Graded['oursImg'] => ({ w: 2, h: 2, px: new Uint8Array(16).fill(n) })
const graded = (): Graded[] => rows().map(r => ({ ...r, oursImg: img(100), hardwareImg: img(200) }))
const VALIDATION_URL = 'git@github.com:en-gen/hackbench-validation.git'
// `commit: false` skips a spawn for tests that only read remotes.
const mkRepo = (name: string, remote: string | null = VALIDATION_URL, commit = true): string => {
  const d = join(tmp, name)
  mkdirSync(d)
  git(d, 'init', '-q')
  if (remote) git(d, 'remote', 'add', 'origin', remote)
  if (commit) git(d, 'commit', '-q', '--allow-empty', '-m', 'init')
  return d
}
const io = (over: Partial<Io> = {}): Io & { out: string[] } => {
  const out: string[] = []
  return {
    repoRoot: join(tmp, 'hb'),
    rom: join(tmp, 'vanilla.sfc'),
    captures: join(tmp, 'caps'),
    exists: () => true,
    sha: () => ({ sha: 'deadbeef', dirty: false }),
    grade: () => graded(),
    env: {},
    log: s => out.push(s),
    out,
    ...over,
  }
}

// Plants a host gitconfig with a marker-writing hook and a probe key; un-isolating the helper,
// mkRepo or the process turns a test red (#890).
describe('git isolation', () => {
  const plant = (name: string) => {
    const dir = join(tmp, name)
    mkdirSync(join(dir, 'hooks'), { recursive: true })
    const marker = join(dir, 'hook-ran').replaceAll('\\', '/')
    for (const h of ['pre-commit', 'post-commit'])
      writeFileSync(join(dir, 'hooks', h), ['#!/bin/sh', `echo x > "${marker}"`].join('\n'), {
        mode: 0o755,
      })
    const hooks = join(dir, 'hooks').replaceAll('\\', '/')
    const cfg = join(dir, 'host.gitconfig')
    writeFileSync(
      cfg,
      ['[core]', `\thooksPath = ${hooks}`, '[hackbench]', '\tprobe = 1', ''].join('\n'),
    )
    return { cfg, marker }
  }
  const withGlobal = <T>(cfg: string, f: () => T): T => {
    const saved = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = cfg
    try {
      return f()
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved
    }
  }
  it('the process install is active: isolated config, identity, credential reset', () => {
    // Goes red if the beforeAll install is deleted: git spawned with process.env is what the code under test does.
    const sh = (...a: string[]) =>
      spawnSync('git', a, { encoding: 'utf8', env: process.env, cwd: tmp })
    expect(process.env.GIT_CONFIG_GLOBAL).toMatch(/isolated\.gitconfig$/)
    expect(sh('config', '--get', 'user.email').stdout.trim()).toBe('t@t')
    const reset = (r: { status: number | null; stdout: string }) => [r.status, r.stdout.trim()] // status 0: the key is set; empty: only the clearing value
    expect(reset(sh('config', '--get-all', 'credential.helper'))).toEqual([0, ''])
    const h = isolatedGit(tmp, join(tmp, 'no-hooks'), 'config', '--get-all', 'credential.helper')
    expect(reset(h)).toEqual([0, ''])
  })
  it('the test helper and mkRepo ignore a host global hooksPath and config', () => {
    const { cfg, marker } = plant('plant-h')
    withGlobal(cfg, () => {
      const r = mkRepo('iso-h')
      expect(isolatedGit(r, join(tmp, 'no-hooks'), 'config', 'hackbench.probe').status).not.toBe(0)
    })
    expect(existsSync(marker)).toBe(false)
  })
  it('the code under test, which spawns git with process.env, ignores them too', () => {
    const { cfg, marker } = plant('plant-p')
    withGlobal(cfg, () => {
      const restore = isolateProcessGit(join(tmp, 'git-env-p'))
      try {
        expect(run(['--validation', mkRepo('iso-p', VALIDATION_URL, false)], io())).toBe(0)
      } finally {
        restore()
      }
    })
    expect(existsSync(marker)).toBe(false)
  })
})

/** os.tmpdir() reads these on every call (lib/os.js: TEMP or TMP on win32, TMPDIR first on POSIX), so placeReport's scratch and backup land in `root`, not the tmpdir shared with concurrent runs (#914). */
function withTmpdir(root: string, fn: () => void): void {
  const keys = ['TMPDIR', 'TMP', 'TEMP']
  const saved = keys.map(k => process.env[k])
  keys.forEach(k => (process.env[k] = root))
  try {
    fn()
  } finally {
    keys.forEach((k, i) =>
      saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]),
    )
  }
}

describe('run', () => {
  it('names a missing ROM, exits non-zero, writes nothing', () => {
    const v = mkRepo('v1')
    const c = io({ exists: p => p !== join(tmp, 'vanilla.sfc') })
    expect(run(['--validation', v], c)).toBe(1)
    expect(c.out.join()).toContain('vanilla ROM')
    expect(existsSync(join(v, 'reports'))).toBe(false)
    expect(git(v, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  })
  it('names missing captures', () => {
    const c = io({ exists: p => p !== join(tmp, 'caps') })
    expect(run(['--out', join(tmp, 'o1'), '--no-commit'], c)).toBe(1)
    expect(c.out.join()).toContain('layers_v5 captures')
    expect(existsSync(join(tmp, 'o1'))).toBe(false)
  })
  it('commits reports/sprites/<sha>/ and latest/ in the validation repo, and nothing else', () => {
    const v = mkRepo('v2')
    expect(run(['--validation', v], io())).toBe(0)
    expect(git(v, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
    const changed = git(v, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
    expect(changed.filter(f => f.startsWith('reports/sprites/deadbeef/index.md'))).toHaveLength(1)
    expect(changed.filter(f => f.startsWith('reports/sprites/latest/index.md'))).toHaveLength(1)
    expect(changed.every(f => /^reports\/sprites\/(deadbeef|latest)\//.test(f))).toBe(true)
    expect(changed.filter(f => f.endsWith('-ours.png'))).toHaveLength(rows().length * 2)
    expect(git(v, 'status', '--porcelain')).toBe('')
  })
  it('commits the frame images even when the repo ignores *.png', () => {
    const v = mkRepo('v2png')
    writeFileSync(join(v, '.gitignore'), '*.png\n')
    git(v, 'add', '.gitignore')
    git(v, 'commit', '-qm', 'ignore png')
    expect(run(['--validation', v], io())).toBe(0)
    const changed = git(v, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
    expect(changed.filter(f => f.endsWith('-ours.png'))).toHaveLength(rows().length * 2)
    expect(changed.filter(f => f.endsWith('-hardware.png'))).toHaveLength(rows().length * 2)
    expect(git(v, 'status', '--porcelain')).toBe('')
  })
  it('replaces latest/ on a second run', () => {
    const v = mkRepo('v3')
    run(['--validation', v], io())
    run(
      ['--validation', v],
      io({ sha: () => ({ sha: 'cafe', dirty: false }), grade: () => graded().slice(0, 1) }),
    )
    expect(readdirSync(join(v, 'reports', 'sprites', 'latest', 'img'))).toHaveLength(2)
    expect(existsSync(join(v, 'reports', 'sprites', 'deadbeef'))).toBe(true)
  })
  it('refuses an output inside the hackbench checkout, for the report and the sheet', () => {
    const c = io()
    expect(run(['--out', join(tmp, 'hb', 'x'), '--no-commit'], c)).toBe(2)
    expect(run(['--sheet', '--map', '1', '--out', join(tmp, 'hb')], c)).toBe(2)
    expect(run(['--validation', join(tmp, 'hb', 'v')], c)).toBe(2)
    expect(existsSync(join(tmp, 'hb'))).toBe(false)
  })
  it('--no-commit writes the same tree to --out; a sheet inside the validation repo is refused', () => {
    const o = join(tmp, 'o2')
    expect(run(['--out', o, '--no-commit'], io())).toBe(0)
    expect(existsSync(join(o, 'reports', 'sprites', 'latest', 'index.md'))).toBe(true)
    const v = mkRepo('v4')
    expect(
      run(['--sheet', '--sprite', '1', '--validation', v, '--out', join(v, 'sheets')], io()),
    ).toBe(2)
  })
  it('a sheet writes exactly one PNG and commits nothing', () => {
    const v = mkRepo('v5')
    const o = join(tmp, 'sheets')
    expect(run(['--sheet', '--map', '1', '--validation', v, '--out', o], io())).toBe(0)
    const files = readdirSync(o)
    expect(files).toEqual(['sprite-sheet-map-1.png'])
    expect(readFileSync(join(o, files[0])).subarray(1, 4).toString()).toBe('PNG')
    expect(git(v, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  })
  it('does not sweep unrelated files into the commit, staged or not', () => {
    const v = mkRepo('v6')
    writeFileSync(join(v, 'notes.txt'), 'x')
    writeFileSync(join(v, 'staged.txt'), 'y')
    git(v, 'add', 'staged.txt')
    expect(run(['--validation', v], io())).toBe(0)
    const changed = git(v, 'show', '--name-only', '--format=', 'HEAD')
    expect(changed).not.toMatch(/notes\.txt|staged\.txt/)
    expect(git(v, 'status', '--porcelain')).toContain('A  staged.txt')
    expect(git(v, 'status', '--porcelain')).toContain('?? notes.txt')
  })
  it('refuses to replace untracked or edited files in <key>/ unless --force', GIT_HEAVY, () => {
    const v = mkRepo('v10')
    run(['--validation', v], io())
    const dir = join(v, 'reports', 'sprites', 'deadbeef')
    writeFileSync(join(dir, 'notes.md'), 'mine')
    const c = io()
    expect(run(['--validation', v], c)).toBe(1)
    expect(c.out.join()).toContain('uncommitted')
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('mine')
    rmSync(join(dir, 'notes.md'))
    writeFileSync(join(dir, 'index.md'), 'edited')
    expect(run(['--validation', v], io())).toBe(1)
    expect(readFileSync(join(dir, 'index.md'), 'utf8')).toBe('edited')
    expect(run(['--validation', v, '--force'], io())).toBe(0)
  })
  it(
    'restores an already-committed <key>/ and latest/ when a rerun fails to commit',
    GIT_HEAVY,
    () => {
      const v = mkRepo('v11')
      run(['--validation', v], io())
      git(v, 'config', 'core.hooksPath', join(v, '.git', 'hooks'))
      const hook = join(v, '.git', 'hooks', 'pre-commit')
      writeFileSync(hook, '#!/bin/sh\nexit 1\n')
      chmodSync(hook, 0o755)
      const other = (): Graded[] =>
        graded().map(g => ({ ...g, oursImg: img(7), hardwareImg: img(8) }))
      expect(run(['--validation', v], io({ grade: other }))).toBe(1)
      expect(git(v, 'status', '--porcelain')).toBe('')
    },
  )
  it('refuses --out and --sheet output inside a repo that shares the hackbench git store', () => {
    const main = mkRepo('hbmain2')
    const wt = join(tmp, 'hbwt2')
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt2')
    const c = io({ repoRoot: wt })
    expect(run(['--out', join(main, 'o4'), '--no-commit'], c)).toBe(2)
    expect(run(['--sheet', '--map', '1', '--out', join(main, 'o5')], c)).toBe(2)
    expect(existsSync(join(main, 'o4')) || existsSync(join(main, 'o5'))).toBe(false)
  })
  it('keys a dirty tree as <sha>-dirty', () => {
    const v = mkRepo('v7')
    const c = io({ sha: () => ({ sha: 'abc', dirty: true }) })
    expect(run(['--validation', v], c)).toBe(0)
    expect(existsSync(join(v, 'reports', 'sprites', 'abc-dirty', 'index.md'))).toBe(true)
    expect(existsSync(join(v, 'reports', 'sprites', 'abc'))).toBe(false)
  })
  it('refuses to overwrite a folder with a ticked checkbox unless --force', GIT_HEAVY, () => {
    const v = mkRepo('v8')
    run(['--validation', v], io())
    const page = join(v, 'reports', 'sprites', 'deadbeef', 'exact.md')
    writeFileSync(page, readFileSync(page, 'utf8').replace('- [ ]', '- [x]'))
    git(v, 'commit', '-qam', 'reviewed')
    const c = io()
    expect(run(['--validation', v], c)).toBe(1)
    expect(c.out.join()).toContain('ticked')
    expect(readFileSync(page, 'utf8')).toContain('- [x]')
    expect(run(['--validation', v, '--force'], io())).toBe(0)
    expect(readFileSync(page, 'utf8')).not.toContain('- [x]')
  })
  it('undoes a failed commit: non-zero, git error shown, nothing staged or left behind', () => {
    const v = mkRepo('v9')
    git(v, 'config', 'core.hooksPath', join(v, '.git', 'hooks'))
    const hook = join(v, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho hook-said-no >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const c = io()
    expect(run(['--validation', v], c)).toBe(1)
    expect(c.out.join()).toContain('hook-said-no')
    expect(git(v, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(v, 'reports', 'sprites', 'latest'))).toBe(false)
  })
  it('refuses a validation target that shares a git store with the hackbench checkout', () => {
    const main = mkRepo('hbmain')
    const wt = join(tmp, 'hbwt')
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt')
    expect(run(['--validation', main], io({ repoRoot: wt }))).toBe(2)
    expect(existsSync(join(main, 'reports'))).toBe(false)
  })
  it('refuses an origin naming en-gen/hackbench, accepts hackbench-validation', () => {
    const [bad, good] = [
      mkRepo('o-bad', 'https://github.com/en-gen/hackbench.git'),
      mkRepo('o-good'),
    ]
    expect(run(['--validation', bad], io())).toBe(2)
    expect(existsSync(join(bad, 'reports'))).toBe(false)
    expect(run(['--validation', good], io())).toBe(0)
  })
  it('--no-commit clears a stale latest/ and needs --out', () => {
    const o = join(tmp, 'o3')
    run(['--out', o, '--no-commit'], io())
    run(['--out', o, '--no-commit'], io({ grade: () => graded().slice(0, 1) }))
    expect(readdirSync(join(o, 'reports', 'sprites', 'latest', 'img'))).toHaveLength(2)
    const c = io()
    expect(run(['--no-commit'], c)).toBe(2)
    expect(c.out.join()).toContain('--no-commit needs --out')
  })
  it('rejects a missing, flag-like or non-hex --map and --sprite operand with usage', () => {
    for (const argv of [
      ['--sheet', '--map', 'zz', '--out', tmp],
      ['--sheet', '--map', '--out', tmp],
      ['--sheet', '--out', tmp, '--map'],
      ['--sheet', '--sprite', 'g1', '--out', tmp],
      ['--sheet', '--sprite', '1g', '--out', tmp],
    ]) {
      const c = io()
      expect(run(argv, c), argv.join(' ')).toBe(2)
      expect(c.out.join()).toMatch(/needs a hex number/)
    }
    expect(run(['--sheet', '--map', 'C8', '--out', join(tmp, 'hexok')], io())).toBe(0)
  })
  it('refuses a commit target no remote of which is named hackbench-validation', () => {
    for (const [name, remote] of [
      ['t-none', null],
      ['t-fork', 'https://github.com/someone/hackbench.git'],
      ['t-other', 'https://github.com/someone/notes.git'],
    ] as const) {
      const v = mkRepo(name, remote)
      expect(run(['--validation', v], io()), name).toBe(2)
      expect(existsSync(join(v, 'reports')), name).toBe(false)
    }
  })
  it('refuses --out in a repo whose non-origin remote is a hackbench fork', () => {
    const r = mkRepo('r-fork', null)
    git(r, 'remote', 'add', 'upstream', 'git@github.com:someone/hackbench.git')
    expect(run(['--out', join(r, 'o'), '--no-commit'], io())).toBe(2)
    expect(existsSync(join(r, 'o'))).toBe(false)
  })
  it('checks every remote, not just the first: origin validation + upstream hackbench', () => {
    const r = mkRepo('r-two')
    git(r, 'remote', 'add', 'upstream', 'https://github.com/en-gen/hackbench.git')
    expect(run(['--validation', r], io())).toBe(2)
    expect(existsSync(join(r, 'reports'))).toBe(false)
    expect(run(['--out', join(r, 'o'), '--no-commit'], io())).toBe(2)
    expect(existsSync(join(r, 'o'))).toBe(false)
  })
  it('says a remote URL, not a remote name, in the refusals', () => {
    const v = mkRepo('w-none', 'https://github.com/someone/notes.git')
    const c = io()
    run(['--validation', v], c)
    expect(c.out.join()).toContain('no remote URL ends in hackbench-validation')
    const f = mkRepo('w-fork', 'https://github.com/someone/hackbench.git')
    const c2 = io()
    run(['--validation', f], c2)
    expect(c2.out.join()).toContain('a remote is https://github.com/someone/hackbench.git')
  })
  it('the inRepo guard refuses a nested repo that looks like the validation repo', () => {
    const nested = join(tmp, 'hb', 'nested')
    mkdirSync(nested, { recursive: true })
    git(nested, 'init', '-q')
    git(nested, 'remote', 'add', 'origin', VALIDATION_URL)
    const c = io()
    expect(run(['--validation', nested], c)).toBe(2)
    expect(c.out).toEqual([
      `refusing ${resolve(nested)}: it is inside the hackbench checkout. Nothing written.`,
    ])
  })
  it('matches local clone spellings of hackbench, not look-alikes', GIT_HEAVY, () => {
    const refused = [
      'C:\\x\\hackbench',
      'C:\\x\\hackbench\\',
      'C:/x/hackbench/.git',
      'C:\\x\\hackbench\\.git',
      'hackbench',
    ]
    const fine = ['https://github.com/someone/not-hackbench.git', 'x/my-hackbench']
    const root = join(tmp, 'hb')
    for (const u of refused) {
      const r = mkRepo(`u-${refused.indexOf(u)}`, u, false)
      expect(hackbenchRepo(r, root), u).toContain(u)
    }
    for (const u of fine)
      expect(hackbenchRepo(mkRepo(`f-${fine.indexOf(u)}`, u, false), root), u).toBeUndefined()
    for (const u of ['C:\\x\\hackbench-validation\\', 'C:/x/hackbench-validation/.git'])
      expect(isValidationRepo(mkRepo(`v-${u.length}`, u, false)), u).toBe(true)
    expect(isValidationRepo(mkRepo('v-my', 'x/my-hackbench-validation', false))).toBe(false)
  })
  it('names the cause once in the refusal: shared store, then the checkout', () => {
    const main = mkRepo('msg-main')
    const wt = join(tmp, 'msg-wt')
    git(main, 'worktree', 'add', '-q', wt, '-b', 'msgwt')
    const out = join(main, 'o')
    const c = io({ repoRoot: wt })
    run(['--out', out, '--no-commit'], c)
    expect(c.out).toEqual([
      `refusing ${out}: it shares its git store with the hackbench checkout. Nothing written.`,
    ])
    const c2 = io()
    const inside = join(tmp, 'hb', 'x')
    run(['--out', inside, '--no-commit'], c2)
    expect(c2.out).toEqual([
      `refusing ${inside}: it is inside the hackbench checkout. Nothing written.`,
    ])
  })
  it('sees an owner file in <key>/ even when status.showUntrackedFiles is no', () => {
    const v = mkRepo('v12')
    run(['--validation', v], io())
    git(v, 'config', 'status.showUntrackedFiles', 'no')
    const mine = join(v, 'reports', 'sprites', 'deadbeef', 'notes.md')
    writeFileSync(mine, 'mine')
    const c = io()
    expect(run(['--validation', v], c)).toBe(1)
    expect(c.out.join()).toContain('uncommitted')
    expect(readFileSync(mine, 'utf8')).toBe('mine')
  })
  it('undoes a copy that throws partway through the replacement', GIT_HEAVY, () => {
    const v = mkRepo('v13')
    run(['--validation', v], io())
    const before = git(v, 'rev-parse', 'HEAD')
    const idx = join(v, 'reports', 'sprites', 'latest', 'index.md')
    const was = readFileSync(idx, 'utf8')
    const real = vi.mocked(cpSync).getMockImplementation()!
    vi.mocked(cpSync)
      .mockImplementationOnce(real)
      .mockImplementationOnce(() => {
        throw new Error('EBUSY: planted')
      })
    const c = io({ grade: () => graded().slice(0, 1) })
    expect(run(['--validation', v, '--force'], c)).toBe(1)
    expect(c.out.join()).toContain('copying the report failed, report undone')
    expect(c.out.join()).toContain('planted')
    expect(git(v, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(v, 'status', '--porcelain')).toBe('')
    expect(readFileSync(idx, 'utf8')).toBe(was)
  })
  it(
    'placeReport restores both prior folders when the replacement throws partway',
    GIT_HEAVY,
    () => {
      const base = join(tmp, 'place-restore')
      const seed = (dir: string, text: string): void => {
        mkdirSync(join(base, dir, 'sub'), { recursive: true })
        writeFileSync(join(base, dir, 'index.md'), text)
        writeFileSync(join(base, dir, 'sub', 'keep.md'), `${text}-sub`)
      }
      seed('k1', 'old-key')
      seed('latest', 'old-latest')
      const real = vi.mocked(cpSync).getMockImplementation()!
      let n = 0
      // Fail the copy that fills base/latest, after <key>/ was already replaced; backups use cpSync too.
      vi.mocked(cpSync).mockImplementation((...a: Parameters<typeof cpSync>) => {
        if (String(a[1]).startsWith(join(base, 'latest')) && ++n === 1)
          throw new Error('EBUSY: planted')
        return real(...a)
      })
      const root = mkdtempSync(join(tmp, 'own-tmp-'))
      const backups: string[] = []
      const failing = vi.mocked(cpSync).getMockImplementation()!
      vi.mocked(cpSync).mockImplementation((...a: Parameters<typeof cpSync>) => {
        const dir = dirname(String(a[1])) // the copy into <backup>/<k1|latest>
        if (dir.includes('sprite-report-backup-') && !backups.includes(dir)) backups.push(dir)
        return failing(...a)
      })
      try {
        withTmpdir(root, () =>
          expect(() => placeReport(base, 'k1', new Map([['index.md', 'new']]), true)).toThrow(
            /planted/,
          ),
        )
      } finally {
        vi.mocked(cpSync).mockImplementation(real)
      }
      for (const [d, text] of [
        ['k1', 'old-key'],
        ['latest', 'old-latest'],
      ]) {
        expect(readFileSync(join(base, d, 'index.md'), 'utf8')).toBe(text)
        expect(readFileSync(join(base, d, 'sub', 'keep.md'), 'utf8')).toBe(`${text}-sub`)
      }
      // Name this call's own backup: a shared tmpdir() listing sees other runs' backups (#914). Non-empty rules out a vacuous pass.
      expect(backups, JSON.stringify(backups)).toHaveLength(1)
      expect(backups[0].startsWith(root)).toBe(true)
      expect(existsSync(backups[0])).toBe(false)
    },
  )
  it('placeReport restores each folder independently and keeps the backup when a restore fails', () => {
    const base = join(tmp, 'place-restore-fail')
    for (const [d, text] of [
      ['k2', 'old-key'],
      ['latest', 'old-latest'],
    ]) {
      mkdirSync(join(base, d), { recursive: true })
      writeFileSync(join(base, d, 'index.md'), text)
    }
    const real = vi.mocked(cpSync).getMockImplementation()!
    let toK2 = 0
    let toLatest = 0
    vi.mocked(cpSync).mockImplementation((...a: Parameters<typeof cpSync>) => {
      const dest = String(a[1])
      if (dest.startsWith(join(base, 'latest')) && ++toLatest === 1)
        throw new Error('EBUSY: replace planted')
      // The 1st copy into k2 is the replacement; the 2nd is its restore.
      if (dest.startsWith(join(base, 'k2')) && ++toK2 === 2) throw new Error('EIO: restore planted')
      return real(...a)
    })
    let msg = ''
    const root = mkdtempSync(join(tmp, 'own-tmp-'))
    try {
      try {
        withTmpdir(root, () => placeReport(base, 'k2', new Map([['index.md', 'new']]), true))
      } catch (e) {
        msg = (e as Error).message
      }
    } finally {
      vi.mocked(cpSync).mockImplementation(real)
    }
    const kept = /(\S*sprite-report-backup-\S+?)(?:;|$|\s)/.exec(msg)?.[1]
    try {
      expect(msg).toContain('replace planted')
      expect(msg).toContain('not fully restored')
      expect(kept, msg).toBeDefined()
      expect(existsSync(kept!)).toBe(true)
      expect(kept!.startsWith(root)).toBe(true)
      expect(readFileSync(join(kept!, 'k2', 'index.md'), 'utf8')).toBe('old-key')
      expect(readFileSync(join(base, 'latest', 'index.md'), 'utf8')).toBe('old-latest')
    } finally {
      if (kept) rmSync(kept, { recursive: true, force: true })
    }
  })
  it('does not claim "undone" when an undo step fails', () => {
    const v = mkRepo('v13b')
    const real = vi.mocked(cpSync).getMockImplementation()!
    vi.mocked(cpSync)
      .mockImplementationOnce(real)
      .mockImplementationOnce(() => {
        writeFileSync(join(v, '.git', 'index.lock'), '') // makes `git reset` fail
        throw new Error('EBUSY: planted')
      })
    const c = io()
    expect(run(['--validation', v], c)).toBe(1)
    expect(c.out.join()).toContain('copying the report failed, report NOT fully undone')
    expect(c.out.join()).not.toMatch(/report undone/)
  })
  it('does not roll back over an owner file when the ticked-box check refuses', () => {
    const v = mkRepo('v14')
    run(['--validation', v], io())
    const page = join(v, 'reports', 'sprites', 'deadbeef', 'exact.md')
    writeFileSync(page, readFileSync(page, 'utf8').replace('- [ ]', '- [x]'))
    git(v, 'commit', '-qam', 'reviewed')
    const mine = join(v, 'reports', 'sprites', 'latest', 'mine.md')
    writeFileSync(mine, 'mine')
    expect(run(['--validation', v], io())).toBe(1)
    expect(readFileSync(mine, 'utf8')).toBe('mine')
  })
  it('a sheet that cannot be written exits 1 with the reason', () => {
    const blocker = join(tmp, 'blocker')
    writeFileSync(blocker, 'a file where a directory is needed')
    const c = io()
    expect(run(['--sheet', '--map', '1', '--out', join(blocker, 'sub')], c)).toBe(1)
    expect(c.out.join()).toContain('could not write the sheet')
  })
  it.skipIf(process.platform !== 'win32')('--out on a drive that does not exist exits 2', () => {
    const free = [...'QRSTUVWXYZ'].find(l => !existsSync(`${l}:\\`))!
    const dead = `${free}:\\nope\\x`
    for (const argv of [
      ['--out', dead, '--no-commit'],
      ['--sheet', '--map', '1', '--out', dead],
    ]) {
      const c = io()
      expect(run(argv, c)).toBe(2)
      expect(c.out.join()).toContain('does not exist')
    }
    expect(isInside(dead, tmp)).toBe(false)
  })
  it('rejects --sheet with neither or both filters, and --out without --no-commit', () => {
    expect(run(['--sheet', '--out', tmp], io())).toBe(2)
    expect(run(['--sheet', '--map', '1', '--sprite', '2', '--out', tmp], io())).toBe(2)
    expect(run(['--out', tmp], io())).toBe(2)
  })
})

describe('frames and sheet', () => {
  const vram = new Uint8Array(0x10000)
  vram.fill(0xff, 0, 32) // tile 0 of the first name table: every plane set, colour index 15
  const pal = new Uint8Array(768)
  pal.set([10, 20, 30], (128 + 15) * 3)
  const src = { vram, pal, obsel: 0 }
  it('renders an 8x8 piece with the palette colour, scaled 2x on a backdrop', () => {
    const r = renderPieces([{ dx: 0, dy: 0, tile: 0, attr: 0, large: false }], src)!
    expect([r.w, r.h]).toEqual([16, 16])
    expect([...r.px.subarray(0, 4)]).toEqual([10, 20, 30, 255])
    expect(renderPieces([], src)).toBeNull()
  })
  it('encodes a PNG with the right signature and width', () => {
    const png = encodePng({ w: 1, h: 1, px: Uint8Array.from([1, 2, 3, 255]) })
    expect(png.readUInt32BE(16)).toBe(1)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
  })
  it('lays out one cell per sprite', () => {
    const cell = { verdict: 'exact' as const, ours: img(1), hardware: img(2) }
    const one = contactSheet([cell])
    const many = contactSheet([cell, cell, cell], 2)
    expect(many.h).toBe(one.h * 2)
    expect(many.w).toBe(one.w * 2)
  })
})

const piece = (dx: number, tile: number, attr = 0, large = false) => ({
  dx,
  dy: 0,
  tile,
  attr,
  large,
})
/** A model whose chosen pass drew exactly `ours`, anchored at the origin. */
const model = (ours: ReturnType<typeof piece>[]): SpriteModel =>
  ({
    chosen: 0,
    anchor: { x: 0, y: 0 },
    passes: [
      {
        pos: { x: 0, y: 0 },
        origin: { x: 0, y: 0 },
        parts: ours.map(p => ({
          dx: p.dx,
          dy: p.dy,
          oy: 0,
          char: p.tile,
          attr: p.attr,
          size: p.large ? 16 : 8,
        })),
      },
    ],
  }) as unknown as SpriteModel

describe('gradedFrame', () => {
  const ours = [piece(0, 1)]
  const [wrong, shape, exact] = [[piece(0, 9)], [piece(5, 1)], [piece(0, 1, 0x10)]]
  it('shows the frame the grader scored best, not the first, for shape rows too', () => {
    expect(grade(model(ours), [wrong, shape]).verdict).toBe('shape')
    expect(gradedFrame(model(ours), [wrong, shape])).toBe(shape)
    expect(gradedFrame(model(ours), [wrong, shape, exact])).toBe(exact)
  })
  it('breaks ties toward the first frame', () => {
    const shape2 = [piece(7, 1)]
    expect(gradedFrame(model(ours), [wrong, shape, shape2])).toBe(shape)
    expect(gradedFrame(model(ours), [shape2, shape])).toBe(shape2)
  })
})

describe('oamOrder', () => {
  // Two overlapping 8x8 pieces. The capture lists them sorted as JSON text
  // (tile 1 before tile 2) but OAM entry 3 is tile 2 and entry 9 is tile 1.
  const frame = [piece(0, 1), piece(4, 2)]
  const ent = (entry: number, x: number, tile: number) => ({
    entry,
    x,
    y: 100,
    tile,
    attr: 0,
    sizeXHigh: 0,
  })
  const entries = [ent(9, 54, 1), ent(3, 58, 2)]
  it('returns the pieces in OAM index order', () => {
    expect(oamOrder(frame, entries)!.map(p => p.tile)).toEqual([2, 1])
  })
  it('draws the lower OAM entry on top where the pieces overlap', () => {
    const vram = new Uint8Array(0x10000)
    vram.fill(0xff, 0, 32) // tile 0: every pixel colour 15
    const pal = new Uint8Array(768)
    pal.set([10, 20, 30], (128 + 15) * 3) // object palette row 0
    pal.set([200, 0, 0], (128 + 16 + 15) * 3) // row 1, attr bit 1
    const src = { vram, pal, obsel: 0 }
    const [a, b] = [piece(0, 0, 0), piece(4, 0, 2)]
    const at = (r: NonNullable<ReturnType<typeof renderPieces>>) => [
      ...r.px.subarray(8 * 4, 8 * 4 + 3),
    ] // x=4, scaled 2x
    expect(at(renderPieces([a, b], src)!)).toEqual([10, 20, 30])
    expect(at(renderPieces([b, a], src)!)).toEqual([200, 0, 0])
  })
  it('is null when the entries do not fit the frame', () => {
    expect(oamOrder(frame, undefined)).toBeNull()
    expect(oamOrder(frame, [ent(9, 54, 1), ent(3, 99, 2)])).toBeNull()
    expect(oamOrder(frame, [ent(9, 54, 1)])).toBeNull()
  })
  it('compares attr, dy and the X high bit', () => {
    const e = (entry: number, x: number, y: number, attr: number, hi = 0, tile = 1) => ({
      entry,
      x,
      y,
      tile,
      attr,
      sizeXHigh: hi,
    })
    const two = [piece(0, 1, 0x20), { ...piece(246, 2, 0x20), dy: 8 }]
    const ok = [e(5, 54, 100, 0x20), e(2, 44, 108, 0x20, 1, 2)]
    expect(oamOrder(two, ok)!.map(p => p.tile)).toEqual([2, 1])
    expect(oamOrder(two, [ok[0], { ...ok[1], attr: 0x22 }])).toBeNull() // attr
    expect(oamOrder(two, [ok[0], { ...ok[1], y: 109 }])).toBeNull() // dy
    expect(oamOrder(two, [ok[0], { ...ok[1], sizeXHigh: 0 }])).toBeNull() // X >= 256
  })
})

describe('hardwareFrame', () => {
  const ours = model([piece(0, 1), piece(4, 2)])
  const want = [[piece(0, 1), piece(4, 2)]]
  const ents = [
    { entry: 9, x: 54, y: 100, tile: 1, attr: 0, sizeXHigh: 0 },
    { entry: 3, x: 58, y: 100, tile: 2, attr: 0, sizeXHigh: 0 },
  ]
  it('labels a frame of 2+ pieces whose entries do not fit, and only that', () => {
    expect(hardwareFrame(ours, want, undefined).note).toBe('hardware overlap order unknown')
    expect(hardwareFrame(ours, want, ents).note).toBeUndefined()
    expect(hardwareFrame(ours, want, ents).pieces.map(p => p.tile)).toEqual([2, 1])
    expect(hardwareFrame(model([piece(0, 1)]), [[piece(0, 1)]], undefined).note).toBeUndefined()
  })
})

describe.skipIf(!hasRom(VANILLA) || !hasCaptures())('gradeCaptures on the corpus', () => {
  it('tallies as the grade loop does and puts every sprite on exactly one page', () => {
    const rom = freshRom()
    const want: Record<string, number> = {}
    let total = 0
    for (const file of readdirSync(CAPTURE_DIR).sort()) {
      if (!file.endsWith('.zip')) continue
      const entries = unzip(readFileSync(join(CAPTURE_DIR, file)))
      const key = [...entries.keys()].find(k => k.endsWith('sprite_spawns.json'))
      if (!key) continue
      const map = parseInt(file.slice(0, -4), 16)
      const lvl = loadLevelState(rom, map)
      const jsonOf = (suffix: string): any => { const k = [...entries.keys()].find(e => e.endsWith(suffix)); return k ? JSON.parse(entries.get(k)!().toString('utf8')) : {} } // prettier-ignore
      const anchorFrame: number | undefined = jsonOf('capture_summary.json').anchorFrame
      const marioStart = jsonOf('scroll_pass.json').marioStart
      for (const rec of JSON.parse(entries.get(key)!().toString('utf8')).spawns ?? []) {
        const id = parseInt(rec.id.slice(1), 16)
        const frames = (rec.frames ?? []).flatMap((f: any) => (f.tiles?.length ? [f.tiles] : []))
        if (!frames.length || id > 0xc8) continue
        // The hardware timeline, as spriteGrade.captures.test.ts grades it (#867).
        const t = timelineFor(rec, anchorFrame, marioStart)
        const seed = withSeed({
          loaded: lvl.ok ? lvl.wram : undefined,
          slot: rec.slot,
          mainPasses: t.mainPasses,
          ...t.seedExtra,
          sprite: { x: rec.listX, y: rec.listY },
          camera: { x: rec.cameraX, y: rec.cameraY },
          mario: rec.marioAtInit ?? { x: rec.listX, y: rec.listY },
        })
        const m = runSprite(rom, id, seed, { probe: t.probe })
        if (t.timed && m.passes[t.k!]) m.chosen = t.k
        const v = grade(m, frames).verdict
        want[v] = (want[v] ?? 0) + 1
        total++
      }
    }
    const got = gradeCaptures({})
    const tally: Record<string, number> = {}
    for (const g of got) tally[g.verdict] = (tally[g.verdict] ?? 0) + 1
    expect(tally).toEqual(want)
    expect(got).toHaveLength(total)
    expect(total).toBe(1957)
    const pages = buildReport(got, { sha: 'x', dirty: false })
    const anchors = [...pages].flatMap(([k, t]) =>
      k === 'index.md' ? [] : [...t.matchAll(/<a id="([^"]+)">/g)].map(m => m[1]),
    )
    expect(anchors).toHaveLength(total)
    expect(new Set(anchors).size).toBe(total)
  }, 600_000)
})

describe('hardwareSource (#863)', () => {
  const pal = new Uint8Array(768)
  pal.set([10, 20, 30], (128 + 15) * 3)
  pal.set([1, 2, 3], (128 + 1) * 3)
  const mk = (frame: number, plane0Only: boolean) => {
    const vram = new Uint8Array(0x10000)
    for (let i = 0; i < 32; i++) vram[i] = plane0Only ? (i < 16 && i % 2 === 0 ? 0xff : 0) : 0xff
    return { frame, src: { vram, pal, obsel: 0 } }
  }
  const start = mk(500, false) // colour 15
  const later = mk(530, true) // colour 1
  const pieces = [{ dx: 0, dy: 0, tile: 0, attr: 0, large: false }]
  const first = (s: { src: Parameters<typeof renderPieces>[1] }) => [
    ...renderPieces(pieces, s.src)!.px.subarray(0, 3),
  ]

  it('a dynamic card draws from the sample on its drawnFrame', () => {
    const r = hardwareSource(0x33, 530, pieces, [start, later])!
    expect(first(r)).toEqual([1, 2, 3])
    expect(r.label).toBeUndefined()
  })
  it('a dynamic card with no matching sample keeps level start and says so', () => {
    const r = hardwareSource(0x33, 531, pieces, [start, later])!
    expect(first(r)).toEqual([10, 20, 30])
    expect(r.label).toBe(LEVEL_START_LABEL)
  })
  it('an id outside the set is dynamic when its tile bytes differ between samples', () => {
    expect(first(hardwareSource(0x01, 530, pieces, [start, later])!)).toEqual([1, 2, 3])
    expect(hardwareSource(0x01, 531, pieces, [start, later])!.label).toBe(LEVEL_START_LABEL)
  })
  it('a static card is unchanged: level start, no label, even on a later drawnFrame', () => {
    const r = hardwareSource(0x01, 530, pieces, [start, mk(530, false)])!
    expect(first(r)).toEqual([10, 20, 30])
    expect(r.label).toBeUndefined()
  })
  it('an id outside the set is dynamic when only the palette differs between samples', () => {
    const pal2 = new Uint8Array(pal)
    pal2.set([77, 88, 99], (128 + 15) * 3)
    const a = mk(500, false)
    const b = { frame: 530, src: { ...mk(530, false).src, pal: pal2 } }
    expect(first(hardwareSource(0x01, 530, pieces, [a, b])!)).toEqual([77, 88, 99])
    expect(hardwareSource(0x01, 531, pieces, [a, b])!.label).toBe(LEVEL_START_LABEL)
  })
  it('no samples gives nothing', () => {
    expect(hardwareSource(0x33, 530, pieces, [])).toBeUndefined()
  })
})

describe('dynamic cards, synthetic captures (#863)', () => {
  const pieces = [{ dx: 0, dy: 0, tile: 0, attr: 0, large: false }]
  const cgram = new Uint8Array(512)
  cgram.set([0x1f, 0x00], (128 + 1) * 2) // colour 1 red
  cgram.set([0xe0, 0x03], (128 + 15) * 2) // colour 15 green
  const vramWith = (tileByte: number, at = 0) => {
    const v = new Uint8Array(0x10000)
    v[at] = tileByte
    return v
  }
  /** In-memory capture entries: one sample per [offset, vram]. */
  const capture = (samples: [number, Uint8Array | null][]) => {
    const e = new Map<string, () => Buffer>()
    const put = (n: string, b: Uint8Array | object) =>
      e.set(`cap/${n}`, () =>
        b instanceof Uint8Array ? Buffer.from(b) : Buffer.from(JSON.stringify(b)),
      )
    put('capture_summary.json', { samples: samples.map(([offset]) => ({ offset })) })
    for (const [o, v] of samples) {
      const f = `frame_${String(o).padStart(4, '0')}_`
      if (!v) continue
      put(f + 'vram.bin', v)
      put(f + 'cgram.bin', cgram)
      put(f + 'ppu.json', { OBSEL_2101: { byte: 0 } })
    }
    return e
  }

  it('the row draws both panels from the sample on drawnFrame and labels an off-sample record', () => {
    // Sample 0: tile 0 pixel (0,0) colour 1 (plane 0 bit 7). Sample +8: colour 0 there, set elsewhere.
    const samples = frameSamples(
      capture([
        [0, vramWith(0x80)],
        [8, vramWith(0x40)],
      ]),
      100,
    )
    expect(samples.map(s => s.frame)).toEqual([100, 108])
    const hit = hardwareCells(0x33, 108, pieces, pieces, samples, ['n'])
    const miss = hardwareCells(0x33, 104, pieces, pieces, samples, ['n'])
    // drawnFrame 108 is sample +8; the miss falls back to level start (sample 0).
    expect(hit.hardwareImg).toEqual(renderPieces(pieces, samples[1].src))
    expect(miss.hardwareImg).toEqual(renderPieces(pieces, samples[0].src))
    expect(hit.hardwareImg!.px).not.toEqual(miss.hardwareImg!.px)
    expect(hit.oursImg!.px).toEqual(hit.hardwareImg!.px)
    expect(hit.detail).toBe('n')
    expect(miss.detail).toBe(`n. ${LEVEL_START_LABEL}`)
  })

  it('a missing level-start sample leaves no source rather than promoting a later sample', () => {
    expect(
      frameSamples(
        capture([
          [0, null],
          [8, vramWith(0x80)],
        ]),
        100,
      ),
    ).toEqual([])
    expect(
      frameSamples(
        capture([
          [0, vramWith(0x80)],
          [8, null],
        ]),
        100,
      ),
    ).toHaveLength(1)
  })

  it('a capture with no anchorFrame matches no drawnFrame: level-start sample and label', () => {
    const samples = frameSamples(
      capture([
        [0, vramWith(0x80)],
        [8, vramWith(0x40)],
      ]),
      undefined,
    )
    expect(samples).toHaveLength(2)
    // drawnFrame 8 would hit sample +8 if undefined were read as frame 0; 0 would hit level start unlabelled.
    for (const drawn of [0, 8, 100, 108]) {
      const r = hardwareCells(0x33, drawn, pieces, pieces, samples, ['n'])
      expect(r.hardwareImg).toEqual(renderPieces(pieces, samples[0].src))
      expect(r.detail).toBe(`n. ${LEVEL_START_LABEL}`)
    }
  })

  it.each([0x33, 0x35])('sprite $%s is dynamic even with identical samples', id => {
    const s = frameSamples(
      capture([
        [0, vramWith(0x80)],
        [8, vramWith(0x80)],
      ]),
      100,
    )
    expect(hardwareCells(id, 999, pieces, pieces, s, []).detail).toBe(LEVEL_START_LABEL)
    expect(hardwareCells(0x01, 999, pieces, pieces, s, []).detail).toBeUndefined()
  })

  it('the same colours at different positions make a card dynamic', () => {
    const s = frameSamples(
      capture([
        [0, vramWith(0x80)],
        [8, vramWith(0x40)],
      ]),
      100,
    )
    expect(hardwareCells(0x01, 999, pieces, pieces, s, []).detail).toBe(LEVEL_START_LABEL)
  })
})
