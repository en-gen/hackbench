/**
 * Proof that the content gate (issue #678, node rewrite) can fail, in
 * every mode, against every adversarial witness from the design review.
 * Rules and rationale: docs/testing.md ("The content gate").
 *
 * Two layers:
 *  - a rules table calling checkPath/checkBlob in-process (no git, no
 *    subprocess - fast unit coverage of the pure functions);
 *  - CLI-level cases that drive the real script against a throwaway git
 *    repo per case (never this repo, never a ROM byte), across staged,
 *    range and history modes, plus push/shallow/tag-at-blob edge cases
 *    that only make sense in their own mode.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { checkBlob, checkPath } from '../../../tools/scripts/check-content.mjs'

const repoRoot = path.resolve(__dirname, '../../..')
const realScript = path.join(repoRoot, 'tools/scripts/check-content.mjs')
const CLI_TIMEOUT_MS = 30000
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ---------------------------------------------------------------------------
// Layer 1: rules table, in-process
// ---------------------------------------------------------------------------

function rule(hits: { rule: string }[]): string[] {
  return hits.map(h => h.rule)
}

describe('checkPath: hard-blocked extensions, never allow-listed', () => {
  it.each([
    ['x.smc', 'rom-ext'],
    ['x.sfc', 'rom-ext'],
    ['x.ips', 'rom-ext'],
    ['x.bps', 'rom-ext'],
    ['x.wasm', 'native-ext'],
    ['x.dll', 'native-ext'],
    ['x.asm', 'asm-ext'],
    ['x.s', 'asm-ext'],
    ['x.inc', 'asm-ext'],
    ['tools/mesen/dump.txt', 'mesen-trace'],
    ['test/fixtures/lvl.json', 'fixture'],
  ])('%s -> %s', (p, expected) => {
    expect(rule(checkPath(p))).toContain(expected)
  })

  it('build/icons/smw.sfc is still blocked: the allow-list never overrides a hard block', () => {
    expect(rule(checkPath('build/icons/smw.sfc'))).toContain('rom-ext')
  })

  it('theia/no-native/core.wasm is still blocked the same way', () => {
    expect(rule(checkPath('theia/no-native/core.wasm'))).toContain('native-ext')
  })

  it('tools/mesen/*.lua and README.md are exempt', () => {
    expect(checkPath('tools/mesen/l1_dump.lua')).toEqual([])
    expect(checkPath('tools/mesen/README.md')).toEqual([])
  })

  it('test/fixtures/README.md is exempt', () => {
    expect(checkPath('test/fixtures/README.md')).toEqual([])
  })
})

describe('checkPath: allow-list scope', () => {
  it('build/icons/*.png passes; build/*.png (not under icons/) is blocked', () => {
    expect(checkPath('build/icons/x.png')).toEqual([])
    expect(rule(checkPath('build/x.png'))).toContain('image-ext')
  })

  it('theia/no-native/*.node passes; the same extension elsewhere is blocked', () => {
    expect(checkPath('theia/no-native/core.node')).toEqual([])
    expect(rule(checkPath('src/core.node'))).toEqual([]) // .node isn't an image/dump ext
  })

  it('a decoded image extension outside any allow-list is blocked', () => {
    for (const ext of ['ppm', 'bmp', 'gif', 'chr', 'raw', 'dmp', 'gfx']) {
      expect(rule(checkPath(`scripts/x.${ext}`))).toContain('image-ext')
    }
  })
})

describe('checkBlob: binary detection', () => {
  it('a NUL in the first 8000 bytes is binary, regardless of extension', () => {
    const buf = Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.from('def')])
    expect(rule(checkBlob('x.dat2', buf))).toContain('binary')
  })

  it('an allow-listed build/icons PNG (real magic, under the size cap) is exempt', () => {
    const buf = Buffer.concat([PNG_MAGIC, Buffer.from([0, 0, 0, 0x0d])])
    expect(checkBlob('build/icons/x.png', buf)).toEqual([])
  })

  it('a build/icons PNG with the wrong magic bytes is still blocked', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd, 0xfc]), Buffer.from('notpng')])
    expect(rule(checkBlob('build/icons/fake.png', buf))).toContain('binary')
  })

  it('a build/icons PNG over the 512 KB size cap is blocked despite real magic', () => {
    const buf = Buffer.concat([PNG_MAGIC, Buffer.alloc(513 * 1024, 1)])
    expect(rule(checkBlob('build/icons/big.png', buf))).toContain('binary')
  })

  it('theia/no-native carries no binary exemption at all (removed - its real content is 0-byte stubs)', () => {
    const buf = Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.from('realbinary')])
    expect(rule(checkBlob('theia/no-native/core.node', buf))).toContain('binary')
  })

  it('a NUL anywhere in the blob is binary, not just the first 8000 bytes', () => {
    const buf = Buffer.concat([Buffer.alloc(8001, 0x41), Buffer.from([0])])
    expect(rule(checkBlob('x.dat2', buf))).toContain('binary')
  })

  it('invalid UTF-8 with no NUL byte at all is still binary', () => {
    const buf = Buffer.alloc(8100, 0xff) // never a valid UTF-8 sequence, never a NUL
    expect(rule(checkBlob('x.dat2', buf))).toContain('binary')
  })
})

describe('checkBlob: content sniffing', () => {
  it('a base64 blob over ~300 chars blocks; under it passes', () => {
    expect(rule(checkBlob('x.ts', Buffer.from(`'${'A'.repeat(310)}'`)))).toContain('base64')
    expect(rule(checkBlob('x.ts', Buffer.from(`'sha512-${'A'.repeat(86)}=='`)))).not.toContain(
      'base64',
    )
  })

  it('a data:*;base64, URI with a payload blocks; a placeholder passes', () => {
    expect(
      rule(checkBlob('x.html', Buffer.from(`data:image/png;base64,${'B'.repeat(60)}`))),
    ).toContain('data-uri')
    expect(checkBlob('x.html', Buffer.from('data:image/png;base64,__B64__'))).toEqual([])
  })

  it('a run of over 1024 byte-tokens blocks; isolated ASM citations never count', () => {
    const big = Array.from(
      { length: 1100 },
      (_, i) => `0x${(i % 256).toString(16).padStart(2, '0')}`,
    ).join(', ')
    expect(rule(checkBlob('x.ts', Buffer.from(`[${big}]`)))).toContain('byte-tokens')

    const citations = Array.from(
      { length: 2000 },
      (_, i) => `AND #$0F ; 0x${(i % 256).toString(16)}`,
    ).join('\n')
    expect(rule(checkBlob('x.ts', Buffer.from(citations)))).not.toContain('byte-tokens')
  })

  it('a disassembly listing (20+ matching lines) blocks, in any text file', () => {
    const listing = Array.from(
      { length: 25 },
      (_, i) => `81/${(0x8000 + i).toString(16)}:\tBD8815  \tlda $1588,X`,
    ).join('\n')
    expect(rule(checkBlob('docs/x.md', Buffer.from(listing)))).toContain('disasm-listing')

    const listing2 = Array.from(
      { length: 25 },
      (_, i) => `${(0x058800 + i).toString(16).padStart(6, '0')}:  LDA [$65],Y`,
    ).join('\n')
    expect(rule(checkBlob('docs/x.s', Buffer.from(listing2)))).toContain('disasm-listing')
  })

  it('the content-gate: allow pragma exempts one file from one content rule only', () => {
    const big = Array.from(
      { length: 1100 },
      (_, i) => `0x${(i % 256).toString(16).padStart(2, '0')}`,
    ).join(', ')
    const text = `// content-gate: allow byte-tokens -- CPU opcode-length spec table\n[${big}]`
    expect(checkBlob('x.ts', Buffer.from(text))).toEqual([])
    // never exempts path/binary rules
    expect(rule(checkPath('x.asm'))).toContain('asm-ext')
  })

  it('lockfiles are never content-sniffed', () => {
    expect(checkBlob('package-lock.json', Buffer.from(`"${'A'.repeat(400)}"`))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Layer 2: CLI, throwaway git repos
// ---------------------------------------------------------------------------

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contentgate-'))
  run('git', ['init', '-q'])
  run('git', ['config', 'user.email', 'test@example.com'])
  run('git', ['config', 'user.name', 'Test'])
  run('git', ['config', 'color.ui', 'always']) // must not leak ANSI into our parsing
  fs.mkdirSync(path.join(dir, 'tools/scripts'), { recursive: true })
  fs.copyFileSync(realScript, path.join(dir, 'tools/scripts/check-content.mjs'))
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

function head(): string {
  return run('git', ['rev-parse', 'HEAD']).trim()
}

/** A genuinely separate bare repo added as `origin` - never the test repo
 * itself (a self-remote reports its OWN current tip via ls-remote, which
 * silently excludes everything and makes every push test a false pass). */
