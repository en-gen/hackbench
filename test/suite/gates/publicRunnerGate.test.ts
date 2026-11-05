// gh01 is the owner's box and holds the ROM corpus. This repo is public, so a
// workflow here that reaches it could run a fork's code on it, and its logs
// would be public (en-gen/hackbench#536). Runner groups refuse that today; this
// is the second lock. ROM runs belong in en-gen/hackbench-validation, started
// through the dispatch workflows.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WORKFLOWS = '.github/workflows'
const OWNER_LABEL = /\b(self-hosted|engenlab|lxc)\b/i

/** Lines that could land a job on the owner's runner, comments aside. */
function offenders(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/(^|\s)#.*$/, ''))
    .filter(line => OWNER_LABEL.test(line) || /runs-on:.*\$\{\{/.test(line))
    .map(line => line.trim())
}

describe('no public workflow reaches the owner runner', () => {
  it('holds for every workflow in this repo', () => {
    const files = readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f))
    expect(files).toContain('ci.yml')
    for (const f of files) {
      expect(offenders(readFileSync(path.join(WORKFLOWS, f), 'utf8')), f).toEqual([])
    }
  })

  it('passes a hosted job, and a comment that names the runner', () => {
    const clean = 'jobs:\n  a:\n    # never self-hosted\n    runs-on: ubuntu-latest # not lxc\n'
    expect(offenders(clean)).toEqual([])
  })

  it.each([
    ['a label list', 'runs-on: [self-hosted, engenlab, lxc]'],
    ['a bare label', 'runs-on: self-hosted'],
    ['a label alone', 'runs-on: [linux, engenlab]'],
    ['a block list', 'runs-on:\n      - self-hosted\n      - linux'],
    ['a runner group object', 'runs-on:\n      group: x\n      labels: [lxc]'],
    ['an expression', 'runs-on: ${{ inputs.runner }}'],
    ['a matrix value', 'strategy:\n      matrix:\n        os: [ubuntu-latest, self-hosted]'],
    ['upper case', 'runs-on: [Self-Hosted]'],
  ])('goes red on %s', (_, job) => {
    expect(offenders(`jobs:\n  a:\n    ${job}\n`).length).toBeGreaterThan(0)
  })
})
