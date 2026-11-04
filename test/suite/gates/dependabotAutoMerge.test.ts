// The Dependabot auto-merge job holds a write token and arms merges, so its
// electron screen and its fail-closed shape must not drift unnoticed. The
// pattern is read from the committed workflow, not copied here.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const wf = readFileSync('.github/workflows/dependabot-auto-merge.yml', 'utf8')
const pattern = /grep -Eiq '([^']+)'/.exec(wf)?.[1] ?? ''
const token = /sed 's\/([^/]+)\/\/g'/.exec(wf)?.[1] ?? ''
const touched = (line: string) => new RegExp(pattern, 'i').test(line.split(token).join(''))

describe('dependabot-auto-merge electron screen', () => {
  it('extracts the pattern and the exempt token', () => {
    expect(pattern).not.toBe('')
    expect(token).toBe('electron-to-chromium')
  })
  it.each([
    '+electron@1.0.0:',
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

describe('dependabot-auto-merge workflow shape', () => {
  it('never checks out or approves', () => {
    expect(wf).not.toContain('actions/checkout')
    expect(wf).not.toContain('gh pr review')
  })
  it.each(['--match-head-commit', '--disable-auto', 'commits == 1'])('contains %s', s =>
    expect(wf).toContain(s),
  )
  it('pins every action to a 40-hex sha', () => {
    const uses = [...wf.matchAll(/uses: (\S+)/g)].map(m => m[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/)
  })
  it('never pipes gh pr diff', () => {
    expect(wf).not.toMatch(/gh pr diff[^\n]*\|/)
  })
})