function addBareRemote(name: string): string {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'contentgate-remote-'))
  spawnSync('git', ['init', '-q', '--bare', bare])
  run('git', ['remote', 'add', name, bare])
  return bare
}

function pushToRemote(name: string): void {
  execFileSync('git', ['push', '-q', name, 'HEAD:refs/heads/master'], { cwd: dir, stdio: 'pipe' })
}

function gateExit(mode: string, ...args: string[]): number {
  try {
    execFileSync('node', ['tools/scripts/check-content.mjs', mode, ...args], {
      cwd: dir,
      stdio: 'pipe',
    })
    return 0
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
}

function gateExitWithInput(mode: string, input: string, ...args: string[]): number {
  try {
    execFileSync('node', ['tools/scripts/check-content.mjs', mode, ...args], {
      cwd: dir,
      input,
      stdio: 'pipe',
    })
    return 0
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
}

function gateOutput(mode: string, ...args: string[]): string {
  try {
    return execFileSync('node', ['tools/scripts/check-content.mjs', mode, ...args], {
      cwd: dir,
      stdio: 'pipe',
    }).toString()
  } catch (err) {
    return (err as { stdout?: Buffer }).stdout?.toString() ?? ''
  }
}

function expectBlockedEverywhere(relPath: string, content: string | Buffer): void {
  const base = head()
  writeFile(relPath, content)
  run('git', ['add', relPath])
  expect(gateExit('staged')).not.toBe(0)

  run('git', ['commit', '-q', '-m', `add ${relPath}`])
  expect(gateExit('range', base, head())).not.toBe(0)
  expect(gateExit('history')).not.toBe(0)
}

function expectCleanEverywhere(relPath: string, content: string | Buffer): void {
  const base = head()
  writeFile(relPath, content)
  run('git', ['add', relPath])
  expect(gateExit('staged')).toBe(0)

  run('git', ['commit', '-q', '-m', `add ${relPath}`])
  expect(gateExit('range', base, head())).toBe(0)
  expect(gateExit('history')).toBe(0)
}

describe(
  'content gate CLI: clean control and basics',
  () => {
    it('a plain source file passes in every mode', () => {
      expectCleanEverywhere('src/plain.ts', 'export const add = (a: number, b: number) => a + b\n')
    })

    it('a binary .ppm blocks in every mode', () => {
      const bytes = Buffer.concat([Buffer.from('P6\n2 2\n255\n'), Buffer.from([0, 1, 2, 3, 4, 5])])
      expectBlockedEverywhere('scripts/x.ppm', bytes)
    })

    it('rom_ext without a NUL byte still blocks on extension alone (x.ips = plain text)', () => {
      expectBlockedEverywhere('patches/x.ips', 'PATCH000000000EOF')
    })
  },
  CLI_TIMEOUT_MS,
)

describe(
  'content gate CLI: rename witnesses',
  () => {
    it('a rename onto a blocked extension is caught (--no-renames shows it as add+delete)', () => {
      const base = head()
      writeFile('clean.txt', 'hello\n')
      run('git', ['add', 'clean.txt'])
      run('git', ['commit', '-q', '-m', 'add clean'])
      run('git', ['mv', 'clean.txt', 'clean.asm'])
      run('git', ['add', '-A'])
      expect(gateExit('staged')).not.toBe(0)
      run('git', ['commit', '-q', '-m', 'rename to asm'])
      expect(gateExit('range', base, head())).not.toBe(0)
    })

    it('a rename away from a blocked extension (a.ppm -> a.txt) is judged on the new path', () => {
      writeFile('a.ppm', 'P3\n1 1\n255\n255 0 0\n')
      run('git', ['add', 'a.ppm'])
      run('git', ['commit', '-q', '-m', 'add ppm'])
      run('git', ['mv', 'a.ppm', 'a.txt'])
      run('git', ['add', '-A'])
      expect(gateExit('staged')).toBe(0) // extension rule no longer applies; content is clean text
    })
  },
  CLI_TIMEOUT_MS,
)

describe(
  'content gate CLI: filenames and git quirks',
  () => {
    it('a non-ASCII filename is handled (core.quotePath=false, -z parsing)', () => {
      expectBlockedEverywhere('tiles-é.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))
    })

    it('color.ui=always does not corrupt our diff/log parsing', () => {
      // beforeEach already set color.ui=always; this just proves a normal
      // add-then-check still works cleanly with it on.
      expectCleanEverywhere('src/x.ts', 'export const x = 1\n')
    })

    it('a .gitattributes marking *.dat as diff=text does not defeat our own binary check', () => {
      writeFile('.gitattributes', '*.dat diff\n')
      run('git', ['add', '.gitattributes'])
      run('git', ['commit', '-q', '-m', 'attrs'])
      const bytes = Buffer.concat([Buffer.from('abc'), Buffer.from([0, 1, 2]), Buffer.from('def')])
      expectBlockedEverywhere('x.dat', bytes)
    })

    it('a symlink-to-file type change (T status) is walked without crashing', () => {
      writeFile('target.txt', 'hi\n')
      run('git', ['add', 'target.txt'])
      run('git', ['commit', '-q', '-m', 'add target'])
      writeFile('link.txt', 'placeholder\n')
      run('git', ['add', 'link.txt'])
      run('git', ['commit', '-q', '-m', 'add placeholder'])
      const base = head()
      fs.unlinkSync(path.join(dir, 'link.txt'))
      try {
        fs.symlinkSync('target.txt', path.join(dir, 'link.txt'))
      } catch {
        return // symlinks need elevation on some Windows configs; skip rather than fail the suite
      }
      run('git', ['add', 'link.txt'])
      expect(gateExit('staged')).toBe(0)
      run('git', ['commit', '-q', '-m', 'symlink swap'])
      expect(gateExit('range', base, head())).toBe(0)
    })
  },
  CLI_TIMEOUT_MS,
)

describe(
  'content gate CLI: push mode',
  () => {
    it('add-then-delete within one push range is still caught', () => {
      const bare = addBareRemote('origin')
      const base = head()
      pushToRemote('origin') // the remote genuinely has `base` now
      writeFile('gone.ppm', 'P3\n1 1\n255\n255 0 0\n')
      run('git', ['add', 'gone.ppm'])
      run('git', ['commit', '-q', '-m', 'add defect'])
      run('git', ['rm', '-q', 'gone.ppm'])
      run('git', ['commit', '-q', '-m', 'remove defect'])
      const line = `refs/heads/x ${head()} refs/heads/x ${base}\n`
      expect(gateExitWithInput('push', line, 'origin')).not.toBe(0)
      fs.rmSync(bare, { recursive: true, force: true })
    })

    it('pushing known history to a brand-new, empty remote scans everything', () => {
      addBareRemote('origin') // never pushed to: genuinely empty
      writeFile('sneaky.asm', 'LDA #$00\n')
      run('git', ['add', 'sneaky.asm'])
      run('git', ['commit', '-q', '-m', 'sneaky'])
      const zero = '0'.repeat(40)
      const line = `refs/heads/x ${head()} refs/heads/x ${zero}\n`
      expect(gateExitWithInput('push', line, 'origin')).not.toBe(0)
    })

    it('a stale remote-tracking ref checks nothing without ls-remote (the migration witness)', () => {
      const bare = addBareRemote('origin')
      pushToRemote('origin') // remote has `base`
      const base = head()
      writeFile('sneaky2.asm', 'LDA #$00\n')
      run('git', ['add', 'sneaky2.asm'])
      run('git', ['commit', '-q', '-m', 'sneaky after push'])
      // Empty the remote out from under the stale local refs/remotes/origin/*
      // (never updated here) - ls-remote must see the CURRENT (empty) state.
      fs.rmSync(bare, { recursive: true, force: true })
      spawnSync('git', ['init', '-q', '--bare', bare])
      const line = `refs/heads/x ${head()} refs/heads/x ${base}\n`
      expect(gateExitWithInput('push', line, 'origin')).not.toBe(0)
      fs.rmSync(bare, { recursive: true, force: true })
    })

    it('a delete line (local sha all zero) is skipped without even calling ls-remote', () => {
      const zero = '0'.repeat(40)
      const line = `refs/heads/x ${zero} refs/heads/x ${head()}\n`
      // No remote named "origin" configured at all - if this tried to
      // query it, it would fail closed (exit 2). A clean 0 proves the
      // delete-only push never reaches ls-remote.
      expect(gateExitWithInput('push', line, 'origin')).toBe(0)
    })

    it('ls-remote against an unreachable remote fails closed with exit 2', () => {
      run('git', ['remote', 'add', 'origin', '/no/such/path/at/all'])
      const line = `refs/heads/x ${head()} refs/heads/x ${'0'.repeat(40)}\n`
      expect(gateExitWithInput('push', line, 'origin')).toBe(2)
    })

    it('a pushed sha that is not a commit fails closed with exit 2', () => {
      addBareRemote('origin')
      const blobSha = run('git', ['rev-parse', 'HEAD:README.md']).trim()
      const zero = '0'.repeat(40)
      const line = `refs/heads/x ${blobSha} refs/heads/x ${zero}\n`
      expect(gateExitWithInput('push', line, 'origin')).toBe(2)
    })

    it('the offender in the SECOND pushed ref line is still found', () => {
      const bare = addBareRemote('origin')
      pushToRemote('origin')
      const base = head()
      writeFile('clean2.ts', 'export const y = 2\n')
      run('git', ['add', 'clean2.ts'])
      run('git', ['commit', '-q', '-m', 'clean second branch commit'])
      const cleanHead = head()
      run('git', ['branch', 'other', base])
      run('git', ['checkout', '-q', 'other'])
      writeFile('bad.asm', 'LDA #$00\n')
      run('git', ['add', 'bad.asm'])
      run('git', ['commit', '-q', '-m', 'bad on second branch'])
      const badHead = head()
      const lines =
        `refs/heads/main ${cleanHead} refs/heads/main ${base}\n` +
        `refs/heads/other ${badHead} refs/heads/other ${base}\n`
      expect(gateExitWithInput('push', lines, 'origin')).not.toBe(0)
      fs.rmSync(bare, { recursive: true, force: true })
    })

    it('a commit reachable only via refs/remotes/origin locally is still found when pushed to a new remote', () => {
      const staleBare = addBareRemote('stale-origin')
      writeFile('remote-only.asm', 'LDA #$00\n')
      run('git', ['add', 'remote-only.asm'])
      run('git', ['commit', '-q', '-m', 'only under refs/remotes'])
      const onlyRemoteSha = head()
      pushToRemote('stale-origin')
      run('git', ['update-ref', 'refs/remotes/stale-origin/master', onlyRemoteSha])
      run('git', ['reset', '-q', '--hard', 'HEAD~1']) // no local branch points at it anymore
      const newBare = addBareRemote('brand-new')
      const line = `refs/heads/x ${onlyRemoteSha} refs/heads/x ${'0'.repeat(40)}\n`
      expect(gateExitWithInput('push', line, 'brand-new')).not.toBe(0)
      fs.rmSync(staleBare, { recursive: true, force: true })
      fs.rmSync(newBare, { recursive: true, force: true })
    })
  },
  CLI_TIMEOUT_MS,
)

describe(
  'content gate CLI: history mode edge cases',
  () => {
    it('refuses a shallow clone', () => {
      const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'contentgate-shallow-'))
      spawnSync('git', ['clone', '--quiet', '--depth', '1', `file://${dir}`, shallow])
      fs.mkdirSync(path.join(shallow, 'tools/scripts'), { recursive: true })
      fs.copyFileSync(realScript, path.join(shallow, 'tools/scripts/check-content.mjs'))
      const res = spawnSync('node', ['tools/scripts/check-content.mjs', 'history'], {
        cwd: shallow,
      })
      expect(res.status).toBe(2)
      fs.rmSync(shallow, { recursive: true, force: true })
    })

    it('a tag pointing directly at a blob fails closed (unreachable by any commit path)', () => {
      const blobFile = fs.mkdtempSync(path.join(os.tmpdir(), 'contentgate-blob-'))
      const p = path.join(blobFile, 'x')
      fs.writeFileSync(p, 'untracked content\n')
      const sha = run('git', ['hash-object', '-w', p]).trim()
      run('git', ['tag', '-a', 'danglytag', '-m', 'tag at a blob', sha])
      expect(gateExit('history')).toBe(2)
      fs.rmSync(blobFile, { recursive: true, force: true })
    })

    it('a defect only on a side branch (not on the default branch) is still found', () => {
      run('git', ['checkout', '-qb', 'side'])
      writeFile('side-defect.asm', 'LDA #$00\n')
      run('git', ['add', 'side-defect.asm'])
      run('git', ['commit', '-q', '-m', 'side defect'])
      run('git', ['checkout', '-q', 'master'])
      const out = gateOutput('history')
      expect(out).toMatch(/side-defect\.asm/)
    })

    it('a defect reachable only via an annotated tag on its commit is still found', () => {
      writeFile('tagged-defect.asm', 'LDA #$00\n')
      run('git', ['add', 'tagged-defect.asm'])
      run('git', ['commit', '-q', '-m', 'tagged defect'])
      run('git', ['tag', '-a', 'v-defect', '-m', 'annotated'])
      run('git', ['reset', '-q', '--hard', 'HEAD~1']) // no branch points at the defect commit anymore
      const out = gateOutput('history')
      expect(out).toMatch(/tagged-defect\.asm/)
    })

    it('identical bytes at an allowed path and a blocked path are judged independently', () => {
      const bytes = Buffer.concat([PNG_MAGIC, Buffer.from([0, 0, 0, 0x0d])])
      writeFile('build/icons/same.png', bytes)
      writeFile('src/same.png', bytes)
      run('git', ['add', '-A'])
      run('git', ['commit', '-q', '-m', 'same bytes, two paths'])
      const out = gateOutput('history')
      expect(out).not.toMatch(/build\/icons\/same\.png/)
      expect(out).toMatch(/src\/same\.png/)
    })

    it('reports one line per offender: BLOCKED (<rule>): <path> (first added in <sha>)', () => {
      writeFile('scripts/reported.ppm', 'P3\n1 1\n255\n255 0 0\n')
      run('git', ['add', 'scripts/reported.ppm'])
      run('git', ['commit', '-q', '-m', 'add reported defect'])
      const addedSha = head()
      const line = gateOutput('history')
        .split('\n')
        .find(l => l.includes('scripts/reported.ppm'))
      expect(line).toMatch(
        /^BLOCKED \([^)]+\): scripts\/reported\.ppm \(first added in [0-9a-f]{40}\)$/,
      )
      expect(line).toContain(addedSha)
    })
  },
  CLI_TIMEOUT_MS,
)

