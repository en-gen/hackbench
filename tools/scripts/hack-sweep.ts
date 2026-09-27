/**
 * Runs the readers behind each app view over every hack in the hack store, and
 * checks our patch appliers against the store's patched ROMs. Hand-run, never CI:
 *
 *   npx tsx tools/scripts/hack-sweep.ts
 *
 * HACKBENCH_HACKS names the store (read only), HACKBENCH_SWEEP_OUT the output
 * directory. Output holds hashes, ids, names, verdicts and counts; a reason may
 * quote one instruction's bytes, and longer runs are elided.
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { RomFile } from '../../src/rom/RomFile'
import { SmwRom } from '../../src/rom/SmwRom'
import { applyBps } from '../../src/rom/Bps'
import { decodeIps } from '../../src/rom/Ips'
import { buildMapTree } from '../../src/rom/MapTree'
import { buildLevelCatalog } from '../../src/rom/LevelCatalog'
import { deriveOverworldEntrances, readWalk, readWarpTiles } from '../../src/rom/OverworldEntrances'
import { OVERWORLD_ENTRY, readEntrySite, stockCodeMismatch } from '../../src/rom/SubmapFlagGate'
import { buildStockTables, countCustomPaletteLevels } from '../../src/rom/PaletteStockTables'
import { detectPaletteAnimation } from '../../src/rom/PaletteAnimationDetect'
import { MUSIC_BANKS, readMusicCatalog, readTrackUsage } from '../../src/rom/MusicCatalog'
import { SFX_PORTS, readSfxTable } from '../../src/rom/SfxTables'
import { buildMapDetails } from '../../theia/extension/src/node/map-details'
import { decodeGfxSheet, listGfxFileInfos } from '../../theia/extension/src/node/gfx-decode'
import { decodeMap16Sheet } from '../../theia/extension/src/node/map16-decode'
import { romPath, VANILLA } from '../../test/suite/support/corpus'
import {
  Applied,
  HackRecord,
  InteropRecord,
  ReaderOutcome,
  decideInterop,
  gfxRefusals,
  runReader,
  summarize,
} from './hackSweepReport'

interface IndexEntry {
  smwc_id: number
  name: string
  patch_format: string
  patch_file?: string
  patched_rom_file?: string
  patched_rom_sha256?: string
}

const hex = (n: number, w: number): string => `$${n.toString(16).toUpperCase().padStart(w, '0')}`
const ok = (summary: string): ReaderOutcome => ({ verdict: 'ok', summary })
const refuse = (...reasons: string[]): ReaderOutcome => ({ verdict: 'unavailable', reasons })

/** The overworld reader stops at its first failing gate; this checks each known gate on its own. */
function overworldGates(smw: SmwRom): string[] {
  const failing = OVERWORLD_ENTRY.slice(0, -1).flatMap(c => stockCodeMismatch(smw.rom, [c]) ?? [])
  const site = readEntrySite(smw.rom)
  if (!site.ok) failing.push(site.reason)
  const walk = readWalk(smw.rom)
  if (typeof walk === 'string') failing.push(walk)
  if (!readWarpTiles(smw.rom)) failing.push("OWPU_ABXY's warp-tile compares are not stock")
  return failing
}

/** Each entry is what its view's server calls. */
function readers(smw: SmwRom): Record<string, () => ReaderOutcome> {
  return {
    maps: () => {
      const t = buildMapTree(smw)
      return ok(
        `${t.mapCount} maps, ${t.overworld.length} roots, ${t.counts.unassigned} unassigned`,
      )
    },
    mapDetails: () => {
      // What the app calls when a map is clicked, over every map the catalog calls real.
      const real = buildLevelCatalog(smw).entries.filter(e => e.isReal)
      const failed: { index: number; err: Error }[] = []
      for (const e of real) {
        try {
          buildMapDetails(smw, e.index)
        } catch (err) {
          failed.push({ index: e.index, err: err as Error })
        }
      }
      if (!failed.length) return ok(`${real.length} maps open`)
      const slots = failed.slice(0, 5).map(f => hex(f.index, 3))
      const agg = new Error(
        `${failed.length} of ${real.length} maps throw (${slots.join(', ')}${failed.length > 5 ? ', ...' : ''}): ${failed[0]!.err.message}`,
      )
      agg.stack = `Error: ${agg.message}\n${(failed[0]!.err.stack ?? '').split('\n').slice(1).join('\n')}`
      throw agg
    },
    overworld: () => {
      const e = deriveOverworldEntrances(smw)
      if (e.overworldReadable) return ok(`${e.entrances.length} entrances`)
      const gates = overworldGates(smw)
      return refuse(...(gates.length ? gates : [e.notes[0] ?? 'no reason given']))
    },
    graphics: () => {
      const files = listGfxFileInfos(smw)
      const refusals = gfxRefusals(files, i => decodeGfxSheet(smw, i))
      const summary = `${files.length - refusals.length} of ${files.length} files decode`
      return refusals.length
        ? { verdict: 'unavailable', reasons: [...new Set(refusals)], summary }
        : ok(summary)
    },
    map16: () => {
      const tiles: number[] = []
      const reasons: string[] = []
      for (const layer of ['fg', 'bg'] as const) {
        const r = decodeMap16Sheet(smw, 0, layer, { bg: 0, fg: 0 })
        if (r.status === 'ok') tiles.push(r.sheet.tiles.length)
        else reasons.push(r.reason)
      }
      return reasons.length
        ? refuse(...new Set(reasons))
        : ok(`tileset 0: ${tiles[0]} fg tiles, ${tiles[1]} bg tiles`)
    },
    palettes: () => {
      const groups = buildStockTables(smw.rom).length
      const custom = countCustomPaletteLevels(smw.rom)
      // The server shows the grid even when the animation detector throws.
      let anim = 'animation throws'
      try {
        anim = detectPaletteAnimation(smw.rom).level.available
          ? 'animation read'
          : 'animation unavailable'
      } catch {
        /* reported in the summary */
      }
      return ok(`${groups} groups, ${custom} custom-palette levels, ${anim}`)
    },
    music: () => {
      const counts: string[] = []
      const reasons: string[] = []
      for (const bank of MUSIC_BANKS) {
        const c = readMusicCatalog(smw, bank)
        if (c.status === 'ok') counts.push(`${c.bank.tracks.length} ${bank}`)
        else reasons.push(`${bank}: ${c.reason}`)
      }
      if (!reasons.length) return ok(`tracks: ${counts.join(', ')}`)
      readTrackUsage(smw) // the view's fallback on refusal, so it must not throw either
      return refuse(...reasons)
    },
    sfx: () => {
      const counts: number[] = []
      const reasons: string[] = []
      for (const port of SFX_PORTS) {
        const r = readSfxTable(smw.rom, port)
        if (r.status === 'ok') counts.push(r.table.entries.length)
        else reasons.push(`port ${port}: ${r.reason}`)
      }
      return reasons.length ? refuse(...reasons) : ok(`${counts.join(' + ')} sound effects`)
    },
  }
}

