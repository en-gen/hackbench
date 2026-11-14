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
/** Wrappers whose one argument is the timeout, reported by their own call wherever they sit. */
const WRAPPERS = new Set(['slow', 'loadTimeout'])
/** Chain members whose arguments are tables or conditions, never a timeout. */
const NOT_TIMEOUT_ARGS = new Set(['each', 'for', 'skipIf', 'runIf', 'extend', 'scoped'])
/** A reason is required: a bare marker would keep any value without anyone saying why. */
const MARKER = /\/\/\s*timeout-floor:\s*\S/

/** The test-registering root of `it.only.each(t)('n', fn)`, with the outermost chain member's name. */
function registrar(call: ts.CallExpression): { root: string; last: string } | undefined {
  // Only the call's own member counts: `it.each(t)(...)` is the registration, `it.each(t)` is the table.
  const last = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ''
  let e: ts.Expression = call.expression
  while (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) e = e.expression
  return ts.isIdentifier(e) && REGISTERS.has(e.text) ? { root: e.text, last } : undefined
}

/**
 * Timeout offences in one source as `line value` strings, in line order.
 * Values are numeric literals, arithmetic of them, or module-scope consts of those.
 */
export function timeoutFloorOffences(src: string): string[] {
  const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true)
  const lines = src.split(/\r?\n/)
  const consts = new Map<string, ts.Expression>()
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const d of st.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer)
  }

  const resolve = (e: ts.Expression, seen: string[] = []): number | undefined => {
    if (ts.isNumericLiteral(e)) return Number(e.text)
    if (ts.isParenthesizedExpression(e)) return resolve(e.expression, seen)
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
      const v = resolve(e.operand, seen)
      return v === undefined ? undefined : -v
    }
    if (ts.isIdentifier(e)) {
      const init = consts.get(e.text)
      return init && !seen.includes(e.text) ? resolve(init, [...seen, e.text]) : undefined
    }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      return WRAPPERS.has(e.expression.text) && e.arguments.length === 1
        ? resolve(e.arguments[0], seen)
        : undefined
    }
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

  const found = new Map<number, string>()
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line
  /** `value` is the timeout expression; `anchor` the call, whose own lines may carry the marker. */
  const check = (value: ts.Expression, anchor: ts.Node) => {
    const v = resolve(value)
    if (v !== undefined && v >= TIMEOUT_FLOOR) return
    const at = lineOf(value)
    const kept = [at, at - 1, lineOf(anchor), lineOf(anchor) - 1].some(
      l => l >= 0 && MARKER.test(lines[l] ?? ''),
    )
    if (!kept) found.set(at + 1, `${at + 1} ${v === undefined ? 'cannot read' : v}`)
  }
  const inSetConfig = (n: ts.Node) => {
    for (let p = n.parent; p; p = p.parent)
      if (ts.isCallExpression(p) && p.expression.getText(sf) === 'vi.setConfig') return true
    return false
  }
  const optionsTimeout = (o: ts.ObjectLiteralExpression, anchor: ts.Node) => {
    for (const p of o.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'timeout')
        check(p.initializer, anchor)
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'timeout') check(p.name, anchor)
    }
  }

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const fn = ts.isIdentifier(n.expression) ? n.expression.text : ''
      if (WRAPPERS.has(fn) && n.arguments.length === 1 && !inSetConfig(n)) check(n.arguments[0], n)
      const reg = registrar(n)
      if (reg && !NOT_TIMEOUT_ARGS.has(reg.last)) {
        n.arguments.forEach((a, i) => {
          if (ts.isObjectLiteralExpression(a)) return optionsTimeout(a, n)
          const isLast = i === n.arguments.length - 1
          const timeoutSlot = HOOKS.has(reg.root) ? 1 : 2
          if (!isLast || i < 1 || ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return
          if (ts.isStringLiteralLike(a) || ts.isTemplateExpression(a)) return
          // Already reported by its own call above.
          if (
            ts.isCallExpression(a) &&
            ts.isIdentifier(a.expression) &&
            WRAPPERS.has(a.expression.text)
          )
            return
          // An unresolved identifier before the timeout slot is a callback reference, not a value.
          if (ts.isIdentifier(a) && i < timeoutSlot && resolve(a) === undefined) return
          check(a, n)
        })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s)
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