describe(
  'content gate CLI: em-dash (staged/range only)',
  () => {
    it('blocks an em-dash on an added line in staged and range, but not history', () => {
      const emdash = Buffer.from([0xe2, 0x80, 0x94]).toString('utf8')
      const base = head()
      writeFile('docs/x.md', `clean\nthis has an em${emdash}dash\n`)
      run('git', ['add', 'docs/x.md'])
      expect(gateExit('staged')).not.toBe(0)
      run('git', ['commit', '-q', '-m', 'add em-dash'])
      expect(gateExit('range', base, head())).not.toBe(0)
      expect(gateExit('history')).toBe(0) // history is rule 1 (copyright) only, by design
    })

    it('range refuses an unknown base with exit 2', () => {
      expect(gateExit('range', 'd'.repeat(40), head())).toBe(2)
    })
  },
  CLI_TIMEOUT_MS,
)

describe(
  'content gate CLI: round 2 - remote/message/graft/parser hardening',
  () => {
    it('an evil merge adds a .ppm only through one parent (-m walks every parent)', () => {
      const base = head()
      run('git', ['checkout', '-qb', 'side2'])
      writeFile('side2.txt', 'side\n')
      run('git', ['add', 'side2.txt'])
      run('git', ['commit', '-q', '-m', 'side2 commit'])
      run('git', ['checkout', '-q', 'master'])
      writeFile('evil.ppm', 'P3\n1 1\n255\n255 0 0\n')
      run('git', ['add', 'evil.ppm'])
      run('git', ['commit', '-q', '-m', 'add evil.ppm on master'])
      run('git', ['merge', '-q', '--no-edit', 'side2'])
      expect(gateExit('range', base, head())).not.toBe(0)
    })

    it('a root commit is still walked in history mode even with repo-local log.showRoot=false', () => {
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'contentgate-root-'))
      const g = (args: string[]) => execFileSync('git', args, { cwd: fresh })
      g(['init', '-q'])
      g(['config', 'user.email', 't@t.com'])
      g(['config', 'user.name', 't'])
      g(['config', 'log.showRoot', 'false']) // our -c log.showRoot=true must still win
      fs.writeFileSync(path.join(fresh, 'root.asm'), 'LDA #$00\n')
      g(['add', 'root.asm'])
      g(['commit', '-q', '-m', 'root commit with a defect'])
      fs.mkdirSync(path.join(fresh, 'tools/scripts'), { recursive: true })
      fs.copyFileSync(realScript, path.join(fresh, 'tools/scripts/check-content.mjs'))
      const hist = spawnSync('node', ['tools/scripts/check-content.mjs', 'history'], { cwd: fresh })
      expect(hist.stdout.toString()).toMatch(/root\.asm/)
      fs.rmSync(fresh, { recursive: true, force: true })
    })

    it('an existing text file modified to contain a NUL is caught', () => {
      writeFile('goeswrong.ts', 'export const a = 1\n')
      run('git', ['add', 'goeswrong.ts'])
      run('git', ['commit', '-q', '-m', 'clean text file'])
      const base = head()
      writeFile(
        'goeswrong.ts',
        Buffer.concat([Buffer.from('export const a = '), Buffer.from([0]), Buffer.from('1\n')]),
      )
      run('git', ['add', 'goeswrong.ts'])
      expect(gateExit('staged')).not.toBe(0)
      run('git', ['commit', '-q', '-m', 'corrupted with a NUL'])
      expect(gateExit('range', base, head())).not.toBe(0)
    })

    it('a symlink whose target is 4 KB of base64 is caught (targets are checked as text)', () => {
      writeFile('target-holder.txt', 'irrelevant\n')
      run('git', ['add', 'target-holder.txt'])
      run('git', ['commit', '-q', '-m', 'base for symlink'])
      const longTarget = 'A'.repeat(4000)
      try {
        fs.symlinkSync(longTarget, path.join(dir, 'evil-link'))
      } catch {
        return // needs elevation on some Windows configs; skip rather than fail the suite
      }
      run('git', ['add', 'evil-link'])
      expect(gateExit('staged')).not.toBe(0)
    })

    it('a git replace object does not hide what actually gets pushed', () => {
      // The replacement must run the OTHER way from a naive read: replace
      // the BAD commit with a CLEAN one, so that without --no-replace-objects
      // every read of the bad commit's sha (log walk, cat-file) transparently
      // returns the clean commit's content instead - hiding the defect from
      // anyone who resolves it through the replace ref, which is exactly
      // what git does by default. If the earlier direction (replacing the
      // clean decoy with the real one) is used instead, the real commit is
      // still an ordinary ANCESTOR reachable by a normal walk regardless of
      // any replace, so the test proves nothing - that was the actual gap.
      const base = head()
      writeFile('real.asm', 'LDA #$00\n')
      run('git', ['add', 'real.asm'])
      run('git', ['commit', '-q', '-m', 'has a real defect']) // this sha is what the branch ref keeps
      const badSha = head()

      run('git', ['branch', 'decoy-branch', base])
      run('git', ['checkout', '-q', 'decoy-branch'])
      writeFile('clean.txt', 'looks clean\n')
      run('git', ['add', 'clean.txt'])
      run('git', ['commit', '-q', '-m', 'clean decoy, same parent'])
      const cleanSha = head()
      run('git', ['checkout', '-q', 'master'])
      run('git', ['branch', '-D', 'decoy-branch'])

      run('git', ['replace', badSha, cleanSha]) // reading badSha now transparently yields cleanSha

      expect(gateExit('range', base, badSha)).not.toBe(0)
      expect(gateExit('history')).not.toBe(0)
      const bare = addBareRemote('origin')
      const line = `refs/heads/x ${badSha} refs/heads/x ${'0'.repeat(40)}\n`
      expect(gateExitWithInput('push', line, 'origin')).not.toBe(0)
      fs.rmSync(bare, { recursive: true, force: true })
    })

    it('base64url in a string is caught (- and _ instead of + and /)', () => {
      const blob = Array.from({ length: 320 }, () => 'A')
        .join('')
        .replace(/A{4}/g, 'A-B_')
      expectBlockedEverywhere('src/b64url.ts', `export const t = '${blob}'\n`)
    })

    it('a markdown table interleaved with alphanumeric lines passes clean', () => {
      const rows = Array.from(
        { length: 40 },
        (_, i) => `| ${(i * 16).toString(16).padStart(4, '0')} | entry ${i} | ok |`,
      ).join('\n')
      expectCleanEverywhere('docs/table.md', `# Table\n\n${rows}\n`)
    })

    it('a lightweight tag pointing at a git-mktree tree fails closed with exit 2', () => {
      const blobSha = run('git', ['rev-parse', 'HEAD:README.md']).trim()
      const entry = `100644 blob ${blobSha}\torphan-entry.md\n`
      const treeSha = execFileSync('git', ['mktree'], { cwd: dir, input: entry }).toString().trim()
      run('git', ['tag', 'lightweight-at-tree', treeSha]) // not any commit's own root tree
      expect(gateExit('history')).toBe(2)
    })

    it('an oversize blob is blocked with rule oversize, not sniffed', () => {
      // Genuine prose - spaces and punctuation break any base64/byte-token
      // run, so this trips ONLY the size check, never another rule. That
      // is the point: a mutant that disables the oversize check outright
      // must not survive by accident on a base64-alphabet filler string.
      const sentence = 'The quick brown fox jumps over the lazy dog, again and again. '
      const prose = sentence.repeat(Math.ceil((9 * 1024 * 1024) / sentence.length))
      writeFile('huge.ts', prose)
      run('git', ['add', 'huge.ts'])
      expect(gateExit('staged')).not.toBe(0)
      const hugeLines = gateOutput('staged')
        .split('\n')
        .filter(l => l.includes('huge.ts'))
      expect(hugeLines).toEqual(['BLOCKED (oversize): huge.ts'])
    })

    it('a base64 commit message is caught in range/push/history', () => {
      writeFile('clean3.ts', 'export const z = 3\n')
      run('git', ['add', 'clean3.ts'])
      const base = head()
      run('git', ['commit', '-q', '-m', `payload ${'A'.repeat(400)}`])
      expect(gateExit('range', base, head())).not.toBe(0)
      expect(gateExit('history')).not.toBe(0)
    })

    it('a reviewed commit message is exempt for its one rule only, never its files', () => {
      const reviewed = (line: string) => writeFile('tools/scripts/content-gate-reviewed.txt', line)
      writeFile('clean4.ts', 'export const w = 4\n')
      run('git', ['add', 'clean4.ts'])
      run('git', ['commit', '-q', '-m', `payload ${'B'.repeat(400)}`])
      const sha = head()
      expect(gateExit('history')).not.toBe(0)
      reviewed(`${sha} base64 -- prose, checked by hand\n`)
      expect(gateExit('history')).toBe(0) // not just absent output: a crash prints nothing too
      expect(gateOutput('history')).not.toContain(sha)
      reviewed(`${sha} disasm-listing -- wrong rule\n`)
      expect(gateOutput('history')).toContain(`<commit message ${sha}>`)
      reviewed(`${sha} base64\n`) // no reason
      expect(gateExit('history')).toBe(2)
      reviewed(`${sha} base-64 -- misspelled rule\n`)
      expect(gateExit('history')).toBe(2)
      // The same commit adding a base64 file stays blocked: files are never exempt.
      writeFile('blob.ts', `export const s = '${'C'.repeat(400)}'\n`)
      run('git', ['add', 'blob.ts'])
      run('git', ['commit', '-q', '-m', `again ${'D'.repeat(400)}`])
      reviewed(`${head()} base64 -- message only\n`)
      expect(gateOutput('history')).toContain('blob.ts')
      fs.rmSync(path.join(dir, 'tools/scripts/content-gate-reviewed.txt'))
    })

    it('pragma via evaluateEntry never exempts path or binary rules, even with a valid reason', () => {
      const buf = Buffer.concat([
        Buffer.from('// content-gate: allow binary -- please\n'),
        Buffer.from([0]),
      ])
      expectBlockedEverywhere('x.dat2', buf)
    })
  },
  CLI_TIMEOUT_MS,
)

