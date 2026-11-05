/**
 * #1202: the documented `git worktree add` form must land under the MAIN
 * checkout's .worktrees from anywhere. A bare relative path run inside a linked
 * worktree nests the new one in it, and `git worktree remove` of the parent then
 * deletes the child, uncommitted work included, with no --force. Real git in a
 * scratch repo, Git 2.54 on Windows (Git Bash), one machine.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findBash } from '../support/gitBash'

const root = path.resolve(__dirname, '../../..')
const FORM =
  'git -C "$(git rev-parse --path-format=absolute --git-common-dir)/.." worktree add .worktrees/<task> -b feature/<task> origin/develop'
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

function scratch() {
  const main = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtcmd-')))
  dirs.push(main)
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      stdio: 'pipe',
      encoding: 'utf8',
    })
  git(main, 'init', '-q', '-b', 'develop')
  git(main, 'commit', '-q', '--allow-empty', '-m', 'root')
  git(main, 'update-ref', 'refs/remotes/origin/develop', 'HEAD') // stands in for the fetched remote
  fs.writeFileSync(path.join(main, '.gitignore'), '/.worktrees/\n')
  return { main, git }
}
const sh = (cwd: string, cmd: string) =>
  spawnSync(findBash(), ['-c', cmd], { cwd, encoding: 'utf8' })
const form = (task: string) => FORM.replaceAll('<task>', task)

describe('the documented worktree command (#1202)', () => {
  it('from the main checkout lands at <main>/.worktrees/<task>', () => {
    const { main } = scratch()
    const r = sh(main, form('a'))
    expect(r.status, r.stderr).toBe(0)
    expect(fs.existsSync(path.join(main, '.worktrees', 'a', '.git'))).toBe(true)
  })

  it('from a LINKED worktree still lands under the main checkout, not in the linked one', () => {
    const { main, git } = scratch()
    expect(sh(main, form('a')).status).toBe(0)
    const linked = path.join(main, '.worktrees', 'a')
    const r = sh(linked, form('b'))
    expect(r.status, r.stderr).toBe(0)
    expect(fs.existsSync(path.join(main, '.worktrees', 'b', '.git'))).toBe(true)
    expect(fs.existsSync(path.join(linked, '.worktrees'))).toBe(false)
    // Removing the first leaves the second alone.
    git(main, 'worktree', 'remove', linked)
    expect(fs.existsSync(path.join(main, '.worktrees', 'b', '.git'))).toBe(true)
  }, 30000)

  it('oracle: the bare relative form from a linked worktree DOES nest (the hazard this form avoids)', () => {
    const { main } = scratch()
    expect(sh(main, form('a')).status).toBe(0)
    const linked = path.join(main, '.worktrees', 'a')
    const r = sh(linked, 'git worktree add .worktrees/b -b feature/b origin/develop')
    expect(r.status, r.stderr).toBe(0)
    expect(fs.existsSync(path.join(linked, '.worktrees', 'b', '.git'))).toBe(true)
    expect(fs.existsSync(path.join(main, '.worktrees', 'b'))).toBe(false)
  }, 30000)

  it('the docs carry exactly this form, and name the main checkout, not "<repo>"', () => {
    for (const f of ['CLAUDE.md', '.claude/agents/implementer.md']) {
      const text = fs.readFileSync(path.join(root, f), 'utf8').replace(/\s+/g, ' ')
      expect(text, f).toContain(FORM)
      expect(text, f).not.toContain('<repo>/.worktrees')
    }
  })
})

// A bare `git worktree add` (no -C to the main checkout) nests when typed from a linked worktree.
// Whitespace is collapsed first so a wrapped or double-spaced form is still seen.
const bareForms = (text: string) => text.replace(/\s+/g, ' ').match(/git worktree add(?!\w)/g) ?? []

describe('tech-lead docs give the safe worktree form only (#1202)', () => {
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')

  it('tech-lead-reference.md carries the exact form and no bare relative one', () => {
    const text = read('docs/agents/tech-lead-reference.md')
    expect(text.replace(/\s+/g, ' ')).toContain(FORM)
    expect(bareForms(text)).toEqual([])
  })

  it('tech-lead.md has no bare relative form and names the main checkout, not "<repo>"', () => {
    const text = read('docs/agents/tech-lead.md')
    expect(bareForms(text)).toEqual([])
    expect(text).not.toContain('<repo>/.worktrees')
  })

  it('oracle: the scan goes red on a planted bare relative form, wrapped or double-spaced too', () => {
    expect(
      bareForms('run `git worktree add .worktrees/x -b feature/x origin/develop`'),
    ).toHaveLength(1)
    expect(bareForms('run `git\n  worktree add .worktrees/x`')).toHaveLength(1)
    expect(bareForms('run `git  worktree   add .worktrees/x`')).toHaveLength(1)
    expect(bareForms(FORM)).toEqual([])
  })
})
