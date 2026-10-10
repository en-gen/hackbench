/**
 * No code the Theia shell can reach calls `loadOverworldAreas` or `loadOverworld` (#523): they
 * hardcode 7 areas and substitute vanilla-shaped values for a failed read. The Theia path uses
 * `deriveOverworldAreas`. The reference VS Code providers (src/providers) are left alone.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '../../..')
const LEGACY = /\bloadOverworld(Areas)?\b/

/** Source files under `dir` that mention a legacy loader, except `skip`. */
function legacyCallers(dir: string, skip: (file: string) => boolean): string[] {
  const hits: string[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'lib') walk(p)
      } else if (
        /\.(ts|tsx)$/.test(e.name) &&
        !skip(p) &&
        LEGACY.test(fs.readFileSync(p, 'utf8'))
      ) {
        hits.push(path.relative(root, p).split(path.sep).join('/'))
      }
    }
  }
  walk(dir)
  return hits
}

describe('legacy overworld loaders', () => {
  const definer = (f: string): boolean => f.endsWith(path.join('src', 'rom', 'OverworldLoader.ts'))

  // 6.6 s worst over 10 runs, two concurrent full unit runs plus other worktrees' tests, 32-core machine, 2026-10-10
  it('are not referenced from the core or the Theia extension', () => {
    expect(legacyCallers(path.join(root, 'src/rom'), definer)).toEqual([])
    expect(legacyCallers(path.join(root, 'src/project'), definer)).toEqual([])
    expect(legacyCallers(path.join(root, 'theia/extension/src'), definer)).toEqual([])
  }, 14_000)

  it('overworldCgram, which Theia calls, does not reference them either', () => {
    // The definer file is skipped above (it holds the legacy loaders themselves), so name the
    // one function in it the Theia path reaches.
    const src = fs.readFileSync(path.join(root, 'src/rom/OverworldLoader.ts'), 'utf8')
    const start = src.indexOf('export function overworldCgram')
    expect(start).toBeGreaterThan(0)
    const end = src.slice(start).search(/\r?\n\}\r?\n/)
    expect(end).toBeGreaterThan(0)
    const body = src.slice(start, start + end)
    expect(body.length).toBeGreaterThan(200)
    expect(body).not.toMatch(LEGACY)
  })

  it('the scan can fail: it finds the definer when not skipped', () => {
    expect(legacyCallers(path.join(root, 'src/rom'), () => false)).toContain(
      'src/rom/OverworldLoader.ts',
    )
  })
})