describe(
  'content gate: round 1 mutant survivors',
  () => {
    // M4: a lone "$XX" token must never count; only a 2+ run does.
    it('M4: isolated $-hex tokens never trip byte-tokens, a run of them does', () => {
      const isolated = Array.from(
        { length: 2000 },
        (_, i) => `AND #$${(i % 256).toString(16)}`,
      ).join('\n')
      expect(rule(checkBlob('x.ts', Buffer.from(isolated)))).not.toContain('byte-tokens')
      const run_ = Array.from(
        { length: 1100 },
        (_, i) => `$${(i % 256).toString(16).padStart(2, '0')}`,
      ).join(', ')
      expect(rule(checkBlob('x.ts', Buffer.from(run_)))).toContain('byte-tokens')
    })

    // M14: lockfile skip must stay narrow (exact basename), not swallow any
    // *.json - a sibling data.json with the same high-entropy shape blocks.
    it('M14: lockfile exemption never widens to other .json files', () => {
      const blob = 'A'.repeat(310)
      expect(checkBlob('package-lock.json', Buffer.from(`"${blob}"`))).toEqual([])
      expect(rule(checkBlob('data.json', Buffer.from(`"${blob}"`)))).toContain('base64')
    })

    // M20: add-then-delete within a `range` (not just push/history) is caught.
    it('M20: add-then-delete within one range is still caught', () => {
      const base = head()
      writeFile('gone-range.ppm', 'P3\n1 1\n255\n255 0 0\n')
      run('git', ['add', 'gone-range.ppm'])
      run('git', ['commit', '-q', '-m', 'add defect'])
      run('git', ['rm', '-q', 'gone-range.ppm'])
      run('git', ['commit', '-q', '-m', 'remove defect'])
      expect(gateExit('range', base, head())).not.toBe(0)
    })
  },
  CLI_TIMEOUT_MS,
)

