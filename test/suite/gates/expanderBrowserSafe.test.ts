/**
 * The reference extension's webview bundles import ObjectExpander, so nothing
 * it imports at runtime may reach Node's `crypto` (Fingerprint.ts hashes with
 * it). `npm run compile` failed on exactly that once the interpreter was
 * reachable from standardHandlers (#342). Static walk over runtime imports;
 * `import type` is erased and does not count.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const NODE_ONLY = /^(node:)?crypto$/

const RUNTIME_IMPORT = /^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm
const SIDE_EFFECT_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm

/** Every runtime-reachable module of `entry`, with the chain that reached it. */
export function reachable(
  entry: string,
  read: (file: string) => string | null,
): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    const text = read(file)
    if (text === null) continue
    const specs = [...text.matchAll(RUNTIME_IMPORT), ...text.matchAll(SIDE_EFFECT_IMPORT)].map(m => m[1]!) // prettier-ignore
    for (const spec of specs) {
      const target = spec.startsWith('.') ? path.resolve(path.dirname(file), spec) + '.ts' : spec
      if (seen.has(target)) continue
      seen.set(target, [...seen.get(file)!, target])
      if (spec.startsWith('.')) queue.push(target)
    }
  }
  return seen
}

const offenders = (graph: Map<string, string[]>): string[] =>
  [...graph]
    .filter(([m]) => NODE_ONLY.test(m) || /[\\/]Fingerprint\.ts$/.test(m))
    .map(([, chain]) => chain.map(c => path.relative(ROOT, c) || c).join(' -> '))

describe('ObjectExpander stays browser-bundle safe (#342)', () => {
  it('reaches no Node-only module at runtime', () => {
    const entry = path.join(ROOT, 'src/rom/ObjectExpander.ts')
    const graph = reachable(entry, f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null))
    expect(graph.size, 'the walk found the module graph').toBeGreaterThan(5)
    expect(offenders(graph)).toEqual([])
    // Nor the interpreter itself, which imports ObjectExpander back: no cycle through it.
    expect([...graph.keys()].filter(m => /objectHandlers[\\/]interpret(Draw)?\.ts$/.test(m))).toEqual([]) // prettier-ignore
  })

  it('goes red on a planted runtime import chain, and ignores type-only ones', () => {
    const files: Record<string, string> = {
      '/a.ts': "import { b } from './b'\nimport type { c } from './c'",
      '/b.ts': "import { createHash } from 'crypto'",
      '/c.ts': "import { x } from 'node:crypto'",
    }
    const graph = reachable(
      '/a.ts',
      f => files[f.replace(/^[A-Za-z]:/, '').replaceAll(path.sep, '/')] ?? null,
    )
    const bad = offenders(graph)
    expect(bad).toHaveLength(1)
    expect(bad[0]).toMatch(/b\.ts -> crypto$/)
  })
})
