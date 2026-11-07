/**
 * #1202: worktrees and session state live INSIDE the repo, in .worktrees/ and
 * .overwatch/. Each of the six tools below must skip them. A copy of the repo
 * in .worktrees/<task> holds its own tests, sources and configs; any tool that
 * picked it up would lint, format, type-check or run every file twice, or let
 * a worktree's files into a commit.
 *
 * One assertion per tool. The plants (__plant-<pid>) are ignored by git, ESLint
 * and Prettier, so a concurrent `npm run lint` or `format:check` skips them by
 * rule, not by the timing of this test. Evidence scope: vitest 5, ESLint 10,
 * Prettier 3.9, tsc 6, git 2.54, one machine; GitNexus 1.6.9 is read through
 * the `ignore` rules it loads, not by running its indexer (see the last case).
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'
import { cleanupNested, holdsSessionsFile } from '../support/nestedFolders'
import { loadTimeout } from '../support/loadTimeout'

vi.setConfig({ testTimeout: loadTimeout(30_000), hookTimeout: loadTimeout(30_000) })

const repoRoot = path.resolve(__dirname, '../../..')
const FOLDERS = ['.worktrees', '.overwatch'] as const
const planted = FOLDERS.map(f => `${f}/__plant-${process.pid}`)
const bin = (rel: string) => path.join(repoRoot, 'node_modules', rel)

const PLANT_TEST = 'test/suite/unit/plant.test.ts'
const PLANT_TS = 'src/plant.ts'
const PLANT_MJS = 'tools/plant.mjs'

const existed = FOLDERS.map(f => fs.existsSync(path.join(repoRoot, f)))

beforeAll(() => {
  for (const dir of planted) {
    for (const rel of [PLANT_TEST, PLANT_TS, PLANT_MJS]) {
      const file = path.join(repoRoot, dir, rel)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // Unformatted, unused and lint-violating on purpose: Prettier and ESLint would
      // report it if they ever saw it. The test file is a real passing test.
      fs.writeFileSync(
        file,
        rel === PLANT_TEST
          ? "import {it} from 'vitest'\nit('plant',()=>{})\n"
          : 'var   unused  =  1;;\n',
      )
    }
  }
})
afterAll(() => {
  cleanupNested(repoRoot, FOLDERS, existed, planted)
})

const run = (cmd: string, args: string[]) =>
  spawnSync(process.execPath, [cmd, ...args], { cwd: repoRoot, encoding: 'utf8' })
const mentions = (text: string) => planted.filter(p => text.replace(/\\/g, '/').includes(p))

describe('nested .worktrees/ and .overwatch/ stay out of every tool (#1202)', () => {
  it('the plants never create sessions.json, which would make a stray .overwatch the live state', () => {
    for (const dir of planted) expect(holdsSessionsFile(path.join(repoRoot, dir)), dir).toBe(false)
  })

  it('vitest does not collect a test file planted in either folder', () => {
    const r = run(bin('vitest/vitest.mjs'), ['list', '--filesOnly'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('test/suite/unit/') // the listing is not empty
    expect(mentions(r.stdout)).toEqual([])
  }, 60000)

  it('ESLint ignores a file planted in either folder', async () => {
    const { ESLint } = await import('eslint')
    const eslint = new ESLint({ cwd: repoRoot })
    for (const dir of planted) {
      for (const rel of [PLANT_TS, PLANT_MJS]) {
        expect(await eslint.isPathIgnored(path.join(repoRoot, dir, rel)), `${dir}/${rel}`).toBe(
          true,
        )
      }
    }
    // And the lint script's own roots never start at the repo root, which would walk both.
    const lint = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts
      .lint
    expect(lint).not.toMatch(/eslint\s+(\.|\*\*)(\s|$)/)
  }, 60000)

  it('Prettier skips a badly formatted file planted in either folder', () => {
    // The format:check glob (`**/*.{ts,...}`) narrowed to the plants: unformatted files
    // are listed when seen, nothing is listed when they are ignored.
    const globs = FOLDERS.map(f => `${f}/**/*.{ts,mjs}`)
    const r = run(bin('prettier/bin/prettier.cjs'), ['--list-different', ...globs])
    expect(r.stdout.trim()).toBe('')
    expect(r.status, r.stderr).toBe(0)
  }, 60000)

  for (const config of ['tsconfig.json', 'tsconfig.test.json']) {
    it(`tsc (${config}) lists no planted file`, () => {
      const r = run(bin('typescript/bin/tsc'), ['-p', config, '--listFilesOnly'])
      expect(r.stdout).toContain('/src/') // the file list is not empty
      expect(mentions(r.stdout)).toEqual([])
    }, 60000)
  }

  it('the content gate cannot see a planted file: git ignores it, will not add it, lists no untracked copy', () => {
    for (const dir of planted) {
      const file = `${dir}/${PLANT_MJS}`
      // Exit 0 = ignored.
      expect(spawnSync('git', ['check-ignore', '-q', file], { cwd: repoRoot }).status, file).toBe(0)
      // --dry-run: a plain `git add` that would stage it prints `add '<path>'`; nothing is staged here.
      const add = spawnSync('git', ['add', '--dry-run', '--', dir], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      expect(add.status, add.stdout).not.toBe(0)
      expect(add.stdout).not.toContain('add ')
    }
    // check-content's staged and range modes read the index and commits, so an unstaged
    // ignored file never reaches them; the one scan of the working tree
    // (rom-window-probe's untracked mode) uses exactly this listing.
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(mentions(untracked)).toEqual([])
  }, 60000)

  it('GitNexus: the rules it loads (.gitignore, .gitnexusignore) ignore both folders', () => {
    // GitNexus 1.6.9 (dist/config/ignore-service.js) adds .gitignore then .gitnexusignore to an
    // `ignore` instance, tests a file as `rel` and a directory as `rel/`. The walker also globs with
    // `dot: false`, which skips dot folders on its own; this asserts the rules, the part a config
    // edit can break. The indexer itself is not run here.
    const ignore = createRequire(import.meta.url)('ignore') as () => {
      add(s: string): unknown
      ignores(p: string): boolean
    }
    const ig = ignore()
    for (const name of ['.gitignore', '.gitnexusignore']) {
      const file = path.join(repoRoot, name)
      if (fs.existsSync(file)) ig.add(fs.readFileSync(file, 'utf8'))
    }
    for (const dir of planted) {
      expect(ig.ignores(`${dir}/`), `${dir}/ (directory)`).toBe(true)
      expect(ig.ignores(`${dir}/${PLANT_TS}`), `${dir}/${PLANT_TS}`).toBe(true)
    }
  })
})
