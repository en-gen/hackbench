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
/** The exact line, value included, both keys through loadTimeout (a bare number loses CI's 60 s floor). */
const BUDGET =
  /^vi\.setConfig\(\{ testTimeout: loadTimeout\(30_000\), hookTimeout: loadTimeout\(30_000\) \}\)$/m
/**
 * vitest reads the timeout when a top-level `it` or hook is registered, so the budget must precede
 * these. `describe` callbacks run at collection, so a budget after one would work; the rule is
 * deliberately stricter there, to keep one placement.
 */
const REGISTRATION = /^(?:describe|it|test|beforeAll|beforeEach|afterAll|afterEach)\b/m

/** True when the source value-imports a real process starter, or a helper that spawns. */
export function startsProcess(src: string): boolean {
  if (MOCKED.test(src)) return false
  if (HELPER.test(src) || CP_DYNAMIC.test(src)) return true
  return [...src.matchAll(CP_IMPORT)].some(([, spec]) => {
    const named = /\{([^}]*)\}/.exec(spec)
    // A default or namespace import cannot be narrowed to a starter, so it counts.
    if (!named || spec.replace(named[0], '').replace(',', '').trim()) return true
    return named[1].split(',').some(s => STARTERS.test(s.trim().split(/\s+as\s+/)[0]))
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

/** Every process-starting test file under `dir` (absolute paths). */
export function processStartingFiles(dir: string): string[] {
  return testFiles(dir).filter(f => startsProcess(fs.readFileSync(f, 'utf8')))
}

/** Process-starting test files under `dir` that lack the budget, as `dir`-relative paths. */
export function processTimeoutOffences(dir: string): string[] {
  return processStartingFiles(dir)
    .filter(f => !hasBudgetBeforeTests(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(dir, f).split(path.sep).join('/'))
    .sort()
}