describe(
  'content gate: cat-file --batch boundary parsing',
  () => {
    // Each case puts the boundary blob in the SAME batch call as a second,
    // ordinary file, so a mis-parse of one blob's header/body boundary
    // would corrupt the read of whatever comes after it - the shape every
    // one of these actually guards against.
    it('body one byte short: the only NUL is the last byte of a 4-byte blob', () => {
      writeFile('boundary-a.dat2', Buffer.from([0x61, 0x62, 0x63, 0x00])) // "abc\0"
      writeFile('boundary-a-sibling.ts', 'export const ok = 1\n')
      run('git', ['add', '-A'])
      expect(gateOutput('staged')).toMatch(/BLOCKED \(binary\): boundary-a\.dat2/)
    })

    it('body cut at first \\n: NUL sits after an embedded newline in the body', () => {
      writeFile('boundary-b.dat2', Buffer.from([0x61, 0x62, 0x63, 0x0a, 0x78, 0x00])) // "abc\nx\0"
      writeFile('boundary-b-sibling.ts', 'export const ok = 1\n')
      run('git', ['add', '-A'])
      expect(gateOutput('staged')).toMatch(/BLOCKED \(binary\): boundary-b\.dat2/)
    })

    it('a 9000-byte clean blob (over the old 8000-byte window) does not misalign the next blob in the batch', () => {
      writeFile('a-boundary-big.txt', 'x'.repeat(9000)) // sorts first: read before the offender
      writeFile('b-boundary-offender.asm', 'LDA #$00\n')
      run('git', ['add', '-A'])
      expect(gateExit('staged')).not.toBe(0)
      expect(gateOutput('staged')).toMatch(/b-boundary-offender\.asm/)
    })

    it('a 0-byte blob next to an offender does not misalign the batch either', () => {
      writeFile('a-boundary-empty.txt', '')
      writeFile('b-boundary-offender2.asm', 'LDA #$00\n')
      run('git', ['add', '-A'])
      expect(gateOutput('staged')).toMatch(/b-boundary-offender2\.asm/)
    })
  },
  CLI_TIMEOUT_MS,
)

