/**
 * Verdict and CLI tests for the L1 (foreground) data gate
 * (en-gen/hackbench#421). No real ROM needed: `runGate`'s missing-capture
 * path returns before `loadRom` is ever called (a spy proves it); the
 * multi-map integration tests use a zero-filled synthetic buffer that only
 * satisfies `SmwRom`'s own LoROM header check, never a real cart; the
 * CLI's `parseArgs`/`report` are plain functions over arguments and
 * `GateResult`s.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterAll } from 'vitest'
import { deriveOk, runGate, gateMap, checkGrid, hashMismatches as hashOf, type GateResult } from '../../../tools/scripts/capture_gate' // prettier-ignore
import { parseArgs, report, matchesKnown, type KnownEntry } from '../../../tools/scripts/capture_gate_cli' // prettier-ignore
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { BOSS_ARENA_SCREENS } from '../../../src/rom/ObjectExpander'
import type { GridMeta } from '../../../tools/scripts/capture_decode'
import { captureFiles } from './fixtures/captureFixture'

/** A ROM buffer that passes only `SmwRom`'s own LoROM map-mode check ($7FD5 = $20); no level data, no header table. */ // prettier-ignore
function blankSmwRom(): SmwRom {
  const buf = Buffer.alloc(0x80000)
  buf[0x7fd5] = 0x20
  return new SmwRom(new RomFile('blank.smc', buf))
}

describe('deriveOk', () => {
  it('is true only with no unavailable reason and zero mismatches', () => {
    expect(deriveOk(undefined, [])).toBe(true)
    expect(deriveOk('a reason', [])).toBe(false)
    expect(deriveOk(undefined, [{ table: 'grid', cell: '0,0', expected: '$1', actual: '$2' }])).toBe(false) // prettier-ignore
  })
})

describe('runGate: missing capture', () => {
  it('fails every map without ever loading the ROM', () => {
    const loadRom = vi.fn()
    const results = runGate(
      'C:/nonexistent.sfc',
      'C:/nonexistent-captures',
      [0x105, 0x106],
      loadRom,
    )
    expect(results.every(r => !r.ok && r.unavailable)).toBe(true)
    expect(results.every(r => r.mismatches.length === 0)).toBe(true)
    expect(loadRom).not.toHaveBeenCalled()
  })
})

describe('runGate: a run where one capture is present (but invalid) and one is missing (M28/M29)', () => {
  // prettier-ignore
  const dir = mkdtempSync(join(tmpdir(), 'fg-gate-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reports each id with its own reason, not the "no capture found under" shortcut', () => {
    mkdirSync(join(dir, '105')) // present, but empty: no capture_summary.json
    // 106 is absent entirely.
    const results = runGate('unused.sfc', dir, [0x105, 0x106], () => blankSmwRom())
    expect(results.every(r => !r.ok && r.unavailable)).toBe(true)
    expect(results[0]!.unavailable).toMatch(/no L1 data/) // the blank synthetic ROM has no level pointer; a real ROM would fail on the missing capture_summary.json instead
    expect(results[1]!.unavailable).toMatch(/no capture found at/)
  })
})

describe('runGate: the ROM load itself throws (X11)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-gate-'))
  mkdirSync(join(dir, '105')) // present, so the run gets past the missing-capture shortcut
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('fails every listed map with the same reason, rather than throwing out of runGate', () => {
    const loadRom = () => {
      throw new Error('boom: not a ROM')
    }
    const results = runGate('unused.sfc', dir, [0x105, 0x106], loadRom)
    expect(results.every(r => !r.ok && r.unavailable === 'boom: not a ROM')).toBe(true)
  })
})

describe('runGate: a corrupt capture file (M31, openMap throws)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-gate-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("fails only that map with openMap's own message, rather than throwing out of runGate", () => {
    // prettier-ignore
    writeFileSync(join(dir, '105'), 'not a zip') // a file, not a directory, and not a valid zip either
    const [result] = runGate('unused.sfc', dir, [0x105], () => blankSmwRom())
    expect(result!.ok).toBe(false)
    expect(result!.unavailable).toMatch(/not a readable zip/)
  })
})

