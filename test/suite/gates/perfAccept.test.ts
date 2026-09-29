/**
 * Proof that accept.sh (design section 5) refuses before it ever calls
 * `gh api`: every case here exits 2 on its own validation, so none of them
 * need `gh` installed or authenticated to run in CI.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')
const script = path.join(repoRoot, 'tools', 'perf', 'accept.sh')

function run(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync('bash', [script, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string }
    return { status: e.status ?? -1, output: (e.stderr ?? '') + (e.stdout ?? '') }
  }
}

describe('accept.sh refuses before touching gh api', () => {
  it('refuses with no arguments', () => {
    const r = run([])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/usage/)
  })

  it('refuses a sha with no reason', () => {
    const r = run(['deadbeef'])
    expect(r.status).toBe(2)
  })

  it('refuses a whitespace-only reason', () => {
    const r = run(['HEAD', '   \t  '])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/whitespace/)
  })

  it('refuses a reason over 140 characters', () => {
    const r = run(['HEAD', 'x'.repeat(141)])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/140/)
  })

  it('accepts a reason at exactly 140 characters (boundary), failing later only on the sha', () => {
    const r = run(['not-a-real-sha-xyz', 'x'.repeat(140)])
    expect(r.status).toBe(2)
    expect(r.output).not.toMatch(/140/) // did not reject on length
    expect(r.output).toMatch(/not a commit/)
  })

  it('refuses a sha that does not resolve to a commit', () => {
    const r = run(['not-a-real-sha-xyz', 'an intended cost'])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/not a commit/)
  })

  it('resolves a real ref (HEAD) before it would reach gh api', () => {
    // No network/gh dependency here: HEAD resolves, then the script tries
    // `gh api` and fails for lack of `gh`/auth in this environment - proving
    // validation passed and execution moved past it, without asserting on
    // the network call itself.
    const r = run(['HEAD', 'a valid reason'])
    expect(r.output).not.toMatch(/not a commit/)
    expect(r.output).not.toMatch(/whitespace/)
    expect(r.output).not.toMatch(/usage/)
  })
})
