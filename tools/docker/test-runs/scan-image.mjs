// Scans a `docker save` tar (already extracted to <dir>) for ROM bytes in any layer (#978).
// usage: node scan-image.mjs <extracted-dir> [<reference-dir>]  (default C:/Projects/hackbench-tools/roms)
// Checks: (a) ROM-like file names, (b) SHA-256 of any file equal to a ROM file's, (c) any file
// >= 512 KiB whose first 64 KiB hash equals a ROM's first-64 KiB hash. Hashes are computed at
// run time; no ROM data is stored here. Exit 1 on any hit, so a plant makes it go red.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'

const [dir, romsArg] = process.argv.slice(2)
const romsDir = romsArg ?? 'C:/Projects/hackbench-tools/roms'
const NAME = /\.(sfc|smc|rom|ips|bps)$/i
const MIN = 524288
const sha = b => createHash('sha256').update(b).digest('hex')

const walk = d =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })

const romFull = new Map()
const romHead = new Map()
let romCount = 0
for (const f of walk(romsDir)) {
  const st = fs.statSync(f)
  if (st.size < 1024) continue
  const buf = fs.readFileSync(f)
  romFull.set(sha(buf), path.basename(f))
  romHead.set(sha(buf.subarray(0, 65536)), path.basename(f))
  romCount++
}

const hits = []
let files = 0
let layers = 0

function scanTar(buf, layer) {
  let off = 0
  let longName = null
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every(b => b === 0)) break
    let name = h.toString('utf8', 0, 100).replace(/\0.*$/, '')
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/, '')
    if (prefix) name = prefix + '/' + name
    const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8)
    const type = String.fromCharCode(h[156])
    const body = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/, '')
      continue
    }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      if (m) longName = m[1]
      continue
    }
    if (longName) {
      name = longName
      longName = null
    }
    if (type !== '0' && type !== '\0') continue
    files++
    if (NAME.test(name)) hits.push(`(a) name ${name} in ${layer}`)
    const full = sha(body)
    if (romFull.has(full))
      hits.push(`(b) full hash equals ${romFull.get(full)}: ${name} in ${layer}`)
    if (size >= MIN && romHead.has(sha(body.subarray(0, 65536))))
      hits.push(
        `(c) first-64KB equals ${romHead.get(sha(body.subarray(0, 65536)))}: ${name} in ${layer}`,
      )
  }
}

// Every blob is tried: a layer is a tar (maybe gzipped); manifests and configs are skipped by parse failure.
const blobDir = path.join(dir, 'blobs', 'sha256')
const cands = fs.existsSync(blobDir) ? walk(blobDir) : walk(dir).filter(f => /layer\.tar$/.test(f))
for (const f of cands) {
  let buf = fs.readFileSync(f)
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf)
  if (buf.toString('ascii', 257, 262) !== 'ustar') continue
  layers++
  scanTar(buf, path.basename(f).slice(0, 12))
}
console.log(
  `roms hashed: ${romCount}; layers scanned: ${layers}; files scanned: ${files}; hits: ${hits.length}`,
)
for (const h of hits) console.log(h)
process.exit(hits.length ? 1 : 0)
