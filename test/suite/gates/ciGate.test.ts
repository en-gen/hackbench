// The CI job layout decides which gates run. Both scripts must fail closed:
// a doc-only verdict for a code change, or a green aggregate over a skipped
// or failed heavy job, silently disables every other check.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const node = (script: string, input = '', env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })

const code = (files: string[]): string =>
  node('tools/scripts/ci-changes.mjs', files.join('\n')).stdout.trim()

describe('ci-changes.mjs', () => {
  it('is false for docs only, including a .md anywhere', () => {
    expect(
      code([
        'docs/a.md',
        'README.md',
        'src/providers/NOTES.md',
        'docs/img/x.png',
        '\n\ndocs/b.md\n',
      ]),
    ).toBe('false')
  })
  it.each([
    'src/rom/X.ts',
    '.github/workflows/ci.yml',
    'docs.ts',
    'package.json',
    'src/docs/x.ts',
    'tools/build.cmd',
    'src/x.md.ts',
    'x.mdx',
    'src/assets/x.png',
    'notes.txt',
  ])('is true when %s sits beside docs', f => {
    expect(code(['docs/a.md', f])).toBe('true')
  })
  it('is true for an empty or blank list', () => {
    expect(code([])).toBe('true')
    expect(code(['', ''])).toBe('true')
  })
  it('sees the old side of a code-to-docs rename when run on the CI diff', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ci-ren-'))
    const git = (...a: string[]) => spawnSync('git', a, { cwd: d, encoding: 'utf8' })
    try {
      git('init', '-q')
      mkdirSync(path.join(d, 'src'))
      mkdirSync(path.join(d, 'docs'))
      writeFileSync(path.join(d, 'src/X.ts'), 'export const x = 1\n'.repeat(20))
      git('add', '-A')
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a')
      git('mv', 'src/X.ts', 'docs/X.md')
      git('add', '-A')
      // Exactly the flags the workflow uses.
      const names = git('diff', '--no-renames', '--name-only', '--cached', 'HEAD').stdout
      expect(names).toContain('src/X.ts')
      expect(code(names.split('\n'))).toBe('true')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

const agg = (e: Record<string, string>) =>
  node('tools/scripts/ci-aggregate.mjs', '', {
    CODE: 'true',
    CHANGES: 'success',
    CONTENT: 'success',
    STATIC: 'success',
    UNIT: 'success',
    SPIKE: 'success',
    ...e,
  }).status

describe('ci-aggregate.mjs', () => {
  it('is green for all success and for code=false with skips', () => {
    expect(agg({})).toBe(0)
    expect(agg({ CODE: 'false', STATIC: 'skipped', UNIT: 'skipped', SPIKE: 'skipped' })).toBe(0)
  })
  it.each([
    [{ UNIT: 'failure' }],
    [{ STATIC: 'cancelled' }],
    [{ CODE: '' }],
    [{ CODE: 'maybe' }],
    [{ SPIKE: 'skipped' }],
    [{ UNIT: 'skipped' }],
    [{ STATIC: 'skipped' }],
    [{ CHANGES: 'failure', CODE: '', STATIC: 'skipped', UNIT: 'skipped', SPIKE: 'skipped' }],
    [{ CONTENT: 'failure' }],
    [{ CONTENT: 'skipped' }],
    [{ CODE: 'false', UNIT: 'failure' }],
  ])('is red for %j', e => {
    expect(agg(e)).toBe(1)
  })
})
