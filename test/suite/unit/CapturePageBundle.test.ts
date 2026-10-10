/**
 * The generated page's script must run standalone, in a real browser, with
 * nothing from the Node/TS module graph available - #421 step 2 round 3
 * found every one of the 143 rendered pages broken: `foreground`/`drawBg`
 * call the core resolver's imported bindings, and tsx's own esbuild
 * transform rewrote those calls to `(0,import_TileResolver.f)(...)`, which
 * `Function.prototype.toString` then copied verbatim into the page, where
 * `import_TileResolver` does not exist. `pageScript()` now bundles
 * capture_draw.ts with esbuild instead of copying function source, so
 * nothing bundler-internal can leak into the page.
 *
 * This spawns the REAL CLI (`npx tsx` is a per-test cold start, so this is
 * one test, not a suite) rather than calling page() in-process, because the
 * defect was specific to how `render_capture.ts` runs standalone - an
 * in-process vitest call goes through Vite's own transform instead and
 * would not have caught it.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { afterAll, describe, expect, it } from 'vitest'
import * as core from '../support/corpus.cjs'
import { captureFiles } from './fixtures/captureFixture'
import { slow } from '../support/loadTimeout'

const REPO_ROOT: string = core.REPO_ROOT
const TMP = mkdtempSync(join(tmpdir(), 'hb-page-bundle-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

function writeTree(dir: string, files: Record<string, Buffer>) {
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), bytes)
  }
}

describe('the generated page runs standalone under the real CLI', () => {
  // 52.3 s worst over 10 runs (npx tsx is not a dependency; npx resolution dominates when idle, about 2 s of 2.5 s, observed and not proven under load), two concurrent full unit runs, 32-core machine, 2026-10-09/10
  // prettier-ignore
  it('renders a map with npx tsx render_capture.ts and the page script draws in a fresh node:vm', slow(105_000), () => {
    const inDir = join(TMP, 'in')
    const outDir = join(TMP, 'out')
    writeTree(join(inDir, '105'), captureFiles(false, undefined, [8]))

    // spawnSync, not exec*Sync: the CLI's exit code follows the map's
    // verdict (`exitCode()`), which this test does not care about - only
    // that the process ran and the page it wrote is sound.
    const run = spawnSync('npx', ['tsx', 'tools/scripts/render_capture.ts', inDir, outDir], {
      cwd: REPO_ROOT,
      shell: true,
      encoding: 'utf8',
    })
    expect(run.error, run.stderr).toBeUndefined()

    const html = readFileSync(join(outDir, '105', 'viewer.html'), 'utf8')
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]
    // The defect's own shape: a bundler-internal reference that only
    // resolves inside that bundler's module scope.
    expect(script).not.toMatch(/import_TileResolver|__vite_ssr_import/)

    let imageData: { data: Uint8ClampedArray } | undefined
    const el = (): Record<string, unknown> => ({
      checked: true,
      value: '2',
      style: {},
      innerHTML: '',
      textContent: '',
      appendChild: (c: unknown) => c,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      addEventListener: () => {},
      getContext: () => ({
        createImageData: (w: number, h: number) => (imageData = { data: new Uint8ClampedArray(w * h * 4) }), // prettier-ignore
        putImageData: () => {},
      }),
    })
    const ctx = {
      atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
      document: {
        getElementById: () => el(),
        createElement: el,
        querySelectorAll: () => [],
      },
    }
    vm.createContext(ctx)
    // Must not throw: viewer() calls renderLevel() internally, which is
    // exactly where the bundler-internal reference broke.
    expect(() => vm.runInContext(script, ctx)).not.toThrow()
    expect(imageData).toBeDefined()
    // Non-empty output: at least one drawn (non-transparent) pixel.
    const opaque = Array.from(imageData!.data).some((b, i) => i % 4 === 3 && b !== 0)
    expect(opaque).toBe(true)
  })
})
