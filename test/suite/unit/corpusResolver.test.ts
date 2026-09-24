/**
 * The corpus resolver, on a fake filesystem. CI has no corpus, so these are
 * the only cases that prove where ~45 gated suites look; a wrong answer
 * there turns them all into green skips.
 */

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { CORPUS, hasRoms, resolveRomDir, resolveToolsRoot, romsOnDisk } from '../support/corpus'

/** Only these paths exist, compared case- and separator-insensitively. */
const fs = (...paths: string[]) => {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const set = new Set(paths.map(norm))
  return (p: string) => set.has(norm(p))
}

const TOOLS = 'C:/Projects/hackbench-tools'
const ROMS = join(TOOLS, 'roms')
const corpusOnly = fs(TOOLS, ROMS)
const rom = (repoRoot: string, exists = corpusOnly) => resolveRomDir({}, repoRoot, exists)

describe('corpus resolution', () => {
  it('returns HACKBENCH_ROMS as given, even when it names nothing', () => {
    // Falling through to another corpus would hide a mistyped override.
    expect(resolveRomDir({ HACKBENCH_ROMS: '/nowhere' }, 'C:/Projects/hackbench', corpusOnly)).toBe(
      '/nowhere',
    )
  })

  it('takes roms/ under HACKBENCH_TOOLS', () => {
    expect(resolveRomDir({ HACKBENCH_TOOLS: '/opt/hb' }, 'C:/x', corpusOnly)).toBe(
      join('/opt/hb', 'roms'),
    )
  })

  it('resolves from a .worktrees/<repo>/<task> worktree', () => {
    expect(rom('C:/Projects/.worktrees/hackbench/some-task')).toBe(ROMS)
  })

  it('resolves from an EnterWorktree .claude/worktrees/<name> worktree', () => {
    expect(rom('C:/Projects/hackbench/.claude/worktrees/some-name')).toBe(ROMS)
  })

  it('walks to the filesystem root, not a fixed depth', () => {
    expect(rom('C:/Projects/a/b/c/d/e/f/hackbench')).toBe(ROMS)
  })

  it('is not shadowed by a nearer hackbench-tools that has no roms/', () => {
    const stray = fs('C:/Projects/.worktrees/hackbench-tools', TOOLS, ROMS)
    expect(rom('C:/Projects/.worktrees/hackbench/task', stray)).toBe(ROMS)
    // A worktree whose task happens to be named hackbench-tools.
    const named = 'C:/Projects/.worktrees/hackbench/hackbench-tools'
    expect(rom(named, fs(named, TOOLS, ROMS))).toBe(ROMS)
  })

  it('falls back to the legacy test/roms for a clone that has not moved', () => {
    const clone = 'C:/Projects/hackbench'
    expect(rom(clone, fs(join(clone, 'test', 'roms')))).toBe(join(clone, 'test', 'roms'))
  })

  it('returns a path that does not exist, rather than throwing, when nothing does', () => {
    expect(rom('C:/Projects/hackbench', () => false)).toBe(ROMS)
  })

  it('finds the tools root by its mesen/, and honours HACKBENCH_TOOLS', () => {
    const tools = fs('C:/Projects/.worktrees/hackbench-tools', join(TOOLS, 'mesen'))
    expect(resolveToolsRoot({}, 'C:/Projects/.worktrees/hackbench/t', tools)).toBe(join(TOOLS))
    expect(resolveToolsRoot({ HACKBENCH_TOOLS: '/opt/hb' }, 'C:/x', tools)).toBe('/opt/hb')
  })

  it('reports an empty list as absent, not as "all present"', () => {
    expect(hasRoms([])).toBe(false)
  })
})

describe.skipIf(romsOnDisk().length === 0)('corpus membership', () => {
  // Suites sweep the declared CORPUS, so a seventh cart on disk would be
  // invisible to all of them without this.
  it('every cart on this machine is named in CORPUS', () => {
    const unlisted = romsOnDisk().filter(f => !CORPUS.includes(f))
    expect(unlisted, 'add these to CORPUS in test/suite/support/corpus.cjs').toEqual([])
  })
})
