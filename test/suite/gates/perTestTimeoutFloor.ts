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
/** Chain members whose arguments are tables or conditions, never a timeout. */
const NOT_TIMEOUT_ARGS = new Set(['each', 'for', 'skipIf', 'runIf', 'extend', 'scoped'])
/** A reason is required: a bare marker would keep any value without anyone saying why. */
const MARKER = /^\/\/\s*timeout-floor:\s*\S/
const TIMEOUT_KEY = new Set(['timeout'])
const CONFIG_KEYS = new Set(['testTimeout', 'hookTimeout'])

/** The test-registering root of `it.only.each(t)('n', fn)`, with the outermost chain member's name. */
function registrar(call: ts.CallExpression): { root: string; last: string } | undefined {
  // Only the call's own member counts: `it.each(t)(...)` is the registration, `it.each(t)` is the table.
  const last = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ''
  let e: ts.Expression = call.expression
  while (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) e = e.expression
  return ts.isIdentifier(e) && REGISTERS.has(e.text) ? { root: e.text, last } : undefined
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
  /** A marker comment on the run of comment lines directly above `startPos`; a blank line ends the run. */
  const markerAbove = (fullStart: number, startPos: number): boolean => {
    let want = lineOf(startPos)
    for (const r of [...(ts.getLeadingCommentRanges(text, fullStart) ?? [])].reverse()) {
      if (lineOf(r.end) < want - 1) return false
      if (isMarker(r)) return true
      want = lineOf(r.pos)
    }
    return false
  }
  /** A marker comment trailing `end` on the same line. */
  const markerAfter = (end: number): boolean =>
    (ts.getTrailingCommentRanges(text, end) ?? []).some(isMarker)
  const statementOf = (n: ts.Node): ts.Node => {
    let p: ts.Node = n
    while (p.parent && !ts.isExpressionStatement(p) && !ts.isVariableStatement(p)) p = p.parent
    return ts.isSourceFile(p) ? n : p
  }
  /** Each marker keeps only its own statement or value, never a neighbor's. */
  const kept = (value: ts.Node): boolean => {
    const st = statementOf(value)
    return (
      markerAbove(value.getFullStart(), value.getStart(sf)) ||
      markerAfter(value.getEnd()) ||
      markerAbove(st.getFullStart(), st.getStart(sf)) ||
      markerAfter(st.getEnd())
    )
  }

  const found: { pos: number; text: string }[] = []
  const check = (value: ts.Expression) => {
    const v = resolve(value)
    if ((v !== undefined && v >= TIMEOUT_FLOOR) || kept(value)) return
    const pos = value.getStart(sf)
    found.push({ pos, text: `${lineOf(pos) + 1} ${v === undefined ? 'cannot read' : v}` })
  }

  /** An options expression: an object literal, a module const holding one, or a wrapper call. */
  const readOptions = (e: ts.Expression, keys: Set<string>): void => {
    if (ts.isParenthesizedExpression(e)) return readOptions(e.expression, keys)
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p) && keys.has(p.name.getText(sf))) check(p.initializer)
        else if (ts.isShorthandPropertyAssignment(p) && keys.has(p.name.text)) check(p.name)
        else if (ts.isSpreadAssignment(p)) readOptions(p.expression, keys)
      }
      return
    }
    if (isWrapperCall(e)) return e.arguments.length === 1 ? check(e.arguments[0]) : check(e)
    const init = ts.isIdentifier(e) ? constInit(e) : undefined
    if (init && (ts.isObjectLiteralExpression(init) || isWrapperCall(init)))
      return readOptions(init, keys)
    check(e)
  }

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (n.expression.getText(sf) === 'vi.setConfig' && n.arguments[0])
        readOptions(n.arguments[0], CONFIG_KEYS)
      const reg = registrar(n)
      if (reg && !NOT_TIMEOUT_ARGS.has(reg.last)) {
        const args = n.arguments
        const timeoutSlot = HOOKS.has(reg.root) ? 1 : 2
        const lastArg = args[args.length - 1]
        const bareLast = !ts.isFunctionLike(lastArg) && !ts.isIdentifier(lastArg)
        args.forEach((a, i) => {
          if (i < 1 || ts.isFunctionLike(a) || ts.isStringLiteralLike(a)) return
          if (ts.isTemplateExpression(a)) return
          if (ts.isObjectLiteralExpression(a) || ts.isSpreadElement(a) || isWrapperCall(a))
            return readOptions(ts.isSpreadElement(a) ? a.expression : a, TIMEOUT_KEY)
          const isLast = i === args.length - 1
          // A lone identifier before the timeout slot is a callback.
          if (ts.isIdentifier(a) && isLast && i < timeoutSlot) return
          if (ts.isIdentifier(a) && !isLast) {
            // `it('x', handler, 5000)`: the identifier is the callback, the number its timeout.
            if (bareLast && i === args.length - 2) return
            return readOptions(a, TIMEOUT_KEY)
          }
          check(a)
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
  return processStartingFiles(dir)
    .flatMap(f =>
      timeoutFloorOffences(fs.readFileSync(f, 'utf8')).map(
        o => `${path.relative(dir, f).split(path.sep).join('/')}:${o}`,
      ),
    )
    .sort()
}
