// The doc-only filter in .github/workflows/ci.yml decides which jobs run. It
// must go "true" for anything outside docs, or a code change skips every gate.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const code = (files: string[]): string =>
  spawnSync('bash', ['tools/scripts/ci-changes.sh'], {
    input: files.join('\n'),
    encoding: 'utf8',
  }).stdout.trim()

describe('ci-changes.sh', () => {
  it('is false for docs only, including a .md anywhere', () => {
    expect(code(['docs/a.md', 'README.md', 'src/providers/NOTES.md', 'docs/img/x.png'])).toBe(
      'false',
    )
  })
  it('is true when any non-doc file is present', () => {
    expect(code(['docs/a.md', 'src/rom/X.ts'])).toBe('true')
    expect(code(['.github/workflows/ci.yml'])).toBe('true')
    expect(code(['docs.ts'])).toBe('true')
  })
  it('is true for an empty list', () => {
    expect(code([])).toBe('true')
  })
})
