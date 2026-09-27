/**
 * Proof that the content gate (issue #678) can fail, in all three modes it
 * runs in, plus the pre-push hook. Rules and rationale: docs/testing.md.
 *
 * Modeled on lintGate.test.ts: this drives the real CLI (bash + the real
 * script), not a reimplementation of its rules, so a change that quietly
 * defangs a rule fails these tests instead of just the ones next to it.
 *
 * Every case builds a throwaway git repo under the OS temp dir (never this
 * repo, and never a ROM byte - all fixtures are synthetic). Each offending
 * fixture must exit 1 in staged, range AND history modes; a clean control
 * must exit 0, so the gate is not simply always red.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const repoRoot = path.resolve(__dirname, '../../..')
const realScript = path.join(repoRoot, 'tools/scripts/check-staged-content.sh')
const realHook = path.join(repoRoot, '.githooks/pre-push')

const CLI_TIMEOUT_MS = 30000

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contentgate-'))
  run('git', ['init', '-q'])
  run('git', ['config', 'user.email', 'test@example.com'])
  run('git', ['config', 'user.name', 'Test'])
  fs.mkdirSync(path.join(dir, 'tools/scripts'), { recursive: true })
  fs.copyFileSync(realScript, path.join(dir, 'tools/scripts/check-staged-content.sh'))
  writeFile('README.md', 'clean control file\n')
  run('git', ['add', 'README.md'])
  run('git', ['commit', '-q', '-m', 'base'])
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: dir, stdio: 'pipe' }).toString()
}

function writeFile(rel: string, content: string | Buffer): void {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

function gateExit(mode: string, ...args: string[]): number {
  try {
    execFileSync('bash', ['tools/scripts/check-staged-content.sh', mode, ...args], {
      cwd: dir,
      stdio: 'pipe',
    })
    return 0
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
}

function gateOutput(mode: string, ...args: string[]): string {
  try {
    return execFileSync('bash', ['tools/scripts/check-staged-content.sh', mode, ...args], {
      cwd: dir,
      stdio: 'pipe',
    }).toString()
  } catch (err) {
    return (err as { stdout?: Buffer }).stdout?.toString() ?? ''
  }
}

/**
 * Writes a fixture (staged, uncommitted), asserts staged mode blocks it,
 * commits it, asserts range(base..head) blocks it, and asserts history
 * mode blocks it too (content still committed).
 */
function expectBlockedEverywhere(relPath: string, content: string | Buffer): void {
  const base = run('git', ['rev-parse', 'HEAD']).trim()
  writeFile(relPath, content)
  run('git', ['add', relPath])
  expect(gateExit('staged')).not.toBe(0)

  run('git', ['commit', '-q', '-m', `add ${relPath}`])
  const head = run('git', ['rev-parse', 'HEAD']).trim()
  expect(gateExit('range', base, head)).not.toBe(0)
  expect(gateExit('history')).not.toBe(0)
}

function expectCleanEverywhere(relPath: string, content: string | Buffer): void {
  const base = run('git', ['rev-parse', 'HEAD']).trim()
  writeFile(relPath, content)
  run('git', ['add', relPath])
  expect(gateExit('staged')).toBe(0)

  run('git', ['commit', '-q', '-m', `add ${relPath}`])
  const head = run('git', ['rev-parse', 'HEAD']).trim()
  expect(gateExit('range', base, head)).toBe(0)
  expect(gateExit('history')).toBe(0)
}

function hexArray(n: number): string {
  const tokens = Array.from({ length: n }, (_, i) => `0x${(i % 256).toString(16).padStart(2, '0')}`)
  return `export const t = [${tokens.join(', ')}]\n`
}

describe('content gate: clean control', () => {
  it(
    'a plain source file passes in every mode',
    () => {
      expectCleanEverywhere('src/plain.ts', 'export const add = (a: number, b: number) => a + b\n')
    },
    CLI_TIMEOUT_MS,
  )
})