describe('capture_gate_cli parseArgs', () => {
  it('refuses a dangling --maps', () => {
    const out = parseArgs(['--maps'])
    expect('error' in out).toBe(true) // node:util's own "argument missing" message, not this file's wording
  })

  it('refuses a --maps value that is not a hex map id', () => {
    const out = parseArgs(['--maps', '105,zz'])
    expect('error' in out).toBe(true)
  })

  // Absolute on every platform: CI runs on Linux, where 'C:/init' is relative.
  const INIT = join(tmpdir(), 'init')
  const CWD = join(tmpdir(), 'cwd')

  it('N25/N26: parses --rom and --maps (hex ids), resolved against INIT_CWD', () => {
    const out = parseArgs(['--rom', 'my.sfc', '--maps', '105,1bd'], { INIT_CWD: INIT }, CWD)
    expect('error' in out).toBe(false)
    if ('error' in out) return
    expect(out.rom).toBe(join(INIT, 'my.sfc'))
    expect(out.maps).toEqual([0x105, 0x1bd])
  })

  it('resolves relative paths against INIT_CWD, not cwd', () => {
    const out = parseArgs(['caps'], { INIT_CWD: INIT }, CWD)
    expect('error' in out).toBe(false)
    if (!('error' in out)) expect(out.captures).toBe(join(INIT, 'caps'))
  })

  it('refuses an extra positional argument', () => {
    const out = parseArgs(['caps', 'extra'])
    expect(out).toEqual({ error: 'unexpected extra argument(s): extra' })
  })
})

describe('capture_gate_cli report', () => {
  const ok: GateResult = { id: 1, ok: true, mismatches: [], totals: { grid: 0, defs: 0, pipes: 0, chars: 0, palette: 0 }, overflow: [], allowed: [] } // prettier-ignore
  const bad: GateResult = { ...ok, id: 2, ok: false, unavailable: 'no capture' }

  it('exits 0 when every map is clean', () => {
    expect(report([ok]).exitCode).toBe(0)
  })

  it('exits 1 when any map is not ok', () => {
    expect(report([ok, bad]).exitCode).toBe(1)
  })

  it('--known: a map matching the known count and hash exits 0 instead of 1', () => {
    const m = { table: 'grid' as const, cell: '1,1', expected: '$1', actual: '$2' }
    const known: KnownEntry = { map: '$002', table: 'grid', count: 1, sha256: hashOf([m]) }
    const result: GateResult = { id: 2, ok: false, mismatches: [m], totals: { ...ok.totals, grid: 1 }, overflow: [], allowed: [] } // prettier-ignore
    expect(matchesKnown(result, [known])).toBe(true)
    expect(report([result], [known]).exitCode).toBe(0)
  })

  it('--known: a count or hash mismatch still exits 1 (a moved cell is not silently accepted)', () => {
    const m = { table: 'grid' as const, cell: '1,1', expected: '$1', actual: '$2' }
    const moved = { ...m, cell: '9,9' }
    const known: KnownEntry = { map: '$002', table: 'grid', count: 1, sha256: hashOf([m]) }
    const result: GateResult = { id: 2, ok: false, mismatches: [moved], totals: { ...ok.totals, grid: 1 }, overflow: [], allowed: [] } // prettier-ignore
    expect(matchesKnown(result, [known])).toBe(false)
    expect(report([result], [known]).exitCode).toBe(1)
  })

  it('F1: --known never accepts an unavailable map with no fixture entry (exits 1, not silently 0)', () => {
    // prettier-ignore
    const result: GateResult = { ...ok, id: 2, ok: false, unavailable: 'no capture found' }
    expect(matchesKnown(result, [])).toBe(false)
    expect(report([result], []).exitCode).toBe(1)
  })

  it('F1: --known never accepts an unavailable map even when SOME OTHER map has a fixture entry', () => {
    // prettier-ignore
    const known: KnownEntry = { map: '$099', table: 'grid', count: 1, sha256: 'irrelevant' }
    const result: GateResult = { ...ok, id: 2, ok: false, unavailable: 'no capture found' }
    expect(matchesKnown(result, [known])).toBe(false)
  })

  it('X08: a real mismatch with no fixture entry for its map/table exits 1 (the !entry check, not entry &&)', () => {
    // prettier-ignore
    const m = { table: 'grid' as const, cell: '1,1', expected: '$1', actual: '$2' }
    const result: GateResult = { id: 2, ok: false, mismatches: [m], totals: { ...ok.totals, grid: 1 }, overflow: [], allowed: [] } // prettier-ignore
    // No known entries at all for map $002 - a mutant flipping `!entry ||` to
    // `entry &&` would short-circuit false here and let the loop conclude
    // "matches" by default; the real check must refuse it instead.
    expect(matchesKnown(result, [])).toBe(false)
    expect(report([result], []).exitCode).toBe(1)
  })
})

