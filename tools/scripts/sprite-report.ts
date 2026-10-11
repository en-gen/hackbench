/**
 * Grade every sprite against the Mesen level-load captures and commit a
 * browsable report to the private hackbench-validation repo (#828). Local
 * only; it never pushes. See docs/testing.md, "Sprite report".
 *
 *   npm run sprite:report
 *   npm run sprite:report -- --out <dir> --no-commit
 *   npm run sprite:report -- --sheet --map <hex> --out <dir>
 */
import { resolve } from 'path'
import { realIo, run } from './spriteReportRun'

process.exit(run(process.argv.slice(2), realIo(resolve(__dirname, '..', '..'))))
