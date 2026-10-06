import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { png } from '../block-content-indicators/lib.ts'
import { Probe, measureTile, type TileProbe } from './engine.ts'
import { compose, categorize, type Cat } from './compose.ts'
// Usage: npx tsx spikes/collision-probe/probe.ts --rom <path to a vanilla ROM> --map <hex level> [--out dir]  (en-gen/hackbench#435)
// Runs SMW's own Mario-vs-layer-1 routine on the core for every Map16 id, composes vector lines for one map, writes out/<map>.html.
const arg = (n: string) => { const i = process.argv.indexOf('--' + n); return i < 0 ? undefined : process.argv[i + 1] }
const romFile = arg('rom'), mapArg = arg('map')
if (!romFile || !mapArg) throw new Error('usage: probe.ts --rom <path> --map <hex level number> [--out <dir>]')
const MAP = parseInt(mapArg, 16)
const HERE = new URL('.', import.meta.url), R = new URL('../../', HERE).href
const outDir = arg('out') ?? fileURLToPath(new URL('out/', HERE))
const hx = (n: number, w = 3) => n.toString(16).padStart(w, '0')

async function main() {
  const { SmwRom } = await import(R + 'src/rom/SmwRom.ts')
  const { RomFile } = await import(R + 'src/rom/RomFile.ts')
  const { buildL1Inputs } = await import(R + 'src/rom/model/L1Model.ts')
  const { renderMap16Tile } = await import(R + 'src/rom/TileRenderer.ts')
  const { buildTiles } = await import(R + 'src/rom/model/tiles/TileFactory.ts')
  const { loromToOffset } = await import(R + 'src/rom/addressing.ts')
  const rom = SmwRom.open(romFile)
  const r = buildL1Inputs(rom, MAP, { yellow: false, green: false, red: false, blue: false })
  if (!r.ok) throw new Error(r.reason)
  const L = r.inputs

  // ---- the oracle must be able to fail: planted defects in ROM copies (CLAUDE.md "Oracles must be proven able to fail")
  {
    const copy = (patch: (b: Buffer, off: (a: number) => number) => void) => {
      const c = RomFile.load(romFile); patch(c.buffer, (a: number) => loromToOffset(a, c.romSize, c.hasHeader)!); return c
    }
    const p0 = new Probe(RomFile.load(romFile), MAP), t0 = measureTile(p0, 0x1bf)
    // 1) a BRK at the entry of the collision body: every tile must come out unknown, not "no collision"
    const brk = measureTile(new Probe(copy((b, o) => { b[o(0x00eadb)] = 0 }), MAP), 0x130)
    // 2) the slope table DATA_00E632 zeroed: a slope's floor must change, so the probe reads the ROM's table and not a built-in one
    const flat = measureTile(new Probe(copy((b, o) => { for (let i = 0; i < 0x1f0; i++) b[o(0x00e632 + i)] = 0 }), MAP), 0x1bf)
    // 3) the top-of-block hit (JSL CODE_00F120 at $00EE7F) pointed at HurtMario: a tile that kills on touch from above.
    //    Small Mario dies with Y speed set negative, and CODE_00EE85 then returns before the landing flag (bank_00.asm:12482-12488),
    //    so a probe that waits for the landing sees no floor. The surface is still where the kill fires.
    const kill = measureTile(new Probe(copy((b, o) => { b.set([0x22, 0xb7, 0xf5, 0x00], o(0x00ee7f)) }), MAP), 0x130)
    const killOk = kill.hurt && kill.floor.every((v) => v === 0) && t0.floor.length === 16
    const ok = !!brk.unknown && /BRK/.test(brk.unknown) && !t0.unknown && t0.floor.join() !== flat.floor.join() && new Set(t0.floor).size > 3 && killOk
    console.log(`self-test: BRK planted -> "${brk.unknown}"; slope table zeroed: floor ${t0.floor.join(' ')} -> ${flat.floor.join(' ')}: ${ok ? 'both detected' : 'FAILED'}; kill-on-touch block (planted): floor ${kill.floor.join(' ')}, hurt ${kill.hurt}: ${killOk ? 'floor found' : 'FAILED'}`)
    if (!ok) throw new Error('probe self-test failed')
  }

  // compose() on synthetic tiles (no ROM): edges only where solidity changes, slope slices joined into one line
  {
    const mk = (floor: (number | null)[], ceil: (number | null)[], wallL = false, wallR = false): TileProbe => ({ floor, ceil, wallL, wallR, hurt: false, above: 0, inputs: [] })
    const solid = mk(Array(16).fill(0), Array(16).fill(16), true, true)
    const slopeL = mk(Array.from({ length: 16 }, (_, x) => x >> 1), Array(16).fill(null)), slopeR = mk(Array.from({ length: 16 }, (_, x) => 8 + (x >> 1)), Array(16).fill(null))
    const get = (id: number) => [undefined, mk(Array(16).fill(null), Array(16).fill(null)), solid, slopeL, slopeR][id]
    const a = compose([[2, 2], [2, 2]], get), b = compose([[3, 4]], get), c = compose([[0, 2]], get)
    const span = (p: number[] | undefined) => p && [p[0], p.at(-2), new Set(p.filter((_, k) => k % 2)).size].join()
    const fine = a.floor.length === 1 && span(a.floor[0]) === '0,32,1' && a.ceiling.length === 1 && a.wall.length === 2 && a.wall.every((w) => w[3]! - w[1]! === 32) // a 2x2 block: one top, one underside, two 32 px walls
      && b.floor.length === 1 && b.floor[0]![0] === 0 && b.floor[0]!.at(-2) === 32 && b.floor[0]!.at(-1) === 15 && b.wall.length === 0 // two slope tiles: one line, no walls
      && c.unknown.length === 1 && c.unknown[0]!.join() === '0,0' // an unmeasured tile is unknown, not empty
    console.log(`self-test: compose on synthetic tiles (2x2 block, two-tile slope, unknown cell): ${fine ? 'ok' : 'FAILED'}`)
    if (!fine) throw new Error('compose self-test failed')
  }

  // ---- every Map16 id, in the assumed state (small Mario, P-switches and switch palaces off) and with the blue P-switch running
  const probe = new Probe(rom.rom, MAP)
  if (probe.tileset !== L.header.objectTileset) throw new Error('loaded tileset differs from the header')
  const base: TileProbe[] = [], onP: TileProbe[] = []
  const t0 = Date.now()
  for (let id = 0; id < 0x200; id++) { base.push(measureTile(probe, id)); onP.push(measureTile(probe, id, { bluePs: 0x80 })) }
  console.log(`probed 512 ids x 2 states in ${Date.now() - t0} ms, ${probe.steps} instructions`)
  const cats = base.map(categorize)
  const same = (a: TileProbe, b: TileProbe) => JSON.stringify([a.floor, a.ceil, a.wallL, a.wallR, a.hurt, a.unknown]) === JSON.stringify([b.floor, b.ceil, b.wallL, b.wallR, b.hurt, b.unknown])
  const pDiff = base.map((b, i) => !same(b, onP[i]!))

  // ---- the old hand-ported classifier, per id, for the same tileset
  const old = buildTiles(rom.rom, L.header.objectTileset, new Map())
  const diffs: { id: number; probe: string; old: string }[] = []
  const oldDesc = (id: number) => {
    const c = old.get(id)?.collision as any
    if (!c) return { floor: false, ceil: false, wall: false, d: 'no tile' }
    const slope = c.slope ? ` slope[${[...c.slope.heights].join(',')}]` : ''
    return { floor: !!(c.marioFloor || c.slope), ceil: !!c.marioCeiling, wall: !!c.marioWall, d: `floor ${c.marioFloor || !!c.slope} ceil ${c.marioCeiling} wall ${c.marioWall}${slope}`, heights: c.slope?.heights as number[] | undefined }
  }
  for (let id = 0; id < 0x200; id++) {
    const m = base[id]!, o = oldDesc(id)
    if (m.unknown) { diffs.push({ id, probe: 'unknown: ' + m.unknown, old: o.d }); continue }
    const mf = m.floor.some((v) => v !== null), mc = m.ceil.some((v) => v !== null), mw = m.wallL || m.wallR
    // slope heights compare as depth below the cell top, the same unit
    // (a height of 16 means no surface in that column, and 240-255 is a ceiling, so neither is a floor depth)
    const slopeDiffers = o.heights && o.heights.some((h, x) => (h >= 16 ? null : h) !== m.floor[x])
    if (mf !== o.floor || mc !== o.ceil || mw !== o.wall || slopeDiffers) diffs.push({ id, probe: `floor ${mf} ceil ${mc} wall ${mw}${mf && new Set(m.floor).size > 1 ? ` floor[${m.floor.join(',')}]` : ''}`, old: o.d })
  }
  console.log(`disagreements with TileFactory.classify: ${diffs.length} of 512 ids`)

  // ---- compose lines for the map and render the tiles it uses
  const grid: number[][] = L.grid.map((row: number[]) => [...row])
  const lines = compose(grid, (id) => (base[id]!.unknown ? undefined : base[id]!))
  const pal = { colors: L.colors }
  const used = new Set<number>(grid.flat())
  const img: Record<number, string> = {}
  for (const id of used) img[id] = png(16, 16, renderMap16Tile(L.map16.tiles[id]!, L.vram, pal))
  const onMap = (id: number) => used.has(id)
  const tiles = base.map((m, id) => ({ id, cat: cats[id], pDiff: pDiff[id], onMap: onMap(id), unknown: m.unknown, hurt: m.hurt, above: m.above, inputs: m.inputs.length, floor: m.floor, ceil: m.ceil, wallL: m.wallL, wallR: m.wallR }))
  const inputCount = new Map<number, number>()
  for (const m of base) for (const a of m.inputs) inputCount.set(a, (inputCount.get(a) ?? 0) + 1)
  const inputs = [...inputCount].sort((a, b) => b[1] - a[1]).map(([a, n]) => ({ a, n }))
  const [br, bg, bb] = L.backArea
  const data = { map: '$' + hx(MAP), mapName: rom.getLevelName(MAP), tileset: L.header.objectTileset, grid, img, lines, tiles, diffs, inputs, bg: `rgb(${br},${bg},${bb})`, state: 'small Mario, blue/silver P-switch off, switch palaces off, no item, no Yoshi, not wall-running, level mode horizontal (layer 1)' }
  const tpl = readFileSync(new URL('viewer.tpl.html', HERE), 'utf8')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `${hx(MAP)}.html`)
  writeFileSync(outFile, tpl.replace('/*DATA*/', 'const D = ' + JSON.stringify(data).replace(/</g, '\\u003c')))
  // index.html: one link per map page already in the out dir (each run refreshes it)
  const pages = readdirSync(outDir).filter((f) => /^[0-9a-f]{3}\.html$/.test(f)).sort()
  const name = (f: string) => /"mapName":"([^"]*)"/.exec(readFileSync(join(outDir, f), 'utf8'))?.[1] ?? ''
  const li = pages.map((f) => `<li><a href="${f}">map $${f.slice(0, 3)} ${name(f)}</a></li>`).join('')
  writeFileSync(join(outDir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Collision probe maps</title><body style="font:14px system-ui;background:#1e1e1e;color:#ccc;padding:16px"><h1 style="font-size:16px">Collision probe maps</h1><ul>${li}</ul>`)
  const count = new Map<Cat, number>(); for (const c of cats) count.set(c, (count.get(c) ?? 0) + 1)
  console.log('ids with a landing above the cell top:', base.map((m, i) => (m.above ? '$' + hx(i) : '')).filter(Boolean).join(' '))
  console.log('categories (512 ids):', [...count].map(([c, n]) => `${c} ${n}`).join(', '))
  console.log(`map ${data.map} ${data.mapName}: ${lines.floor.length} floor/ceiling polylines, ${lines.wall.length} wall lines, ${lines.unknown.length} unknown cells; ${used.size} distinct ids`)
  console.log('wrote', outFile)
}
main()
