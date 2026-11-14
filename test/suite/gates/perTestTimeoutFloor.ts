import * as fs from 'fs'
import * as path from 'path'
import ts from 'typescript'
import { processStartingFiles } from './processTimeoutGate'

/** The file budget (#1209). A per-test value replaces it, so one below this undercuts it (#1333). */
export const TIMEOUT_FLOOR = 30_000

const REGISTERS = new Set([
  'it',
  'test',
  'describe',
  'beforeAll',
  'beforeEach',
  'afterAll',
  'afterEach',
])
const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach'])
/** Wrappers whose one argument is the timeout. Read only where they are a test's or config's timeout. */
const WRAPPERS = new Set(['slow', 'loadTimeout'])
/** A reason is required: a bare marker would keep any value without anyone saying why. */
const MARKER = /^\/\/\s*timeout-floor:\s*\S/
const TIMEOUT_KEY = new Set(['timeout'])
const CONFIG_KEYS = new Set(['testTimeout', 'hookTimeout'])

/** The test-registering root name of `it.only.each(t)('n', fn)`, or undefined. `it.each(t)` has only table arguments, never read. */
function registrar(call: ts.CallExpression): string | undefined {
  let e: ts.Expression = call.expression
  while (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) e = e.expression
  return ts.isIdentifier(e) && REGISTERS.has(e.text) ? e.text : undefined
}

const isWrapperCall = (e: ts.Node): e is ts.CallExpression =>
  ts.isCallExpression(e) && ts.isIdentifier(e.expression) && WRAPPERS.has(e.expression.text)

/** A one-file program, so the checker can tell a module const from a shadowing name or a let. */
function bind(src: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const base = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true)
  const host = ts.createCompilerHost({})
  host.getSourceFile = f => (f === 'x.ts' ? base : undefined)
  host.fileExists = f => f === 'x.ts'
  host.readFile = f => (f === 'x.ts' ? src : undefined)
  const program = ts.createProgram(['x.ts'], { noLib: true, noResolve: true, types: [] }, host)
  return { sf: program.getSourceFile('x.ts') ?? base, checker: program.getTypeChecker() }
}

/**
 * Timeout offences in one source as `line value` strings, in source order.
 * Values are numeric literals, arithmetic of them, or module-scope consts of those.
 */
