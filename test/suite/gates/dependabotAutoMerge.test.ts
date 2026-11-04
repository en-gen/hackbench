// The Dependabot auto-merge job holds a write token and arms merges, so this
// pins the committed workflow exactly: changing it should mean changing this
// test. No YAML parser is a dependency, so the checks are exact text.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const wf = readFileSync('.github/workflows/dependabot-auto-merge.yml', 'utf8')
const has = (s: string) => expect(wf).toContain(s)
const pattern = /grep -Eiq '([^']+)'/.exec(wf)?.[1] ?? ''
const token = /sed 's\/([^/]+)\/\/g'/.exec(wf)?.[1] ?? ''
const touched = (line: string) => new RegExp(pattern, 'i').test(line.split(token).join(''))

describe('electron screen', () => {
  it('extracts the pattern and the exempt token', () => {
    expect([pattern, token]).not.toContain('')
  })
  it.each([
    '+electron@1.0.0:',
    '-electron@42.10.0:',
    '+"@theia/electron@1.80.0":',
    '+  resolved "https://registry.yarnpkg.com/electron/-/electron-42.11.16.tgz"',
    '+"@electron/rebuild@^4.2.0":',
    '+    "electron": "42.11.16",',
    '+++ b/theia/electron-app/package.json',
  ])('flags %s', l => expect(touched(l)).toBe(true))
  it.each([
    '+electron-to-chromium@1.5.0:',
    ' electron@42.10.0:',
    '+multer@2.5.0:',
    '-  version "42.10.0"',
  ])('passes %s', l => expect(touched(l)).toBe(false))
})

describe('workflow shape', () => {
  it('triggers on pull_request only, with no token permissions', () => {
    has('\non: pull_request\n\npermissions: {}\n')
    expect(wf).not.toContain('pull_request_target')
    has('    permissions:\n      contents: write\n      pull-requests: write\n    env:')
  })
  it('requires the author and the head repo', () => {
    has(
      "    if: >-\n      github.event.pull_request.user.login == 'dependabot[bot]' &&\n" +
        '      github.event.pull_request.head.repo.full_name == github.repository\n',
    )
  })
  it('arms only on the exact condition', () => {
    has(
      '      - id: arm\n        if: >-\n          github.event.pull_request.commits == 1 &&\n' +
        "          github.event.sender.login == 'dependabot[bot]' &&\n" +
        "          !contains(github.event.pull_request.labels.*.name, 'no-auto-merge') &&\n" +
        "          steps.metadata.outputs.package-ecosystem == 'npm_and_yarn' &&\n" +
        "          (steps.metadata.outputs.update-type == 'version-update:semver-patch' ||\n" +
        "          steps.metadata.outputs.update-type == 'version-update:semver-minor') &&\n" +
        "          steps.electron.outputs.touched == 'false'\n",
    )
    has('        run: gh pr merge --auto --squash --match-head-commit "$HEAD_SHA" "$PR_URL"\n')
  })
  it('disarms last, on anything but a successful arm', () => {
    const steps = wf.split('\n      - ')
    expect(steps[steps.length - 1]).toMatch(
      /^if: \$\{\{ !cancelled\(\) && steps\.arm\.outcome != 'success' \}\}\n/,
    )
    has('then gh pr merge --disable-auto "$PR_URL"; fi\n')
  })
  it('runs the electron script exactly', () => {
    has(
      '          set -euo pipefail\n' +
        '          diff="$(gh pr diff "$PR_URL")"\n' +
        '          [ -n "$diff" ]\n' +
        `          stripped="$(sed 's/electron-to-chromium//g' <<<"$diff")"\n` +
        `          if grep -Eiq '${pattern}' <<<"$stripped"; then touched=true; else touched=false; fi\n` +
        '          echo "touched=$touched" >> "$GITHUB_OUTPUT"\n',
    )
  })
  it('stays inert: no checkout, no approval, pinned, no piped diff', () => {
    expect(wf).not.toContain('actions/checkout')
    expect(wf).not.toContain('gh pr review')
    const uses = [...wf.matchAll(/uses: (\S+)/g)].map(m => m[1])
    expect(uses).toHaveLength(1)
    expect(uses[0]).toMatch(/@[0-9a-f]{40}$/)
    expect(wf).not.toMatch(/gh pr diff[^\n]*\|/)
  })
})
