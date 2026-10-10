/**
 * Proof for the changelog combine script (#833): drives the real CLI against
 * a throwaway root per case. Synthetic fixtures only, no ROM, never this repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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
const run = (...extra: string[]) =>
  spawnSync(process.execPath, [script, '1.2.0', '--date', '2026-10-10', '--root', root, ...extra], {
    encoding: 'utf8',
  })

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

  it('lets two branches each add a fragment and merge without conflict', () => {
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        encoding: 'utf8',
      })
    git('init', '-q', '-b', 'main')
    log()
    frag('README.md', 'notes\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    for (const b of ['a', 'b']) {
      git('checkout', '-q', '-b', b, 'main')
      frag(`${b}.md`, `### Added\n- from ${b}\n`)
      git('add', '-A')
      git('commit', '-q', '-m', b)
    }
    git('checkout', '-q', 'main')
    expect(git('merge', '--no-ff', '-m', 'ma', 'a').status).toBe(0)
    expect(git('merge', '--no-ff', '-m', 'mb', 'b').status).toBe(0)
    expect(files()).toEqual(['README.md', 'a.md', 'b.md'])
  })
})
