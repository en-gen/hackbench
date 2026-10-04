/**
 * Three kinds of case, none of which can reach the real `gh` (issue #486):
 * 1. accept.sh refuses on its own validation before any `gh` call (exit 2).
 * 2. accept.sh against a fake `gh` that lists a window and logs any other
 *    call, so a status POST is observable.
 * 3. The suite-wide guard (test/suite/support/noRealGh.ts): every way of
 *    launching `gh` (bash, no shell, cmd.exe) lands on the failing shim.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

const repoRoot = path.resolve(__dirname, '../../..')
const script = path.join(repoRoot, 'tools', 'perf', 'accept.sh')

type Result = { status: number; output: string }

function runBash(argv: string[], env: NodeJS.ProcessEnv = process.env): Result {
  try {
    const output = execFileSync('bash', argv, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env,
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string }
    return { status: e.status ?? -1, output: (e.stderr ?? '') + (e.stdout ?? '') }
  }
}

const run = (args: string[], env?: NodeJS.ProcessEnv) => runBash([script, ...args], env)

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
})

describe('accept.sh only accepts a sha in the latest 100 develop commits', () => {
  // A fake `gh` on PATH: the commits listing prints $FAKE_WINDOW, any other
  // call is logged to $FAKE_LOG (so a post is observable).
  const script_ = [
    '#!/usr/bin/env bash',
    'case "$2" in',
    '  *commits*) printf "%s\n" "$FAKE_WINDOW";;',
    '  *) echo "$@" >> "$FAKE_LOG";;',
    'esac',
    '',
  ].join('\n')
  const fwd = (p: string) => p.replaceAll(path.sep, '/')

  function fakeGh(window: string): { env: NodeJS.ProcessEnv; log: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-fakegh-'))
    const log = path.join(dir, 'calls.log')
    fs.writeFileSync(path.join(dir, 'gh'), script_, { mode: 0o755 })
    const sep = process.platform === 'win32' ? ';' : ':'
    return {
      env: {
        ...process.env,
        PATH: fwd(dir) + sep + process.env.PATH,
        FAKE_WINDOW: window,
        FAKE_LOG: fwd(log),
      },
      log,
    }
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()

  it('refuses a sha outside the window and posts nothing', () => {
    const { env, log } = fakeGh('0'.repeat(40))
    const r = run([head, 'a reason'], env)
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/latest 100 commits/)
    expect(fs.existsSync(log)).toBe(false)
  })

  it('resolves a real ref (HEAD), gets past validation, and posts nothing when outside the window', () => {
    const { env, log } = fakeGh('0'.repeat(40))
    const r = run(['HEAD', 'a valid reason'], env)
    expect(r.output).not.toMatch(/not a commit|whitespace|usage/)
    expect(r.output).toMatch(/latest 100 commits/) // reached the window check
    expect(r.output).toContain(head) // the ref was resolved to the full sha
    expect(fs.existsSync(log)).toBe(false) // no status POST
  })

  it('posts the status for a sha inside the window', () => {
    const { env, log } = fakeGh(`${'0'.repeat(40)}\n${head}`)
    const r = run([head, 'a reason'], env)
    expect(r.status).toBe(0)
    expect(fs.readFileSync(log, 'utf8')).toMatch(/statuses/)
  })
})

describe('the suite-wide guard', () => {
  const shimName = path.basename(process.env.HB_NO_REAL_GH_DIR ?? '')

  it('puts the shim dir in the env', () => {
    expect(shimName).toMatch(/^hb-nogh-/)
  })

  it('strips gh credentials from the env', () => {
    for (const v of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])
      expect(process.env[v]).toBeUndefined()
    expect(process.env.GH_CONFIG_DIR).toContain('hb-nogh-')
  })

  it('resolves gh to the failing shim from bash, never the real one', () => {
    const r = runBash(['-c', 'gh api repos/en-gen/hackbench/statuses/x'])
    expect(r.status).toBe(99)
    expect(r.output).toMatch(/gh blocked/)
    // msys rewrites the drive form, so compare the unique directory name
    expect(shimName).toMatch(/^hb-nogh-/)
    expect(runBash(['-c', 'command -v gh']).output.trim()).toContain(`${shimName}/gh`)
  })

  it('blocks a spawn with no shell (no bash, no cmd.exe)', () => {
    const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Logged in/)
  })

  it.skipIf(process.platform !== 'win32')('blocks gh through cmd.exe via gh.cmd', () => {
    const r = spawnSync('gh auth status', { shell: true, encoding: 'utf8' })
    expect(r.status).toBe(99)
    expect(`${r.stdout}${r.stderr}`).toMatch(/gh blocked/)
  })
})