export function timeoutFloorOffences(src: string): string[] {
  const { sf, checker } = bind(src)
  const text = sf.text
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line

  /** The initializer of the module-scope `const` this identifier names; a let, parameter or shadow gives none. */
  const constInit = (id: ts.Identifier): ts.Expression | undefined => {
    const sym =
      ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
        ? checker.getShorthandAssignmentValueSymbol(id.parent)
        : checker.getSymbolAtLocation(id)
    const d = sym?.valueDeclaration
    if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return undefined
    const list = d.parent
    const atModule = ts.isVariableDeclarationList(list) && ts.isSourceFile(list.parent.parent)
    return atModule && list.flags & ts.NodeFlags.Const ? d.initializer : undefined
  }

  const resolve = (e: ts.Expression, seen: ts.Node[] = []): number | undefined => {
    if (ts.isNumericLiteral(e)) return Number(e.text)
    if (ts.isParenthesizedExpression(e)) return resolve(e.expression, seen)
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
      const v = resolve(e.operand, seen)
      return v === undefined ? undefined : -v
    }
    if (ts.isIdentifier(e)) {
      const init = constInit(e)
      return init && !seen.includes(init) ? resolve(init, [...seen, init]) : undefined
    }
    if (isWrapperCall(e))
      return e.arguments.length === 1 ? resolve(e.arguments[0], seen) : undefined
    if (ts.isBinaryExpression(e)) {
      const a = resolve(e.left, seen)
      const b = resolve(e.right, seen)
      if (a === undefined || b === undefined) return undefined
      switch (e.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return a + b
        case ts.SyntaxKind.MinusToken:
          return a - b
        case ts.SyntaxKind.AsteriskToken:
          return a * b
        case ts.SyntaxKind.SlashToken:
          return a / b
        case ts.SyntaxKind.AsteriskAsteriskToken:
          return a ** b
      }
    }
    return undefined
  }

  const isMarker = (r: ts.CommentRange) =>
    r.kind === ts.SyntaxKind.SingleLineCommentTrivia && MARKER.test(text.slice(r.pos, r.end))
  /**
   * A marker keeps the registrar or setConfig statement it sits on, and nothing else: a comment on the
   * run of lines directly above the statement (a blank line ends the run), or trailing its last line.
   * A call that is not itself a statement (an arrow-body `it`, a nested one) cannot be kept; Prettier
   * moves comments inside a wrapped call, so a value-level marker would not survive formatting anyway.
   */
  const kept = (call: ts.CallExpression): boolean => {
    const st = call.parent
    if (!ts.isExpressionStatement(st) || st.expression !== call) return false
    let want = lineOf(st.getStart(sf))
    for (const r of [...(ts.getLeadingCommentRanges(text, st.getFullStart()) ?? [])].reverse()) {
      if (lineOf(r.end) < want - 1) break
      if (isMarker(r)) return true
      want = lineOf(r.pos)
    }
    return (ts.getTrailingCommentRanges(text, st.getEnd()) ?? []).some(isMarker)
  }

  /** What an expression is read for: the call that owns the timeout, and where an offence is reported. */
  interface Site {
    call: ts.CallExpression
    at: ts.Node
  }
  const found: { pos: number; text: string }[] = []
  const report = (site: Site, v: number | undefined) => {
    if (kept(site.call)) return
    const pos = site.at.getStart(sf)
    found.push({ pos, text: `${lineOf(pos) + 1} ${v === undefined ? 'cannot read' : v}` })
  }
  const check = (value: ts.Expression, site: Site) => {
    const v = resolve(value)
    if (v === undefined || v < TIMEOUT_FLOOR) report(site, v)
  }

  /**
   * An options expression: an object literal, a module const holding one, or a wrapper call. Through a
   * const the offence is reported at the use site (`at`), once per use.
   */
  const readOptions = (e: ts.Expression, keys: Set<string>, site: Site): void => {
    if (ts.isParenthesizedExpression(e)) return readOptions(e.expression, keys, site)
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) readOptions(p.expression, keys, site)
        else if (p.name && ts.isComputedPropertyName(p.name)) report(site, undefined)
        else if (ts.isPropertyAssignment(p) && keys.has(p.name.getText(sf)))
          check(p.initializer, site)
        else if (ts.isShorthandPropertyAssignment(p) && keys.has(p.name.text)) check(p.name, site)
      }
      return
    }
    if (isWrapperCall(e)) {
      if (e.arguments.length === 1) check(e.arguments[0], site)
      else report(site, undefined)
      return
    }
    const init = ts.isIdentifier(e) ? constInit(e) : undefined
    if (init && (ts.isObjectLiteralExpression(init) || isWrapperCall(init)))
      return readOptions(init, keys, site)
    report(site, undefined)
  }

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (n.expression.getText(sf) === 'vi.setConfig' && n.arguments[0])
        readOptions(n.arguments[0], CONFIG_KEYS, { call: n, at: n.arguments[0] })
      const reg = registrar(n)
      if (reg) {
        const args = n.arguments
        const timeoutSlot = HOOKS.has(reg) ? 1 : 2
        const lastArg = args[args.length - 1]
        const bareLast = !ts.isFunctionLike(lastArg) && !ts.isIdentifier(lastArg)
        args.forEach((a, i) => {
          if (i < 1 || ts.isFunctionLike(a) || ts.isStringLiteralLike(a)) return
          if (ts.isTemplateExpression(a)) return
          const site: Site = { call: n, at: a }
          if (ts.isObjectLiteralExpression(a) || ts.isSpreadElement(a) || isWrapperCall(a))
            return readOptions(ts.isSpreadElement(a) ? a.expression : a, TIMEOUT_KEY, site)
          const isLast = i === args.length - 1
          // A lone identifier before the timeout slot is a callback.
          if (ts.isIdentifier(a) && isLast && i < timeoutSlot) return
          if (ts.isIdentifier(a) && !isLast) {
            // `it('x', handler, 5000)`: the identifier is the callback, the number its timeout.
            if (bareLast && i === args.length - 2) return
            return readOptions(a, TIMEOUT_KEY, site)
          }
          check(a, site)
        })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found.sort((a, b) => a.pos - b.pos).map(f => f.text)
}

/** `file:line value` for every under-floor timeout in the process-starting files of `dir`. */
export function perTestTimeoutOffences(dir: string): string[] {
  // File order first, then source order within a file: a string sort would put line 10 before 9.
  return processStartingFiles(dir)
    .map(f => path.relative(dir, f).split(path.sep).join('/'))
    .sort()
    .flatMap(rel =>
      timeoutFloorOffences(fs.readFileSync(path.join(dir, rel), 'utf8')).map(o => `${rel}:${o}`),
    )
}
