/**
 * Proof that the lint and format gates can go red.
 *
 * `npm run lint` used to exit 0 while reporting 14 warnings, so it was a
 * verdict nothing could falsify. These tests plant the two defects the gate
 * exists to catch and assert a non-zero exit, plus a clean file that must
 * still pass, because a checker that fails on everything is equally useless.
 *
 * The planted defects run through the real CLIs rather than the Node APIs:
 * the CLI invocation IS the gate. The flags are not hardcoded here either -
 * they are read out of package.json, so a script edited to drop
 * `--max-warnings 0` fails these tests instead of silently defanging CI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const repoRoot = path.resolve(__dirname, '../../..')
const fixtureDir = path.join(repoRoot, 'test/suite/gates/__fixtures__')

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

/** Runs a CLI and returns its exit code, never throwing on failure. */
function exitCodeOf(cmd: string, args: string[]): number {
  try {
    execFileSync(cmd, args, { cwd: repoRoot, stdio: 'pipe', shell: process.platform === 'win32' })
    return 0
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
}

function writeFixture(name: string, body: string): string {
  const file = path.join(fixtureDir, name)
  fs.writeFileSync(file, body)
  return path.relative(repoRoot, file).split(path.sep).join('/')
}

beforeEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true })
  fs.mkdirSync(fixtureDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true })
})

describe('the lint gate can fail', () => {
  it('rejects an unused variable', () => {
    const file = writeFixture(
      'unused.ts',
      'export function f(): number {\n  const dead = 1\n  return 2\n}\n',
    )
    expect(exitCodeOf('npx', ['eslint', '--max-warnings', '0', file])).not.toBe(0)
  })

  it('rejects a hard error', () => {
    // `require` in a .ts file, which is error severity rather than warning.
    // Proves the gate goes red on errors independently of --max-warnings, and
    // it is the rule that caught two real instances in test/ when the scope
    // widened. `no-undef` deliberately does NOT work here: typescript-eslint
    // turns it off for .ts because the compiler already reports it.
    const file = writeFixture('cjs.ts', "const fs = require('fs')\nexport default fs\n")
    expect(exitCodeOf('npx', ['eslint', '--max-warnings', '0', file])).not.toBe(0)
  })

  it('accepts a clean file, so the gate is not simply always red', () => {
    const file = writeFixture(
      'clean.ts',
      'export function add(a: number, b: number): number {\n  return a + b\n}\n',
    )
    expect(exitCodeOf('npx', ['eslint', '--max-warnings', '0', file])).toBe(0)
  })

  it('would pass the unused variable without --max-warnings 0', () => {
    // Documents WHY the flag is load-bearing: this is the exact state the
    // repo shipped in, where 14 warnings rode along under a green check.
    const file = writeFixture(
      'unused.ts',
      'export function f(): number {\n  const dead = 1\n  return 2\n}\n',
    )
    expect(exitCodeOf('npx', ['eslint', file])).toBe(0)
  })

  it('binds the gate to the real script: npm run lint keeps --max-warnings 0', () => {
    expect(pkg.scripts.lint).toContain('--max-warnings 0')
  })

  it('lints every tree that holds product or test code', () => {
    for (const dir of ['src', 'test', 'tools', 'theia']) {
      expect(pkg.scripts.lint).toContain(dir)
    }
  })
})

describe('the format gate can fail', () => {
  it('rejects a misformatted file', () => {
    const file = writeFixture('ugly.ts', 'export const a   =    {b:1,c:  2};\n')
    expect(exitCodeOf('npx', ['prettier', '--check', file])).not.toBe(0)
  })

  it('rejects house-style violations the config pins', () => {
    // Semicolons and double quotes are what Prettier defaults to and this
    // repo does not use. A config that lost `semi: false` passes this file.
    const file = writeFixture('style.ts', 'export const greeting = "hi";\n')
    expect(exitCodeOf('npx', ['prettier', '--check', file])).not.toBe(0)
  })

  it('accepts a correctly formatted file', () => {
    const file = writeFixture('pretty.ts', "export const greeting = 'hi'\n")
    expect(exitCodeOf('npx', ['prettier', '--check', file])).toBe(0)
  })

  it('checks CSS too', () => {
    const file = writeFixture('ugly.css', '.a{color:red;background:blue}\n')
    expect(exitCodeOf('npx', ['prettier', '--check', file])).not.toBe(0)
  })

  it('binds the gate to the real script: format:check runs prettier --check', () => {
    expect(pkg.scripts['format:check']).toContain('prettier')
    expect(pkg.scripts['format:check']).toContain('--check')
  })

  it('formats only JS/TS/CSS, never prose or config', () => {
    // `prettier --write .` also rewrites Markdown, YAML and JSON. That
    // reformats CLAUDE.md and AGENTS.md, and CLAUDE.md carries a generated
    // region plus a no-em-dash rule that the pre-commit gate then blocks.
    // Caught in review when the unscoped glob swept 60+ docs.
    for (const script of [pkg.scripts.format, pkg.scripts['format:check']]) {
      expect(script).toContain('{ts,tsx,js,mjs,cjs,css}')
    }
  })
})
