/**
 * The RPC behind the Objects overlay (#1237): `mapObjects` over the working copy and the project's
 * definition files. The synthetic cases need no ROM; the corpus cases are gated with describe.skipIf.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { SWITCH_FLAGS_UNCLEARED } from '../../../src/rom/ObjectExpander'
import { PER_LEVEL_MAP16, readObjectInputs } from '../../../src/rom/objects/ObjectInputs'
import { objectsDir } from '../../../src/project/ObjectDefinitionsStandIn'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { mapObjects } from '../../../theia/extension/src/node/map-objects'
import { hasRom, INVICTUS, romPath, VANILLA } from '../support/corpus'

const roots: string[] = []
function project(files: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-mapobjects-'))
  roots.push(root)
  const manifest = path.join(root, 'p.hbproj')
  if (Object.keys(files).length > 0) fs.mkdirSync(objectsDir(manifest), { recursive: true })
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(objectsDir(manifest), name), typeof body === 'string' ? body : JSON.stringify(body)) // prettier-ignore
  return manifest
}
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const bytesOf = (name: string) => new Uint8Array(fs.readFileSync(romPath(name)))

describe('mapObjects without a ROM', () => {
  it('says so in plain words, with a status, when the ROM cannot be read at all', () => {
    const r = mapObjects(new L1ModelCache(), new Uint8Array(0x80000), 'zero.sfc', project(), 0x103)
    expect(r.status).toBe('unavailable')
    if (r.status !== 'unavailable') return
    expect(r.reason).toBe("Objects can't be found on this map: its data could not be read.")
    expect(r).not.toHaveProperty('ok')
  })
})

describe.skipIf(!hasRom(VANILLA))('mapObjects on the vanilla ROM', () => {
  const bytes = bytesOf(VANILLA)
  const map = new SmwRom(RomFile.fromBytes(romPath(VANILLA), Buffer.from(bytes)))
  const inputs = readObjectInputs(map, 0x103, SWITCH_FLAGS_UNCLEARED)
  if (!inputs.ok) throw new Error(inputs.reason)
  const { objects: pieces } = parseLevelObjects(map.getLevelRawData(0x103)!, (map.getVerticalTable() as { table: never }).table) // prettier-ignore
  const tilesOf = (n: number) => [...new Set(inputs.footprint.filter(f => { const o = pieces[f.owner]!; return o.type === 'standard' && o.objectNumber === n && o.x < 16 && o.y < 24 }).map(f => f.tile))] // prettier-ignore
  const edge = tilesOf(0x13)
  const fill = tilesOf(0x14).filter(t => !edge.includes(t))
  const ledge = { version: 1, id: 'ledge', name: 'Ledge', tileset: inputs.tileset, edge, fill }

  it('finds the project definitions and describes each Object for the view', () => {
    const r = mapObjects(new L1ModelCache(), bytes, romPath(VANILLA), project({ 'ledge.json': ledge }), 0x103) // prettier-ignore
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const onScreen0 = r.objects.filter(o => o.runs.every(run => run.col + run.len <= 16))
    expect(onScreen0).toHaveLength(4)
    for (const o of onScreen0) {
      expect(o.name).toBe('Ledge')
      expect(o.segments.length).toBeGreaterThanOrEqual(4)
      expect(o.visiblePath).toMatch(/^M/)
    }
    // Front-to-back order comes from the stored list, and is distinct for the four.
    expect(new Set(onScreen0.map(o => o.order)).size).toBe(4)
    expect(r.skipped).toEqual([])
  })

  it('no definitions is an ordinary empty answer, not a refusal', () => {
    const r = mapObjects(new L1ModelCache(), bytes, romPath(VANILLA), project(), 0x103)
    expect(r).toEqual({ status: 'ok', objects: [], skipped: [] })
  })

  it('a damaged definition is reported and the good one still works', () => {
    const m = project({ 'ledge.json': ledge, 'broken.json': '{nope' })
    const r = mapObjects(new L1ModelCache(), bytes, romPath(VANILLA), m, 0x103)
    expect(r.status === 'ok' && r.objects.length).toBeGreaterThan(0)
    expect(r.status === 'ok' && r.skipped).toEqual([{ file: 'broken.json', reason: expect.any(String) }]) // prettier-ignore
  })

  it('a definition for another tileset finds nothing on this map', () => {
    const other = { ...ledge, tileset: (inputs.tileset + 1) % 15 }
    const r = mapObjects(new L1ModelCache(), bytes, romPath(VANILLA), project({ 'ledge.json': other }), 0x103) // prettier-ignore
    expect(r).toEqual({ status: 'ok', objects: [], skipped: [] })
  })

  it('reads the working copy: an edited map answers differently, the same bytes answer from the cache', () => {
    const cache = new L1ModelCache()
    const m = project({ 'ledge.json': ledge })
    const first = mapObjects(cache, bytes, romPath(VANILLA), m, 0x103)
    expect(mapObjects(cache, bytes, romPath(VANILLA), m, 0x103)).toEqual(first)
    // A map with another slot's data in it: slot $104 has no platform of these tiles on screen 0.
    const other = mapObjects(cache, bytes, romPath(VANILLA), m, 0x104)
    expect(other).not.toEqual(first)
  })
})

describe.skipIf(!hasRom(INVICTUS))('mapObjects on a hack with per-map tiles', () => {
  it('is unavailable in plain words and finds nothing', () => {
    const r = mapObjects(new L1ModelCache(), bytesOf(INVICTUS), romPath(INVICTUS), project(), 0x105)
    expect(r).toEqual({ status: 'unavailable', reason: PER_LEVEL_MAP16 })
  })
})
