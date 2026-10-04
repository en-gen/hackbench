// Reads changed paths on stdin, one per line; prints "true" when any path is
// outside the docs set (docs/** or any path ending in .md), else "false".
// An empty list prints "true": no information must never skip the heavy jobs.
// Used by the `changes` job in .github/workflows/ci.yml.
import { readFileSync } from 'node:fs'

const files = readFileSync(0, 'utf8')
  .split(/\r?\n/)
  .filter(f => f !== '')
const isDoc = f => f.startsWith('docs/') || f.endsWith('.md')
console.log(files.length === 0 || files.some(f => !isDoc(f)) ? 'true' : 'false')
