/**
 * #825 SPIKE. Builds, for the measured vanilla maps, today's RGBA reply and the indexed encoding of the
 * same screens; asserts the indexed arm decodes BYTE-IDENTICAL to today's planes (the oracle), plants a
 * wrong-palette-row defect to show the oracle goes red, prints wire bytes (raw / base64-in-JSON / gzip),
 * and writes browser fixtures (ROM-derived: to an --out dir OUTSIDE the repo, never committed).
 * Run: esbuild --bundle --platform=node gen.ts | node - <romPath> <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { RomFile } from '../../../src/rom/RomFile'
import { L1ModelCache, screenResult } from '../../../theia/extension/src/node/map-screen'
import { MAP_PLANE_KEYS } from '../../../theia/extension/src/common/project-protocol'
import { decodePlane, encodeScreen, newTileSet, type IPlane } from './encode'

const [romFile, outDir] = [process.argv[2]!, resolve(process.argv[3]!)]
// Output is ROM-derived: refuse any directory inside the repository checkout.
const top = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
if (!relative(top, outDir).startsWith('..'))
  throw new Error(`outDir ${outDir} is inside the repo ${top}`)
const arg = process.argv[4] ?? '10a,105,101'
const MAPS = arg === 'scan' ? [] : arg.split(',').map(h => parseInt(h, 16))
const MAX_SCREENS = 8 // fixtures and wire table cover the first 8 screens of each map
const bytes = new Uint8Array(RomFile.load(romFile).buffer)
const cache = new L1ModelCache()
const b64 = (a: Uint8Array | Uint8ClampedArray) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64') // prettier-ignore
const gz = (s: string | Uint8Array) => gzipSync(s, { level: 6 }).length
const br = (s: string | Uint8Array) => brotliCompressSync(s).length

/** CGRAM as BGR555 (what the wire would carry) and as RGBA (what the decoders index); the round trip must be exact. */
function palettes(colors: number[][], n: number) {
  const rgba = new Uint8Array(n * 4)
  const c555 = new Uint8Array(n * 2)
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = colors[i] ?? [0, 0, 0, 255]
    if (a === 0) continue // index 0 of a row is transparent and never drawn
    const w = (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10)
    c555.set([w & 255, w >> 8], i * 2)
    const up = (c: number) => (c << 3) | (c >> 2)
    const back = [up(w & 31), up((w >> 5) & 31), up((w >> 10) & 31), 255]
    if (back.some((v, k) => v !== [r, g, b, a][k]))
      throw new Error(`color ${i} is not BGR555-representable`)
    rgba.set(back, i * 4)
  }
  return { rgba, c555 }
}

