/**
 * Painting through a project: the pixel op reaches disk, the arena rewrite
 * does not, and reopening the project reconstitutes both.
 *
 * **Synthetic cartridges only** (test/suite/support/syntheticGfxCart.ts), so
 * this runs in CI where test/roms/ is absent by design.
 *
 * The load-bearing asymmetry: `ops/` holds palette layers, `gfx/pixels.json`
 * holds strokes, and the ~107 KB of cartridge bytes a repack produces is
 * held only in memory. A project stays free of cartridge-derived bytes, which
 * is what tools/scripts/check-staged-content.sh exists to keep true.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject } from '../../../src/project/Project'
import { GFX_ARENA_LAYER_ID, WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import { GFX_DIR, GFX_OPS_FILE, loadGfxOps } from '../../../src/project/GfxOpsStore'
import { loadLayers } from '../../../src/project/OpsStore'
import { RomFile } from '../../../src/rom/RomFile'
import { GfxPixelOp, GfxTable } from '../../../src/rom/GfxTable'
import { encode } from '../../../src/rom/LcLz2'
import { loromToOffset } from '../../../src/rom/addressing'
import { GFX_FILE_COUNT } from '../../../src/rom/GfxArena'
import { buildCart, CartOptions } from '../support/syntheticGfxCart'

const TILES = 11
const SHEET_BYTES = TILES * 24 // 3bpp, and not a multiple of 16 or 32
const PALETTE_ADDR = 0x00b2ce

let tmp: string
let romRegistry: RomRegistry
let working: WorkingRomRegistry
let manifestPath: string

function cartBytes(opts: CartOptions = {}): Uint8Array {
  const streams =
    opts.streams ??
    Array.from({ length: GFX_FILE_COUNT }, (_, i) =>
      encode(Uint8Array.from({ length: SHEET_BYTES }, (_, k) => (i * 13 + k * 5) & 0xff)),
    )
  const rom = buildCart({ filler: 4096, ...opts, streams }).rom
  const bytes = Uint8Array.from(rom.buffer)
  bytes.set(Buffer.from('SYNTHETIC CART       ', 'ascii'), 0x7fc0)
  // A palette word to edit, so the GFX layer can be tested against a
  // neighbour that lands on top of it.
  const at = loromToOffset(PALETTE_ADDR, bytes.length, false)!
  bytes[at] = 0x1f
  bytes[at + 1] = 0x39
  return bytes
}

function makeProject(bytes: Uint8Array = cartBytes(), name = 'MyHack'): string {
  const romPath = path.join(tmp, `${name}.sfc`)
  fs.writeFileSync(romPath, bytes)
  romRegistry.register(romPath)
  return createProject({ romPath, name, directory: path.join(tmp, name) }).manifestPath
}

const pixel = (over: Partial<GfxPixelOp> = {}): GfxPixelOp => ({
  kind: 'gfxPixel',
  file: 4,
  tile: 9,
  x: 2,
  y: 6,
  value: 5,
  ...over,
})

/** The table a fresh process would see, which is the only honest way to ask
 *  whether an edit survived. */
function reopened(mp: string): WorkingRomRegistry {
  const fresh = new WorkingRomRegistry(romRegistry)
  expect(fresh.get(mp).status).toBe('ok')
  return fresh
}

