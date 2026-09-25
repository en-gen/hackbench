/**
 * Render Mesen per-map captures into self-contained HTML pages, one per map
 * plus an index, and run the checks on each.
 *
 *   npm run capture:render -- <captures-dir> <out-dir>
 *
 * <captures-dir> holds one folder or one zip per map (001/ or 001.zip). Both
 * arguments are required, and relative ones are taken from where npm was run
 * (INIT_CWD), not the repo root npm switches to. The pages embed ROM-derived
 * bytes, so where they go is the caller's choice, never a default; the
 * output may not overlap the captures or lie inside the repo. Exit codes are
 * exitCode's in capture_render.ts, where the logic lives so tests reach it.
 */
import { existsSync } from 'fs'
import { cliFolders, runCapture } from './capture_render'

const folders = cliFolders(process.argv.slice(2))
if (!folders || !existsSync(folders[0])) {
  console.error('usage: render_capture.ts <captures-dir> <out-dir>')
  if (folders) console.error(`not found: ${folders[0]}`)
  process.exit(2)
}
process.exit(runCapture(...folders))