if (arg === 'scan') {
  // Which plane kinds each map draws over its first MAX_SCREENS screens: picks maps for the oracle's coverage.
  const flags = { green: false, yellow: false, blue: false, red: false }
  for (let m = 0; m < 0x200; m++) {
    const b = cache.get(bytes, romFile, m, flags)
    if (!b.ok) continue
    const kinds = new Set<string>()
    for (let s = 0; s < Math.min(b.inputs.screenCount, MAX_SCREENS); s++) {
      const r = screenResult(b.inputs, s)
      if (r.status === 'ok') MAP_PLANE_KEYS.forEach(k => r.planes[k] && kinds.add(k))
    }
    console.log(`${m.toString(16)} ${b.inputs.screenCount} ${[...kinds].join(',')}`)
  }
  process.exit(0)
}
const rows: string[] = []
const kindsByMap: string[] = []
const plantRed: Record<string, Record<string, [number, number]>> = { row: {}, flipX: {} }
let screensChecked = 0
let escapes = 0
mkdirSync(outDir, { recursive: true })
for (const m of MAPS) {
  const built = cache.get(bytes, romFile, m, {
    green: false,
    yellow: false,
    blue: false,
    red: false,
  })
  if (!built.ok) throw new Error(`map ${m.toString(16)}: ${built.reason}`)
  const model = built.inputs
  const n = Math.min(model.screenCount, MAX_SCREENS)
  const ts = newTileSet()
  const replies = []
  const enc = []
  for (let s = 0; s < n; s++) {
    const r = screenResult(model, s)
    if (r.status !== 'ok') throw new Error(`screen ${s}: ${r.status}`)
    replies.push(r)
    enc.push(encodeScreen(model, ts, s))
  }
  const l3colors = model.l3?.l3?.colors ?? []
  const pal0 = palettes(model.colors, 256)
  const pal1 = palettes(l3colors, 32)
  const tiles = ts.pixels
  const tileBlob = new Uint8Array(tiles.length * 64)
  tiles.forEach((t, i) => tileBlob.set(t, i * 64))
  const palRgba: [Uint8Array, Uint8Array] = [pal0.rgba, pal1.rgba]

  const drawn = new Set<string>()
  // The oracle: indexed decode vs today's decoded planes, every plane of every screen.
  for (let s = 0; s < n; s++) {
    const r = replies[s]!
    escapes += enc[s]!.escapes
    for (const k of MAP_PLANE_KEYS) {
      const want = r.planes[k] ? new Uint8Array(Buffer.from(r.planes[k]!, 'base64')) : null
      const pl = enc[s]!.planes[k] ?? null
      const dec = (plant: '' | 'row' | 'flipX') => pl && new Uint8Array(decodePlane(pl, tiles, palRgba, r.width, r.height, plant).buffer) // prettier-ignore
      const same = (a: Uint8Array | null) => (want === null ? !a || a.every(v => v === 0) : !!a && Buffer.compare(a, want) === 0) // prettier-ignore
      if (!same(dec(''))) throw new Error(`ORACLE RED map ${m.toString(16)} screen ${s} plane ${k} (escapes ${enc[s]!.escapes})`) // prettier-ignore
      if (want) {
        drawn.add(k)
        for (const p of ['row', 'flipX'] as const) {
          const t = (plantRed[p]![k] ??= [0, 0])
          t[1]++
          if (!same(dec(p))) t[0]++
        }
      }
    }
    screensChecked++
  }

  kindsByMap.push(`map ${m.toString(16)} drew: ${[...drawn].sort().join(',')}`)
  // Whole-map ghost census (encode only, no oracle): cells that need the RGBA escape path.
  let fullEscapes = 0
  for (let s = 0; s < model.screenCount; s++)
    fullEscapes += encodeScreen(model, newTileSet(), s).escapes
  kindsByMap.push(`  ghost escape cells: first ${n} screens ${enc.reduce((t, e) => t + e.escapes, 0)}, all ${model.screenCount} screens ${fullEscapes}`) // prettier-ignore
  // Wire bytes, today's reply JSON vs the indexed per-screen JSON; the tile set + CGRAM are per map.
  const jsonA = replies.map(r => JSON.stringify(r))
  const planeJson = (p: IPlane | null) => p && { ox: p.ox, oy: p.oy, cols: p.cols, rows: p.rows, pal: p.pal, cells: b64(p.cells) } // prettier-ignore
  const jsonI = enc.map(e => JSON.stringify(Object.fromEntries(MAP_PLANE_KEYS.map(k => [k, planeJson(e.planes[k] ?? null)])))) // prettier-ignore
  const rawA = replies.map(r => MAP_PLANE_KEYS.reduce((t, k) => t + (r.planes[k] ? Buffer.from(r.planes[k]!, 'base64').length : 0), 0)) // prettier-ignore
  const rawI = enc.map(e => Object.values(e.planes).reduce((t, p) => t + (p ? p.cells.byteLength + 8 : 0), 0)) // prettier-ignore
  const mapJson = JSON.stringify({
    tiles: b64(tileBlob),
    pal0: b64(pal0.c555),
    pal1: b64(pal1.c555),
  })
  const mapRaw = tileBlob.length + pal0.c555.length + pal1.c555.length
  const avg = (a: number[]) => Math.round(a.reduce((t, v) => t + v, 0) / a.length)
  const strs = (a: string[]) => a.map(s => s.length)
  const gzs = (a: string[]) => a.map(gz)
  const brs = (a: string[]) => a.map(br)
  rows.push(
    `map ${m.toString(16)} (${n} of ${model.screenCount} screens, ${tiles.length} tiles)`,
    `  per-screen avg  RGBA: raw ${avg(rawA)}  json ${avg(strs(jsonA))}  gzip ${avg(gzs(jsonA))}  brotli ${avg(brs(jsonA))}`,
    `  per-screen avg  IDX : raw ${avg(rawI)}  json ${avg(strs(jsonI))}  gzip ${avg(gzs(jsonI))}  brotli ${avg(brs(jsonI))}`,
    `  per-map shared  IDX : raw ${mapRaw}  json ${mapJson.length}  gzip ${gz(mapJson)}  brotli ${br(mapJson)}`,
    `  whole map       RGBA json ${jsonA.reduce((t, s) => t + s.length, 0)} gzip ${gzs(jsonA).reduce((t, v) => t + v, 0)} | IDX json ${jsonI.reduce((t, s) => t + s.length, 0) + mapJson.length} gzip ${gzs(jsonI).reduce((t, v) => t + v, 0) + gz(mapJson)}`, // prettier-ignore
  )
  writeFileSync(
    `${outDir}/map-${m.toString(16)}.json`,
    JSON.stringify({
      map: m,
      w: replies[0]!.width,
      h: replies[0]!.height,
      A: replies.map(r => r.planes),
      L: replies.map(r => ({ lists: r.screens, math: r.math })),
      I: { tiles: b64(tileBlob), pal0: b64(pal0.c555), pal1: b64(pal1.c555), screens: jsonI.map(j => JSON.parse(j)) }, // prettier-ignore
    }),
  )
}
console.log(rows.join('\n'))
console.log(kindsByMap.join('\n'))
console.log(`oracle: ${screensChecked} screens, all drawn planes byte-identical (maps ${MAPS.map(m => m.toString(16))}); ghost escape cells in the checked screens: ${escapes}`) // prettier-ignore
for (const [p, t] of Object.entries(plantRed))
  console.log(`planted ${p}: ` + Object.entries(t).map(([k, [red, all]]) => `${k} ${red}/${all} red`).join(', ')) // prettier-ignore
