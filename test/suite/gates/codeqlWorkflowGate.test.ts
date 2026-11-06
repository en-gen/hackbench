// CodeQL is a required check on develop, and GitHub's default setup never runs
// on a fork's PR, so the check stayed missing and blocked every outside PR
// (#1256). A fork PR only reports it if this workflow scans and uploads on the
// same terms as ours, so each way of quietly losing that is pinned here. Exact
// text, as in dependabotAutoMerge.test.ts: no YAML parser is a dependency.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const WORKFLOW = '.github/workflows/codeql.yml'
const LANGUAGES = ['actions', 'javascript-typescript', 'python']

/** Reasons the workflow could leave a PR without a real CodeQL result. */
function problems(text: string): string[] {
  const code = text
    .split(/\r?\n/)
    .map(line => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
  const found: string[] = []
  if (!/^ {2}pull_request:\n {4}branches: \[develop\]$/m.test(code)) found.push('no PR trigger')
  if (/pull_request_target|workflow_run/.test(code)) found.push('privileged trigger')
  if (/^\s*paths(-ignore)?:/m.test(code)) found.push('path filter')
  if (/^\s*if:/m.test(code)) found.push('conditional step or job')
  if (/^\s*continue-on-error:/m.test(code)) found.push('failure ignored')
  if (/^\s*upload:/m.test(code)) found.push('upload overridden')
  if (!/^ {4}runs-on: ubuntu-latest$/m.test(code)) found.push('not a hosted runner')
  if (!/^ {6}security-events: write$/m.test(code)) found.push('no upload permission')
  if (!/^ {8}language: \[actions, javascript-typescript, python\]$/m.test(code)) {
    found.push('language list')
  }
  if (!/^ {10}build-mode: none$/m.test(code)) found.push('builds the code')
  if (!/^ {10}category: \/language:\$\{\{ matrix\.language \}\}$/m.test(code)) {
    found.push('category')
  }
  for (const step of ['init', 'analyze']) {
    const pinned = new RegExp(`uses: github/codeql-action/${step}@[0-9a-f]{40}$`, 'm')
    if (!pinned.test(code)) found.push(`${step} not pinned`)
  }
  return found
}

describe('CodeQL reaches fork PRs', () => {
  const wf = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n')

  it('holds for the committed workflow', () => {
    expect(problems(wf)).toEqual([])
  })

  it('names every language default setup scanned', () => {
    for (const language of LANGUAGES) expect(wf).toContain(language)
  })

  it.each([
    [
      'a fork skip',
      '    runs-on: ubuntu-latest',
      '    if: ${{ !github.event.pull_request.head.repo.fork }}\n    runs-on: ubuntu-latest',
      'conditional step or job',
    ],
    ['a privileged trigger', '  pull_request:', '  pull_request_target:', 'no PR trigger'],
    [
      'a path filter',
      '    branches: [develop]\n  push:',
      '    branches: [develop]\n    paths-ignore: ["docs/**"]\n  push:',
      'path filter',
    ],
    [
      'no upload',
      '          category:',
      '          upload: never\n          category:',
      'upload overridden',
    ],
    [
      'an ignored failure',
      '    runs-on: ubuntu-latest',
      '    continue-on-error: true\n    runs-on: ubuntu-latest',
      'failure ignored',
    ],
    [
      'a dropped language',
      '[actions, javascript-typescript, python]',
      '[actions, python]',
      'language list',
    ],
    ['a build step', 'build-mode: none', 'build-mode: autobuild', 'builds the code'],
    ['a moved category', '/language:${{ matrix.language }}', '/fork', 'category'],
    ['a mutable tag', 'codeql-action/analyze@', 'codeql-action/analyze@v4 #', 'analyze not pinned'],
    ['no write permission', '      security-events: write\n', '', 'no upload permission'],
  ])('goes red on %s', (_, from, to, reason) => {
    expect(wf).toContain(from)
    expect(problems(wf.replace(from, to))).toContain(reason)
  })

  it('ignores a comment', () => {
    expect(problems(`${wf}\n# if: never, upload: never, pull_request_target\n`)).toEqual([])
  })
})
