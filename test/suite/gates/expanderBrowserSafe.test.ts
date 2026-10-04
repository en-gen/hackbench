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
import * as ts from 'typescript'

const ROOT = path.resolve(__dirname, '../../..')
const NODE_ONLY = /^(node:)?crypto$/

const isLiteralSpec = (n: ts.Node): boolean =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)

/**
 * The module specifiers `text` pulls in at runtime, read from the AST: a
 * type-only import or export is erased, and a string or comment that merely
 * looks like an import is not one.
 */
function runtimeSpecifiers(file: string, text: string): string[] {
  const out: string[] = []
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause
      const nb = c?.namedBindings
      const onlyTypeNames =
        c !== undefined &&
        !c.name &&
        nb !== undefined &&
        ts.isNamedImports(nb) &&
        nb.elements.length > 0 &&
        nb.elements.every(e => e.isTypeOnly)
      if (!c?.isTypeOnly && !onlyTypeNames) out.push(n.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      // prettier-ignore
      const nb = n.exportClause
      const onlyTypeNames = nb !== undefined && ts.isNamedExports(nb) && nb.elements.length > 0 && nb.elements.every(e => e.isTypeOnly) // prettier-ignore
      if (!n.isTypeOnly && !onlyTypeNames) out.push(n.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      !n.isTypeOnly &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteral(n.moduleReference.expression)
    ) {
      // prettier-ignore
      out.push(n.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(n) &&
      n.arguments.length === 1 &&
      isLiteralSpec(n.arguments[0]!)
    ) {
      // prettier-ignore
      const callee = n.expression
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require')
      )
        // prettier-ignore
        out.push((n.arguments[0] as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** The file a relative specifier names, trying .ts, .tsx (a .js suffix stands for them), then a directory's index; fails if none reads. */
function resolveRelative(
  from: string,
  spec: string,
  read: (file: string) => string | null,
): string {
  const base = path.resolve(path.dirname(from), spec)
  const bare = base.replace(/\.jsx?$/, '') // `./b.js` names b.ts under TypeScript's resolution
  const tried = [base, bare + '.ts', bare + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')] // prettier-ignore
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
    for (const spec of runtimeSpecifiers(file, text)) {
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

  it.each([
    ['a require() in a string', 'const s = "require(\'crypto\')"'],
    ['a require() in a comment', "// require('crypto')\n/* import('crypto') */"],
    ['export { type T } from', "export { type T } from './t'"],
    ['import { type A, type B } from', "import { type A, type B } from 'crypto'"],
  ])('does not follow %s', (_what, source) => {
    expect(flagged(source, { '/t.ts': "import 'crypto'" })).toBe(0)
  })

  it('follows import { type A, b } and a default import beside type names', () => {
    expect(flagged("import { type A, b } from 'crypto'")).toBe(1)
    expect(flagged("import d, { type A } from 'crypto'")).toBe(1)
  })

  it('reads a .ts file as TS (angle-bracket assertion) and follows a template-literal specifier', () => {
    expect(flagged("const x = <unknown>require('crypto')")).toBe(1)
    expect(flagged('const m = await import(`crypto`)')).toBe(1)
    expect(flagged('const c = require(`node:crypto`)')).toBe(1)
  })

  it('follows import x = require() and a .js-suffixed relative specifier', () => {
    expect(flagged("import c = require('crypto')")).toBe(1)
    expect(flagged("import { b } from './b.js'", { '/b.ts': "import 'crypto'" })).toBe(1)
    expect(flagged("import type c = require('crypto')")).toBe(0)
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