describe('checkGrid: BOSS_ARENA_SCREENS in the extent (X13)', () => {
  it('a boss-arena extent (BOSS_ARENA_SCREENS*16), not the level header length, bounds the comparison', () => {
    // prettier-ignore
    // Modes 9/11 render 2 screens regardless of the header's levelLength=1;
    // the extent passed in must reflect the REAL exported constant, not a
    // hardcoded "32" that would silently agree with a wrong constant too.
    const extent = BOSS_ARENA_SCREENS * 16
    const cols = extent
    const meta: GridMeta = { orientation: 'horizontal', screens: BOSS_ARENA_SCREENS, bytesPerScreen: 16, lowOffset: 0, highOffset: cols, base: 0 } // prettier-ignore
    const grid = new Uint8Array(cols * 2) // all zero: id 0 everywhere
    const romGrid = [new Array(cols).fill(0)]
    const { mismatches } = checkGrid(romGrid, grid, meta, extent, false)
    expect(mismatches).toEqual([])
  })
})

/** A ROM stub whose `getLevelRawData` returns bytes, so `gateMap` reaches its capture-side checks - none of the four refusals below touch any other ROM method. */ // prettier-ignore
function stubRomWithLevelData(): SmwRom {
  return { getLevelRawData: () => Buffer.from([0]) } as unknown as SmwRom
}

describe('gateMap: capture-side refusals (F2)', () => {
  const rom = stubRomWithLevelData()
  const paletteAnim = new Map()
  const read = (files: Record<string, Buffer>) => (n: string) => files[n] ?? null

  it('loadLevel failure (no capture_summary.json) -> unavailable, not ok or a default', () => {
    const files = captureFiles()
    delete files['capture_summary.json']
    const result = gateMap(rom, paletteAnim, 0x105, read(files))
    expect(result.ok).toBe(false)
    expect(result.unavailable).toBeDefined()
  })

  it('BG12NBA_210B missing from ppu.json -> unavailable, not ok or a default', () => {
    const files = captureFiles()
    const ppu = JSON.parse(files['ppu.json']!.toString('utf8'))
    delete ppu.BG12NBA_210B
    files['ppu.json'] = Buffer.from(JSON.stringify(ppu))
    const result = gateMap(rom, paletteAnim, 0x105, read(files))
    expect(result.ok).toBe(false)
    expect(result.unavailable).toMatch(/BG12NBA/)
  })

  // `loadLevel` itself already requires a valid, parseable map16_pipe_writes.json
  // (it runs the same `pipeInfo` before `level.data` exists at all), so a
  // Reader that always answers the same way for that file never reaches
  // gateMap's OWN re-read: it refuses one layer up first, on the identical
  // reason. To reach gateMap's own checks specifically, the Reader answers
  // loadLevel's read (the first) with the real file and gateMap's own
  // second read of the same name differently.
  function readThenChange(files: Record<string, Buffer>, name: string, second: Buffer | null) {
    let calls = 0
    return (n: string): Buffer | null => {
      if (n !== name) return files[n] ?? null
      calls++
      return calls === 1 ? (files[n] ?? null) : second
    }
  }

  it("gateMap's own re-read finding map16_pipe_writes.json gone -> unavailable, not ok or a default", () => {
    // prettier-ignore
    const files = captureFiles()
    const result = gateMap(rom, paletteAnim, 0x105, readThenChange(files, 'map16_pipe_writes.json', null)) // prettier-ignore
    expect(result.ok).toBe(false)
    expect(result.unavailable).toBe('map16_pipe_writes.json missing')
  })

  it("gateMap's own re-read finding map16_pipe_writes.json corrupted -> unavailable, not ok or a default", () => {
    // prettier-ignore
    const files = captureFiles()
    const corrupt = Buffer.from(JSON.stringify({ foo: 'bar' })) // valid JSON, but none of pipeInfo's required fields
    const result = gateMap(rom, paletteAnim, 0x105, readThenChange(files, 'map16_pipe_writes.json', corrupt)) // prettier-ignore
    expect(result.ok).toBe(false)
    expect(result.unavailable).toBe('map16_pipe_writes.json unreadable')
  })
})