describe(
  'content gate: read budget (#461)',
  () => {
    function gateWithLimits(maxBlob: number, maxTotal: number): { status: number; err: string } {
      const res = spawnSync('node', ['tools/scripts/check-content.mjs', 'staged'], {
        cwd: dir,
        env: {
          ...process.env,
          CONTENT_GATE_MAX_BLOB_BYTES: String(maxBlob),
          CONTENT_GATE_MAX_TOTAL_BYTES: String(maxTotal),
        },
      })
      return { status: res.status ?? -1, err: res.stderr.toString() }
    }

    it('an ordinary change passes under small limits', () => {
      writeFile('src/a.ts', 'export const a = 1\n')
      writeFile('src/b.ts', 'export const b = 2\n')
      run('git', ['add', 'src'])
      expect(gateWithLimits(1000, 1000).status).toBe(0)
    })

    it('one blob over the per-blob limit is refused, naming its path', () => {
      writeFile('src/huge.txt', 'x'.repeat(2000))
      run('git', ['add', 'src'])
      const r = gateWithLimits(1000, 1_000_000)
      expect(r.status).toBe(2)
      expect(r.err).toMatch(/src\/huge\.txt/)
    })

    it('many blobs each under the per-blob limit but over the total are refused', () => {
      for (let i = 0; i < 10; i++) writeFile(`src/f${i}.txt`, `line ${i} `.repeat(50))
      run('git', ['add', 'src'])
      const r = gateWithLimits(1000, 3000)
      expect(r.status).toBe(2)
      expect(r.err).toMatch(/total/)
    })

    it('the same ten blobs pass when the total budget allows them', () => {
      for (let i = 0; i < 10; i++) writeFile(`src/f${i}.txt`, `line ${i} `.repeat(50))
      run('git', ['add', 'src'])
      expect(gateWithLimits(1000, 10_000).status).toBe(0)
    })
  },
  CLI_TIMEOUT_MS,
)