function tableOf(reg: WorkingRomRegistry, mp: string): GfxTable {
  const r = reg.gfxTable(mp)
  if (r.status !== 'ok') throw new Error(`gfxTable: ${r.status}`)
  return r.table
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-gfxops-'))
  romRegistry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
  working = new WorkingRomRegistry(romRegistry)
  manifestPath = makeProject()
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('painting a pixel', () => {
  it('persists the op and shows it in the table immediately', () => {
    expect(working.setGfxPixel(manifestPath, pixel()).status).toBe('ok')

    const table = tableOf(working, manifestPath)
    expect(table.tile(4, 9)![6 * 8 + 2]).toBe(5)
    expect(table.dirtyFiles()).toEqual([4])

    const dir = path.dirname(manifestPath)
    expect(loadGfxOps(dir)).toEqual([pixel()])
    expect(fs.existsSync(path.join(dir, GFX_DIR, GFX_OPS_FILE))).toBe(true)
  })

  it('does not touch the cartridge bytes until save', () => {
    const before = Buffer.from(
      working.get(manifestPath).status === 'ok' ? bytesOf(manifestPath) : [],
    )
    working.setGfxPixel(manifestPath, pixel())
    expect(Buffer.compare(before, Buffer.from(bytesOf(manifestPath)))).toBe(0)
  })

  it('refuses an op the table cannot place, and persists nothing', () => {
    const r = working.setGfxPixel(manifestPath, pixel({ tile: 999 }))
    expect(r.status).toBe('refused')
    expect(loadGfxOps(path.dirname(manifestPath))).toEqual([])
  })
})

describe('saving', () => {
  it('writes the repack, and the pixel reads back off the cartridge bytes', () => {
    working.setGfxPixel(manifestPath, pixel())
    const r = working.saveGfx(manifestPath)
    expect(r.status).toBe('ok')

    const rom = new RomFile('working.sfc', Buffer.from(bytesOf(manifestPath)))
    expect(GfxTable.load(rom).tile(4, 9)![6 * 8 + 2]).toBe(5)
  })

  it('keeps the derived layer OUT of ops/', () => {
    // 107 KB of Nintendo's graphics per save is exactly what the project
    // format refuses to hold; the strokes are the record.
    working.setGfxPixel(manifestPath, pixel())
    working.saveGfx(manifestPath)
    expect(loadLayers(path.dirname(manifestPath))).toEqual([])
  })

  it('supersedes the previous repack rather than stacking another one', () => {
    working.setGfxPixel(manifestPath, pixel())
    working.saveGfx(manifestPath)
    working.setGfxPixel(manifestPath, pixel({ tile: 3, value: 2 }))
    working.saveGfx(manifestPath)

    const r = working.get(manifestPath)
    if (r.status !== 'ok') throw new Error('unreachable')
    const derived = r.working.stack.filter(l => l.id === GFX_ARENA_LAYER_ID)
    expect(derived.length).toBe(1)

    const rom = new RomFile('working.sfc', Buffer.from(bytesOf(manifestPath)))
    const table = GfxTable.load(rom)
    expect(table.tile(4, 9)![6 * 8 + 2]).toBe(5)
    expect(table.tile(4, 3)![6 * 8 + 2]).toBe(2)
  })

  it('survives a palette edit landing between two saves', () => {
    // removeById, not pop: the derived layer is no longer on top once
    // another view has written through the same working copy.
    working.setGfxPixel(manifestPath, pixel())
    working.saveGfx(manifestPath)
    const c = working.setColor(manifestPath, {
      romAddr: PALETTE_ADDR,
      oldHex: '$391F',
      newHex: '$03E0',
    })
    expect(c.status).toBe('ok')
    working.setGfxPixel(manifestPath, pixel({ tile: 1, value: 3 }))
    expect(working.saveGfx(manifestPath).status).toBe('ok')

    const bytes = bytesOf(manifestPath)
    const at = loromToOffset(PALETTE_ADDR, bytes.length, false)!
    expect([bytes[at], bytes[at + 1]]).toEqual([0xe0, 0x03])
    const table = GfxTable.load(new RomFile('working.sfc', Buffer.from(bytes)))
    expect(table.tile(4, 1)![6 * 8 + 2]).toBe(3)
  })

  it('writes only the stream it touched when no stream changed length', () => {
    // These fixtures encode as literal runs, so painting inside one changes
    // its payload without changing its length and nothing behind it moves.
    // Measured the other way on a real cart, where lengths DO move: one
    // pixel in GFX $00 changes 102,185 bytes and the same edit in the last
    // file changes 1,208 (docs/gfx-arena-budget.md). The diff is the right
    // mechanism either way; what it costs is a property of the layout, not
    // of this function.
    working.setGfxPixel(manifestPath, pixel())
    const r = working.saveGfx(manifestPath)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const region = SHEET_BYTES * GFX_FILE_COUNT
    expect(r.bytesChanged).toBeGreaterThan(0)
    expect(r.bytesChanged).toBeLessThan(region / 10)
  })
})

describe('reopening the project', () => {
  it('replays the strokes and re-derives the repack without another save', () => {
    working.setGfxPixel(manifestPath, pixel())
    working.saveGfx(manifestPath)

    const fresh = reopened(manifestPath)
    expect(tableOf(fresh, manifestPath).tile(4, 9)![6 * 8 + 2]).toBe(5)

    const r = fresh.get(manifestPath)
    if (r.status !== 'ok') throw new Error('unreachable')
    // Exportable, not merely present: an export taken right after opening
    // has to carry the edit, and `exportableBytes` is what ExportPatch diffs.
    const exported = new RomFile('exported.sfc', Buffer.from(r.working.exportableBytes()))
    expect(GfxTable.load(exported).tile(4, 9)![6 * 8 + 2]).toBe(5)
  })

  it('replays strokes that were never saved, so nothing is lost by closing', () => {
    working.setGfxPixel(manifestPath, pixel())
    // No saveGfx: the stroke is on disk, the repack never happened.
    const fresh = reopened(manifestPath)
    expect(tableOf(fresh, manifestPath).tile(4, 9)![6 * 8 + 2]).toBe(5)
  })

  it('reports a stroke it could not replay instead of dropping it silently', () => {
    fs.mkdirSync(path.join(path.dirname(manifestPath), GFX_DIR), { recursive: true })
    fs.writeFileSync(
      path.join(path.dirname(manifestPath), GFX_DIR, GFX_OPS_FILE),
      JSON.stringify({ version: 1, ops: [pixel({ tile: 4000 })] }),
    )
    const fresh = reopened(manifestPath)
    const r = fresh.gfxTable(manifestPath)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.skipped.length).toBe(1)
  })
})

