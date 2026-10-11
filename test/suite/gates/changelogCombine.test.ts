/**
 * Proof for the changelog combine script (#833): drives the real CLI against
 * a throwaway root per case. Synthetic fixtures only, no ROM, never this repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'

const script = path.resolve(__dirname, '../../../tools/scripts/changelog-combine.mjs')
const BASE = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-04-17\n\nInitial.\n'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chlog-'))
  fs.mkdirSync(path.join(root, 'changelog.d'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const frag = (name: string, text: string) =>
  fs.writeFileSync(path.join(root, 'changelog.d', name), text)
const log = (text: string = BASE) => fs.writeFileSync(path.join(root, 'CHANGELOG.md'), text)
const readLog = () => fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const files = () => fs.readdirSync(path.join(root, 'changelog.d')).sort()
const snapshot = () => files().map(f => fs.readFileSync(path.join(root, 'changelog.d', f), 'utf8'))
const run = (preload?: string) =>
  spawnSync(
    process.execPath,
    [
      ...(preload ? ['--import', preload] : []),
      script,
      '1.2.0',
      '--date',
      '2026-10-10',
      '--root',
      root,
    ],
    { encoding: 'utf8' },
  )

describe('changelog-combine', () => {
  it('folds three fragments in two sections into one grouped release and deletes them', () => {
    log()
    frag('1-a.md', '### Fixed\n\n- fix one\n')
    frag('2-b.md', '### Added\n- add one\n\n### Fixed\n- fix two\n')
    frag('3-c.md', '### Added\n- add two\n')
    frag('README.md', 'format notes\n')
    const r = run()
    expect(r.status).toBe(0)
    expect(readLog()).toBe(
      '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-10-10\n\n' +
        '### Added\n\n- add one\n- add two\n\n### Fixed\n\n- fix one\n- fix two\n\n' +
        '## [0.1.0] - 2026-04-17\n\nInitial.\n',
    )
    expect(files()).toEqual(['README.md'])
  })

  it('keeps existing Unreleased lines first, including ones outside any section', () => {
    log(
      '# Changelog\n\n## [Unreleased]\n\nLoose note.\n\n### Changed\n\n- old a\n  continued\n\n' +
        '## [0.1.0] - 2026-04-17\n',
    )
    frag('9-x.md', '### Changed\n- new b\n')
    expect(run().status).toBe(0)
    expect(readLog()).toBe(
      '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-10-10\n\nLoose note.\n\n' +
        '### Changed\n\n- old a\n  continued\n- new b\n\n## [0.1.0] - 2026-04-17\n',
    )
  })

  it.each([
    ['no section', '- orphan entry\n'],
    ['unknown section', '### Tweaked\n- entry\n'],
    ['empty section', '### Added\n\n'],
    ['text before heading', 'note\n### Added\n- x\n'],
  ])('refuses a %s fragment, naming it, and changes nothing', (_n, bad) => {
    log()
    frag('1-good.md', '### Added\n- fine\n')
    frag('2-bad.md', bad)
    const before = snapshot()
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('2-bad.md')
    expect(readLog()).toBe(BASE)
    expect(snapshot()).toEqual(before)
  })

  it('leaves CHANGELOG.md unchanged and exits 0 with no fragments', () => {
    log()
    frag('README.md', 'notes\n')
    expect(run().status).toBe(0)
    expect(readLog()).toBe(BASE)
  })

  it('keeps a non-standard [Unreleased] section after the known ones', () => {
    log(
      '# Changelog\n\n## [Unreleased]\n\n### Known limitations\n\n- limit x\n\n## [0.1.0] - 2026-04-17\n',
    )
    frag('1-a.md', '### Added\n- a\n')
    expect(run().status).toBe(0)
    expect(readLog()).toContain(
      '### Added\n\n- a\n\n### Known limitations\n\n- limit x\n\n## [0.1.0]',
    )
  })

  it('refuses a version that already has a heading, writing nothing', () => {
    log(BASE.replace('## [0.1.0]', '## [1.2.0]'))
    frag('1-a.md', '### Added\n- a\n')
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('1.2.0')
    expect(files()).toEqual(['1-a.md'])
    expect(readLog()).toBe(BASE.replace('## [0.1.0]', '## [1.2.0]'))
  })

  it('names the fragments left when a delete fails after CHANGELOG.md is written', () => {
    log()
    frag('1-a.md', '### Added\n- a\n')
    frag('2-b.md', '### Fixed\n- b\n')
    frag('3-c.md', '### Fixed\n- c\n')
    // No portable permission setup blocks unlink (libuv clears read-only on Windows), so a
    // preload makes unlinkSync throw for 2-b.md only.
    const hook = path.join(root, 'hook.mjs')
    const lines = [
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const real = fs.unlinkSync',
      "fs.unlinkSync = p => { if (String(p).endsWith('2-b.md')) throw new Error('EPERM: simulated'); real(p) }",
      'syncBuiltinESMExports()',
    ]
    fs.writeFileSync(hook, lines.join('\n'))
    const r = run(pathToFileURL(hook).href)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/already written/)
    expect(r.stderr).toContain('2-b.md, 3-c.md')
    expect(r.stderr).not.toContain('1-a.md')
    expect(readLog()).toContain('## [1.2.0]')
  })

  it('warns when changelog.d is empty but [Unreleased] has lines, and changes nothing', () => {
    const text =
      '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- keep me\n\n## [0.1.0] - 2026-04-17\n'
    log(text)
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/Unreleased.*nothing was released/)
    expect(readLog()).toBe(text)
  })

  it('stops [Unreleased] at the first link reference when there is no prior release', () => {
    log('# Changelog\n\n## [Unreleased]\n\n[Unreleased]: https://example.test/compare/a...HEAD\n')
    frag('1-a.md', '### Added\n- a\n')
    expect(run().status).toBe(0)
    expect(readLog()).toBe(
      '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-10-10\n\n### Added\n\n- a\n\n' +
        '[Unreleased]: https://example.test/compare/a...HEAD\n',
    )
  })

  it.each([
    ['a release heading', '### Added\n- a\n## [9.9.9]\n', /only "### <Section>"/],
    ['a #### heading', '#### Added\n- a\n', /only "### <Section>"/],
    ['a first entry without a bullet', '### Added\nplain\n', /must start with/],
    ['an indented first line', '### Added\n  indented first\n', /must start with/],
    ['a repeated heading', '### Added\n- valid\n### Added\n- other\n', /repeated heading "Added"/],
    ['plain text after a bullet', '### Added\n- valid\nplain text\n', /must start with/],
    ['a one-space continuation', '### Added\n- a\n one space\n', /must start with/],
    ['a bullet without its space', '### Added\n- a\n-foo\n', /must start with/],
    ['a tab continuation', '### Added\n- a\n\tmore\n', /must start with/],
    ['a 0-byte file', '', /no "### <Section>" heading/],
  ])('refuses a fragment with %s', (_n, bad, msg) => {
    log()
    frag('2-bad.md', bad)
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('2-bad.md')
    expect(r.stderr).toMatch(msg)
    expect(readLog()).toBe(BASE)
  })

  it('stamps the LOCAL date when --date is omitted', () => {
    log()
    frag('1-a.md', '### Added\n- a\n')
    const local = (d: Date) =>
      [d.getFullYear(), d.getMonth() + 1, d.getDate()]
        .map((n, i) => String(n).padStart(i ? 2 : 4, '0'))
        .join('-')
    const before = local(new Date())
    const r = spawnSync(process.execPath, [script, '1.2.0', '--root', root], { encoding: 'utf8' })
    const after = local(new Date())
    expect(r.status).toBe(0)
    // before/after bracket a midnight crossing during the spawn.
    expect([before, after].some(d => readLog().includes(`## [1.2.0] - ${d}`))).toBe(true)
  })

  it('reads CRLF and BOM input, and .MD fragments but not README.MD', () => {
    log('\uFEFF' + BASE.replace(/\n/g, '\r\n'))
    frag('1-a.MD', '\uFEFF### Added\r\n- a\r\n')
    frag('README.MD', 'notes\n')
    expect(run().status).toBe(0)
    expect(readLog()).toBe(
      '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-10-10\n\n### Added\n\n- a\n\n' +
        '## [0.1.0] - 2026-04-17\n\nInitial.\n',
    )
    expect(files()).toEqual(['README.MD'])
  })

  it('keeps an indented continuation line under its bullet', () => {
    log()
    frag('1-a.md', '### Added\n- a\n  more of a\n- b\n')
    expect(run().status).toBe(0)
    expect(readLog()).toContain('### Added\n\n- a\n  more of a\n- b\n\n')
  })

  it.each([
    ['a mistyped option', ['1.2.0', '--dat', '2026-10-10']],
    ['an extra positional', ['1.2.0', '1.3.0']],
    ['an impossible calendar date', ['1.2.0', '--date', '2026-02-30']],
  ])('refuses %s with usage and exit 2, writing nothing', (_n, args) => {
    log()
    frag('1-a.md', '### Added\n- a\n')
    const r = spawnSync(process.execPath, [script, ...args, '--root', root], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage:')
    expect(readLog()).toBe(BASE)
    expect(files()).toEqual(['1-a.md'])
  })

  it('refuses --date with no value', () => {
    log()
    frag('1-a.md', '### Added\n- a\n')
    const r = spawnSync(process.execPath, [script, '1.2.0', '--root', root, '--date'], {
      encoding: 'utf8',
    })
    expect(r.status).not.toBe(0)
    expect(readLog()).toBe(BASE)
  })

  describe('merging branches', () => {
    const git = (...a: string[]) => {
      const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        encoding: 'utf8',
      })
      return r
    }
    const ok = (...a: string[]) => expect(git(...a).status, a.join(' ')).toBe(0)
    const branches = (edit: (b: string) => void) => {
      ok('init', '-q', '-b', 'main')
      log()
      frag('README.md', 'notes\n')
      ok('add', '-A')
      ok('commit', '-q', '-m', 'base')
      for (const b of ['a', 'b']) {
        ok('checkout', '-q', '-b', b, 'main')
        edit(b)
        ok('add', '-A')
        ok('commit', '-q', '-m', b)
      }
      ok('checkout', '-q', 'main')
      ok('merge', '--no-ff', '-m', 'ma', 'a')
    }

    it('lets two branches each add a fragment and merge without conflict', () => {
      branches(b => frag(`${b}.md`, `### Added\n- from ${b}\n`))
      ok('merge', '--no-ff', '-m', 'mb', 'b')
      expect(git('ls-tree', '-r', '--name-only', 'main', 'changelog.d').stdout.split('\n')).toEqual(
        ['changelog.d/README.md', 'changelog.d/a.md', 'changelog.d/b.md', ''],
      )
    })

    it('control: two branches appending under [Unreleased] do conflict', () => {
      branches(b => log(BASE.replace('[Unreleased]\n', `[Unreleased]\n\n- from ${b}\n`)))
      expect(git('merge', '--no-ff', '-m', 'mb', 'b').status).not.toBe(0)
    })
  })
})
