/**
 * Replays each recorded sprite call (`sprite-trace` fixtures: Mesen logged
 * every WRAM write one HandleSprite call made, plus the WRAM image and
 * registers at its entry) on the 65816 core and compares the write sequence.
 * Gated on the fixtures and the vanilla ROM. Oracle only: the recorded state
 * is the seed here, never an input to the runner.
 *
 * Set SPRITE_TRACE_OUT to dump per-call results as JSON for classification.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Cpu65816 } from '../../../../src/rom/cpu/Cpu65816'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { SpriteBus } from '../../../../src/rom/sprites/interp/SpriteBus'
import type { RomFile } from '../../../../src/rom/RomFile'
import { freshRom, hasRom, TOOLS_ROOT, VANILLA } from '../../support/corpus'

const TRACE_DIR = process.env.HACKBENCH_SPRITE_TRACE ?? join(TOOLS_ROOT, 'fixtures', 'sprite-trace')

interface Call {
  i: number
  id: number
  kind: string
  slot: number
  exitS: number
  irq: number
  intWritesDropped: number
  regs: { a: number; d: number; db: number; e: number; p: number; pb: number; pc: number; s: number; x: number; y: number } // prettier-ignore
  wram: number
  writes: number[]
}

function romSha(): string | null {
  const dir = existsSync(TRACE_DIR) ? readdirSync(TRACE_DIR) : []
  return dir.length ? dir[0] : null
}

function replay(rom: RomFile, root: string, map: string, wram: Buffer, c: Call) {
  const pre = wram.subarray(c.wram * 0x2000, (c.wram + 1) * 0x2000)
  const bus = new SpriteBus(rom)
  bus.wram.set(pre)
  bus.wram.set(readFileSync(join(root, map, 'map16_7ec800.bin')), 0xc800)
  bus.wram.set(readFileSync(join(root, map, 'map16_7fc800.bin')), 0x1c800)
  const got: number[] = []
  bus.onWramWrite = (off, v) => got.push(((0x7e0000 + off) * 256 + v) >>> 0)
  // The recorder drops PPU writes it could not log ($2100-$21FF), so those are not compared.
  bus.onHwWrite = (reg, v) => {
    if (reg >= 0x2200) got.push(reg * 256 + v)
  }
  let lastOp = 0
  bus.onInstruction = (_a, op) => {
    lastOp = op
  }
  const cpu = new Cpu65816(bus)
  Object.assign(cpu, { e: !!c.regs.e, d: c.regs.d, db: c.regs.db, pb: c.regs.pb, pc: c.regs.pc, s: c.regs.s, a: c.regs.a, x: c.regs.x, y: c.regs.y }) // prettier-ignore
  cpu.p = c.regs.p
  let err = ''
  try {
    for (let n = 0; n < 400_000; n++) {
      cpu.step()
      if (cpu.s === c.exitS && cpu.pb === c.regs.pb && lastOp === 0x60) break
    }
  } catch (e) {
    err = String(e)
  }
  const want = c.writes.map(w => w >>> 0)
  let k = 0
  while (k < want.length && k < got.length && want[k] === got[k]) k++
  const ok = !err && k === want.length && k === got.length
  const first = ok ? undefined : `${err} diverge@${k}/${want.length} want ${fmt(want[k])} got ${fmt(got[k])}` // prettier-ignore
  return { ok, first, n: want.length }
}

describe.skipIf(!existsSync(TRACE_DIR) || !hasRom(VANILLA))(
  'sprite call replay vs Mesen traces',
  () => {
    const root = join(TRACE_DIR, romSha() ?? 'none')
    const each = (f: (map: string, wram: Buffer, c: Call) => void): void => {
      for (const map of readdirSync(root).sort()) {
        const cp = join(root, map, 'calls.json')
        if (!existsSync(cp)) continue
        const wram = readFileSync(join(root, map, 'wram.bin'))
        for (const c of JSON.parse(readFileSync(cp, 'utf8')) as Call[]) f(map, wram, c)
      }
    }

    it('replays every recorded call', () => {
      const rom = freshRom()
      const results: { map: string; i: number; id: number; kind: string; ok: boolean; first?: string; n: number }[] = [] // prettier-ignore
      each((map, wram, c) => {
        const r = replay(rom, root, map, wram, c)
        results.push({ map, i: c.i, id: c.id, kind: c.kind, ok: r.ok, first: r.first, n: r.n })
      })
      const okN = results.filter(r => r.ok).length
      const ids = new Set(results.map(r => r.id)).size
      console.log(`replayed ${results.length} calls over ${ids} sprite ids, ${okN} write-for-write equal`) // prettier-ignore
      if (process.env.SPRITE_TRACE_OUT) writeFileSync(process.env.SPRITE_TRACE_OUT, JSON.stringify(results, null, 1)) // prettier-ignore
      expect(results.length).toBeGreaterThan(0)
      // Floor, not a target: the misses are state the fixtures do not carry (WRAM above $2000
      // other than Map16). A regression in the core or bus drops this well below.
      expect(okN / results.length).toBeGreaterThan(0.97)
    }, 300_000)

    it('goes red when the ROM is planted with a defect', () => {
      const rom = freshRom()
      // HandleSprite starts LDA $14C8,X ($BD); a NOP there changes every call it makes.
      rom.writeAt(0x018127, [0xea])
      let tried = 0
      let equal = 0
      each((map, wram, c) => {
        if (tried >= 20) return
        tried++
        if (replay(rom, root, map, wram, c).ok) equal++
      })
      expect(tried).toBe(20)
      expect(equal).toBe(0)
    })

    // The level state the runner seeds from the ROM's own loader (LevelLoader.ts) against
    // what Mesen held when the level's sprites ran. Measured 2026-10-05, vanilla: both
    // Map16 tables byte-identical on 88 of 154 maps (3 more differ only past the level's
    // end, 63 differ inside it, cause not investigated), and every header and Mario-entrance
    // cell equal on every map whose WRAM image was recorded. Asserted as floors, with the
    // counts checked non-empty so a comparison of nothing cannot pass.
    it('ROM-run level loader against Mesen level state', () => {
      const rom = freshRom()
      const cells = [0x5b, 0x5d, 0x64, 0x71, 0x76, 0x82, 0x83, 0x85, 0x86, 0x1692, 0x190e, 0x19, 0x187a] // prettier-ignore
      let maps = 0
      let withWram = 0
      let identical = 0
      const badCells: string[] = []
      for (const map of readdirSync(root).sort()) {
        const lp = join(root, map, 'map16_7ec800.bin')
        if (!existsSync(lp)) continue
        const l = loadLevelState(rom, parseInt(map, 16))
        if (!l.ok) throw new Error(`${map}: ${l.reason}`)
        maps++
        const lo = readFileSync(lp)
        const hi = readFileSync(join(root, map, 'map16_7fc800.bin'))
        const same =
          Buffer.compare(Buffer.from(l.wram.subarray(0xc800, 0xc800 + lo.length)), lo) === 0 &&
          Buffer.compare(Buffer.from(l.wram.subarray(0x1c800, 0x1c800 + hi.length)), hi) === 0
        if (same) identical++
        const wp = join(root, map, 'wram.bin')
        const w = existsSync(wp) ? readFileSync(wp) : Buffer.alloc(0)
        if (w.length < 0x2000) continue
        withWram++
        for (const c of cells)
          if (l.wram[c] !== w[c]) badCells.push(`${map} cell ${c.toString(16)}`)
      }
      expect(maps).toBeGreaterThan(100)
      expect(withWram).toBeGreaterThan(50)
      expect(identical).toBeGreaterThanOrEqual(85)
      expect(badCells).toEqual([])
    }, 300_000)
  },
)

const fmt = (w: number | undefined): string => (w === undefined ? 'none' : `${(w >>> 8).toString(16)}=${(w & 255).toString(16)}`) // prettier-ignore