describe('content gate: binary allow-list', () => {
  it(
    'blocks a binary .ppm (P6 header)',
    () => {
      const bytes = Buffer.concat([Buffer.from('P6\n2 2\n255\n'), Buffer.from([0, 1, 2, 3, 4, 5])])
      expectBlockedEverywhere('scripts/x.ppm', bytes)
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'blocks an ASCII (P3) .ppm too - text does not exempt a decoded sheet',
    () => {
      expectBlockedEverywhere(
        'scripts/ascii.ppm',
        'P3\n2 2\n255\n255 0 0 0 255 0 0 0 255 255 255 0\n',
      )
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'blocks a PNG outside the allow-list',
    () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
      expectBlockedEverywhere('scripts/img.png', bytes)
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'lets a PNG inside build/icons/ through',
    () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
      expectCleanEverywhere('build/icons/icon.png', bytes)
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'blocks binary bytes under an unrecognised extension',
    () => {
      const bytes = Buffer.concat([Buffer.from('abc'), Buffer.from([0, 1, 2]), Buffer.from('def')])
      expectBlockedEverywhere('scripts/foo.dat2', bytes)
    },
    CLI_TIMEOUT_MS,
  )
})

describe('content gate: disassembly excerpts', () => {
  it(
    'blocks .asm outright',
    () => {
      expectBlockedEverywhere('docs/excerpt.asm', 'LDA #$00\nSTA $0100\n')
    },
    CLI_TIMEOUT_MS,
  )
})

describe('content gate: content sniffing on added lines', () => {
  it(
    'blocks a base64 blob over ~300 chars in a .ts file',
    () => {
      expectBlockedEverywhere('src/blob.ts', `export const data = '${'A'.repeat(310)}'\n`)
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'lets a short base64 string (88-char integrity-hash length) through',
    () => {
      expectCleanEverywhere(
        'src/hash.ts',
        `export const integrity = 'sha512-${'A'.repeat(86)}=='\n`,
      )
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'blocks a data:image;base64 URI carrying a real payload',
    () => {
      const payload = 'B'.repeat(60)
      expectBlockedEverywhere('docs/pic.html', `<img src="data:image/png;base64,${payload}">\n`)
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'lets a data:image;base64 template placeholder through',
    () => {
      expectCleanEverywhere('docs/placeholder.html', '<img src="data:image/png;base64,__B64__">\n')
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'blocks a 300-entry 0x.. byte array',
    () => {
      expectBlockedEverywhere('src/hex300.ts', hexArray(300))
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'lets a 110-entry 0x.. byte array through (SlopeResolver.test.ts shape)',
    () => {
      expectCleanEverywhere('src/hex110.ts', hexArray(110))
    },
    CLI_TIMEOUT_MS,
  )
})

describe('content gate: pre-push hook', () => {
  it(
    'blocks a push whose range carries a --no-verify-committed defect',
    () => {
      fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true })
      fs.copyFileSync(realHook, path.join(dir, '.githooks/pre-push'))

      // Simulate a remote that already has "base" (HEAD at repo creation).
      const base = run('git', ['rev-parse', 'HEAD']).trim()
      run('git', ['remote', 'add', 'origin', dir])
      run('git', ['update-ref', 'refs/remotes/origin/develop', base])

      // A commit made with --no-verify (no hook is installed in this throwaway
      // repo, so a plain commit already stands in for that).
      writeFile('docs/sneaky.asm', 'LDA #$00\n')
      run('git', ['add', 'docs/sneaky.asm'])
      run('git', ['commit', '-q', '-m', 'sneaky asm add'])
      const head = run('git', ['rev-parse', 'HEAD']).trim()

      const stdinLine = `refs/heads/feature/x ${head} refs/heads/feature/x ${base}\n`
      let status = 0
      try {
        execFileSync('bash', ['.githooks/pre-push'], { cwd: dir, input: stdinLine, stdio: 'pipe' })
      } catch (err) {
        status = (err as { status?: number }).status ?? -1
      }
      expect(status).not.toBe(0)
    },
    CLI_TIMEOUT_MS,
  )
})

describe('content gate: history mode', () => {
  it(
    'still fails on a defect that was added then deleted in a later commit',
    () => {
      writeFile('scripts/gone.ppm', 'P3\n1 1\n255\n255 0 0\n')
      run('git', ['add', 'scripts/gone.ppm'])
      run('git', ['commit', '-q', '-m', 'add defect'])
      run('git', ['rm', '-q', 'scripts/gone.ppm'])
      run('git', ['commit', '-q', '-m', 'remove defect'])

      // The working tree / current HEAD is clean; range and staged modes
      // would both report nothing, which is exactly why history mode
      // exists as the migration oracle.
      expect(gateExit('staged')).toBe(0)
      expect(gateExit('history')).not.toBe(0)
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'reports one parseable line per offender: BLOCKED (<rule>): <path> (first added in <sha>)',
    () => {
      writeFile('scripts/reported.ppm', 'P3\n1 1\n255\n255 0 0\n')
      run('git', ['add', 'scripts/reported.ppm'])
      run('git', ['commit', '-q', '-m', 'add reported defect'])
      const addedSha = run('git', ['rev-parse', 'HEAD']).trim()

      const output = gateOutput('history')
      const line = output.split('\n').find(l => l.includes('scripts/reported.ppm'))
      expect(line).toBeDefined()
      expect(line).toMatch(
        /^BLOCKED \([^)]+\): scripts\/reported\.ppm \(first added in [0-9a-f]{40}\)$/,
      )
      expect(line).toContain(addedSha)
    },
    CLI_TIMEOUT_MS,
  )
})
