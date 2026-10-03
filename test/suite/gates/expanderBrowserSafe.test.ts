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

// `import|export ... from 'x'` (also `export * from`), bare `import 'x'`, and literal
// `import('x')` / `require('x')`. `import type` and `export type` are erased and skipped.
const FROM_FORM = /^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm
const SIDE_EFFECT_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm
const CALL_FORM = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** The file a relative specifier names, trying .ts, .tsx, then a directory's index; fails if none reads. */
function resolveRelative(
  from: string,
  spec: string,
  read: (file: string) => string | null,
): string {
  const base = path.resolve(path.dirname(from), spec)
  const tried = [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')] // prettier-ignore
  const hit = tried.find(f => /\.tsx?$/.test(f) && read(f) !== null)
  if (hit === undefined) throw new Error(`unresolved relative import '${spec}' from ${from}`)
  return hit
}

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
    if (text === null) throw new Error(`unreadable module ${file}`)
    const specs = [FROM_FORM, SIDE_EFFECT_IMPORT, CALL_FORM].flatMap(re => [...text.matchAll(re)].map(m => m[1]!)) // prettier-ignore
    for (const spec of specs) {
      const target = spec.startsWith('.') ? resolveRelative(file, spec, read) : spec
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
    const graph = reachable(entry, f =>
      fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null,
    )
    expect(graph.size, 'the walk found the module graph').toBeGreaterThan(5)
    expect(offenders(graph)).toEqual([])
    // Nor the interpreter itself, which imports ObjectExpander back: no cycle through it.
    expect([...graph.keys()].filter(m => /objectHandlers[\\/]interpret(Draw)?\.ts$/.test(m))).toEqual([]) // prettier-ignore
  })

  const fake = (files: Record<string, string>) => (f: string) =>
    files[f.replace(/^[A-Za-z]:/, '').replaceAll(path.sep, '/')] ?? null

  const flagged = (source: string, extra: Record<string, string> = {}) =>
    offenders(reachable('/a.ts', fake({ '/a.ts': source, ...extra }))).length

  it.each([
    ['import ... from', "import { h } from 'crypto'"],
    ['multi-line import', "import {\n  a,\n  b,\n} from 'node:crypto'"],
    ['bare import', "import 'crypto'"],
    ['export * from', "export * from 'crypto'"],
    ['export { x } from', "export { x } from 'node:crypto'"],
    ['dynamic import()', "const m = await import('crypto')"],
    ['require()', "const c = require('node:crypto')"],
  ])('goes red on a planted %s', (_form, source) => {
    expect(flagged(source)).toBe(1)
  })

  it('goes red through a chain, and follows a directory index and .tsx', () => {
    const chain = { '/b/index.ts': "import '../c'", '/c.tsx': "require('crypto')" }
    expect(flagged("import { b } from './b'", chain)).toBe(1)
  })

  it('ignores import type and export type', () => {
    const t = { '/t.ts': "import 'crypto'" }
    expect(flagged("import type { t } from './t'\nexport type { u } from './t'", t)).toBe(0)
  })

  it('fails the walk, rather than skipping, on an unresolvable relative import', () => {
    expect(() => reachable('/a.ts', fake({ '/a.ts': "import { x } from './missing'" }))).toThrow(
      /unresolved relative import '\.\/missing'/,
    )
  })
})
