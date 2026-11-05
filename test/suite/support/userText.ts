/** Finds the literal text a user can see in a source tree, for the wording gates (comments and identifiers are exempt). */
import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

/** Every piece of literal text in `source` that could be shown to a user. */
export function userText(source: string, fileName = 'x.tsx'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
      found.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

export interface Tree {
  /** Scanned file count per root, so one missing root cannot hide. */
  counts: Record<string, number>
  literals: { file: string; text: string }[]
}

/** Parse every .ts/.tsx under `roots` (relative to `base`) once. */
export function scan(base: string, roots: string[]): Tree {
  const counts: Record<string, number> = {}
  const literals: Tree['literals'] = []
  for (const r of roots) {
    const files = sourceFiles(path.join(base, r))
    counts[r] = files.length
    for (const f of files) {
      for (const text of userText(fs.readFileSync(f, 'utf8'), f)) {
        literals.push({ file: path.relative(base, f).split(path.sep).join('/'), text })
      }
    }
  }
  return { counts, literals }
}
