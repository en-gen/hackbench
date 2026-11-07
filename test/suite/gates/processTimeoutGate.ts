import * as fs from 'fs'
import * as path from 'path'

const CP = String.raw`['"](?:node:)?child_process['"]`
const STARTERS = /^(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/
/** `import ... from 'child_process'`; `import type` is excluded by the lookahead. */
const CP_IMPORT = new RegExp(String.raw`^import\s+(?!type\b)([^'"]*?)\s+from\s+${CP}`, 'gms')
/** `require('child_process')` or `import('child_process')`, statement-leading so string-literal plants do not match. */
const CP_DYNAMIC = new RegExp(
  String.raw`^[ \t]*(?:[^\n'"]*=\s*)?(?:await\s+)?(?:require|import)\(\s*${CP}`,
  'm',
)
const HELPER = /^import\s+(?!type\b)[^'"]*?from\s+['"][^'"]*\/(?:isolatedGit|gitBash)['"]/ms
const MOCKED = new RegExp(String.raw`^vi\.mock\(\s*${CP}`, 'm')
/** Both keys, each through loadTimeout (a bare number loses CI's 60 s floor). */
const BUDGET =
  /^vi\.setConfig\(\s*\{(?=[^}]*\btestTimeout:\s*loadTimeout\()(?=[^}]*\bhookTimeout:\s*loadTimeout\()[^}]*\}\s*\)/m
/** vitest reads the timeout when a test or hook is registered, so the budget must precede these. */
const REGISTRATION = /^(?:describe|it|test|beforeAll|beforeEach|afterAll|afterEach)\b/m

/** True when the source value-imports a real process starter, or a helper that spawns. */
export function startsProcess(src: string): boolean {
  if (MOCKED.test(src)) return false
  if (HELPER.test(src) || CP_DYNAMIC.test(src)) return true
  return [...src.matchAll(CP_IMPORT)].some(([, spec]) => {
    const named = /\{([^}]*)\}/.exec(spec)?.[1]
    if (
      named === undefined ||
      spec
        .replace(/\{[^}]*\}/, '')
        .replace(/,/g, '')
        .trim()
    )
      return true
    return named.split(',').some(s => {
      const n = s.trim()
      return n && !n.startsWith('type ') && STARTERS.test(n.split(/\s+as\s+/)[0])
    })
  })
}

/** True when a module-scope setConfig budget sits before the first test or hook registration. */
export function hasBudgetBeforeTests(src: string): boolean {
  const at = BUDGET.exec(src)?.index
  return at !== undefined && at < (REGISTRATION.exec(src)?.index ?? Infinity)
}

/** Every `*.test.ts` under `dir`, by walking the directory (an untracked file must count). */
export function testFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : testFiles(full)
    return /\.test\.ts$/.test(e.name) && !/\.(timing|nightly)\.test\.ts$/.test(e.name) ? [full] : []
  })
}

/** Process-starting test files under `dir` that lack the budget, as `dir`-relative paths. */
export function processTimeoutOffences(dir: string): string[] {
  return testFiles(dir)
    .filter(f => {
      const src = fs.readFileSync(f, 'utf8')
      return startsProcess(src) && !hasBudgetBeforeTests(src)
    })
    .map(f => path.relative(dir, f).split(path.sep).join('/'))
    .sort()
}
