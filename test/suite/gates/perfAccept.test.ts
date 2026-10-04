/**
 * Three kinds of case, none of which can reach the real `gh` (issue #486):
 * 1. accept.sh refuses on its own validation before any `gh` call (exit 2).
 * 2. accept.sh against a fake `gh` that lists a window and logs any other
 *    call, so a status POST is observable.
 * 3. The suite-wide guard (test/suite/support/noRealGh.ts). bash and cmd.exe
 *    reach the failing shim; a no-shell spawn on win32 reaches the real gh.exe
 *    but unauthenticated (sentinel tokens, see noRealGh.test.ts). An env built
 *    without spreading process.env is outside the guard.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { assertGuardActive } from '../support/noRealGh'

const repoRoot = path.resolve(__dirname, '../../..')
const script = path.join(repoRoot, 'tools', 'perf', 'accept.sh')

// Fail closed: this file once posted real perf-nightly statuses. If the suite
// guard did not run (a config without globalSetup), refuse before any case.
beforeAll(() => assertGuardActive(process.env))

type Result = { status: number; output: string }

// On win32 a bare `bash` can be the WSL launcher, which skips the PATH shim
// and the fake gh entirely. Use Git Bash explicitly.
export function resolveGitBash(candidates: string[], exists: (p: string) => boolean): string {
  const found = candidates.find(exists)
  if (!found) throw new Error(`Git Bash required, not found at ${candidates.join(' or ')}`)
  return found
}

function findBash(): string {
  if (process.platform !== 'win32') return 'bash'
  // bash.exe sits under the Git root's bin; --exec-path is <root>/mingw64/libexec/git-core.
  const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 20000 }).trim()
  return resolveGitBash(
    [
      path.resolve(exec, '..', '..', '..', 'bin', 'bash.exe'),
      path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
    ],
    fs.existsSync,
  )
}

let bashCache: string | undefined
const bashPath = () => (bashCache ??= findBash())

function runBash(argv: string[], env: NodeJS.ProcessEnv = process.env): Result {
  const bash = bashPath() // outside the try: a missing Git Bash must surface, not become status -1
  try {
    const output = execFileSync(bash, argv, {
      timeout: 60000,
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

describe('resolveGitBash', () => {
  it('throws "Git Bash required" when no candidate exists', () => {
    expect(() => resolveGitBash(['/no/a', '/no/b'], () => false)).toThrow(/Git Bash required/)
  })
  it('returns the first existing candidate', () => {
    expect(resolveGitBash(['/a', '/b'], p => p === '/b')).toBe('/b')
  })
})

describe('accept.sh refuses before touching gh api', { timeout: 90000 }, () => {
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

describe(
  'accept.sh only accepts a sha in the latest 100 develop commits',
  { timeout: 90000 },
  () => {
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
    const made: string[] = []
    afterAll(() => {
      for (const d of made) fs.rmSync(d, { recursive: true, force: true })
    })

    function fakeGh(window: string): { env: NodeJS.ProcessEnv; log: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-fakegh-'))
      made.push(dir)
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
      timeout: 20000,
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

    it('posts to the full resolved sha when given HEAD (not the literal ref)', () => {
      const { env, log } = fakeGh(head)
      const r = run(['HEAD', 'a reason'], env)
      expect(r.status).toBe(0)
      const logged = fs.readFileSync(log, 'utf8')
      expect(logged).toContain(`statuses/${head}`)
      expect(logged).not.toMatch(/statuses\/HEAD/)
    })
  },
)

describe('the suite-wide guard', { timeout: 90000 }, () => {
  const shimName = path.basename(process.env.HB_NO_REAL_GH_DIR ?? '')

  it('puts the shim dir in the env', () => {
    expect(shimName).toMatch(/^hb-nogh-/)
  })

  it('sets every gh token variable to the sentinel', () => {
    // Own hardcoded list on purpose: must not import TOKEN_VARS, or a name
    // dropped from it would silently drop out of this check too.
    for (const v of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])
      expect(process.env[v] === 'hb-no-real-gh-486').toBe(true)
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

  it('a spawn with no shell is not authenticated (on win32 it reaches gh.exe)', () => {
    const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 20000 })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Logged in/)
  })

  it.skipIf(process.platform !== 'win32')('blocks gh through cmd.exe via gh.cmd', () => {
    const r = spawnSync('gh auth status', { shell: true, encoding: 'utf8', timeout: 20000 })
    expect(r.status).toBe(99)
    expect(`${r.stdout}${r.stderr}`).toMatch(/gh blocked/)
  })
})