/** IPS has no applier in src/, only decodeIps: this overlays its records on vanilla. */
function applyIps(vanilla: Uint8Array, patch: Uint8Array): Applied {
  const records = decodeIps(patch)
  if (!records) return { ok: false, reason: 'decodeIps refused the patch' }
  const size = records.reduce((m, p) => Math.max(m, p.offset + 1), vanilla.length)
  const out = new Uint8Array(size)
  out.set(vanilla)
  for (const p of records) out[p.offset] = p.value
  return { ok: true, bytes: out }
}

function interop(store: string, h: IndexEntry, vanilla: Uint8Array): InteropRecord {
  const ext = `.${h.patch_format}`
  // Most entries name no patch_file; the patch is then the one of its format in patches/<id>/.
  const dir = join('patches', String(h.smwc_id))
  const found = readdirSync(join(store, dir)).filter(f => f.toLowerCase().endsWith(ext))
  const file = h.patch_file ?? (found.length === 1 ? join(dir, found[0]!) : null)
  if (!file) return { verdict: 'unchecked', reason: `${found.length} ${ext} files in ${dir}` }
  const patch = readFileSync(join(store, file))
  if (h.patch_format === 'bps') return decideInterop(h.patched_rom_sha256, applyBps(vanilla, patch))
  if (h.patch_format === 'ips') return decideInterop(h.patched_rom_sha256, applyIps(vanilla, patch))
  return { verdict: 'unchecked', reason: `no applier for ${h.patch_format}` }
}

function sweepOne(store: string, h: IndexEntry, vanilla: Uint8Array): HackRecord {
  let interopRecord: InteropRecord
  try {
    interopRecord = interop(store, h, vanilla)
  } catch (err) {
    interopRecord = { verdict: 'refused', reason: `threw: ${(err as Error).message}` }
  }
  const path = join(store, h.patched_rom_file ?? `roms/${h.smwc_id}.sfc`)
  const bytes = existsSync(path) ? readFileSync(path) : null
  const views: HackRecord['readers'] = {}
  const record = { smwcId: h.smwc_id, name: h.name, readers: views, interop: interopRecord }
  if (!bytes) return { ...record, romSha256: null, romSize: null }
  let smw: SmwRom | Error
  try {
    smw = new SmwRom(RomFile.fromBytes(path, bytes))
  } catch (err) {
    smw = err as Error
  }
  for (const [view, read] of Object.entries(readers(smw as SmwRom))) {
    // The working-copy registry reports a ROM SmwRom rejects as 'unreadable', and every view shows why.
    views[view] = runReader(
      smw instanceof Error ? () => refuse(`unreadable: ${smw.message}`) : read,
    )
  }
  const romSha256 = createHash('sha256').update(bytes).digest('hex')
  return { ...record, romSha256, romSize: bytes.length }
}

if (require.main === module) {
  const store = process.env.HACKBENCH_HACKS ?? 'C:/Projects/hackbench-tools/hacks'
  const outDir = process.env.HACKBENCH_SWEEP_OUT ?? 'C:/Projects/hackbench-tools/sweep'
  const index = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8')) as {
    hacks: IndexEntry[]
  }
  const vanilla = readFileSync(romPath(VANILLA))
  const records: HackRecord[] = []
  for (const h of index.hacks) {
    process.stdout.write(`${h.smwc_id} ${h.name}\n`)
    records.push(sweepOne(store, h, vanilla))
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(records, null, 2))
  writeFileSync(join(outDir, 'summary.md'), summarize(records))
  process.stdout.write(`wrote ${records.length} records to ${outDir}\n`)
}