describe('refusals reach the caller', () => {
  it('reports the overage when the repack does not fit', () => {
    const flat = Array.from({ length: GFX_FILE_COUNT }, (_, i) =>
      encode(new Uint8Array(SHEET_BYTES).fill(i & 0xff)),
    )
    const mp = makeProject(cartBytes({ streams: flat, filler: 0 }), 'Packed')
    expect(working.setGfxPixel(mp, pixel({ file: 2, tile: 0, x: 0, y: 0, value: 7 })).status).toBe(
      'ok',
    )
    const r = working.saveGfx(mp)
    expect(r.status).toBe('overflow')
    if (r.status !== 'overflow') return
    expect(r.overage).toBeGreaterThan(0)
    expect(r.reason).toMatch(/446/)
  })

  it('refuses a cartridge whose decompressor has been replaced', () => {
    const entryBytes = [0x22, 0, 0, 0x20, 0xea, 0x22, 0, 0, 0x20, 0x60]
    const mp = makeProject(cartBytes({ entryBytes }), 'Patched')
    const r = working.saveGfx(mp)
    expect(r.status).toBe('unavailable')
    if (r.status !== 'unavailable') return
    expect(r.reason).toMatch(/LC_LZ2/i)
  })

  it('a refused save leaves the cartridge bytes untouched', () => {
    const entryBytes = [0x22, 0, 0, 0x20, 0xea, 0x22, 0, 0, 0x20, 0x60]
    const mp = makeProject(cartBytes({ entryBytes }), 'Patched2')
    const before = Buffer.from(bytesOfIn(working, mp))
    working.setGfxPixel(mp, pixel())
    working.saveGfx(mp)
    expect(Buffer.compare(before, Buffer.from(bytesOfIn(working, mp)))).toBe(0)
  })
})

function bytesOf(mp: string): Uint8Array {
  return bytesOfIn(working, mp)
}

function bytesOfIn(reg: WorkingRomRegistry, mp: string): Uint8Array {
  const r = reg.get(mp)
  if (r.status !== 'ok') throw new Error(`get: ${r.status}`)
  return r.working.bytes()
}
