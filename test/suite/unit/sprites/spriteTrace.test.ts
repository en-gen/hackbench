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
import { runUntil } from '../../../../src/rom/cpu/call'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { recordWrites, smwMachine } from '../../../../src/rom/sprites/interp/Machine'
import type { RomFile } from '../../../../src/rom/RomFile'
import { freshRom, hasRom, SPRITE_TRACE_SET, TOOLS_ROOT, VANILLA } from '../../support/corpus'

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

function replay(rom: RomFile, root: string, map: string, wram: Buffer, c: Call) {
  const pre = wram.subarray(c.wram * 0x2000, (c.wram + 1) * 0x2000)
  const { bus, cpu } = smwMachine(rom, pre)
  bus.wram.set(readFileSync(join(root, map, 'map16_7ec800.bin')), 0xc800)
  bus.wram.set(readFileSync(join(root, map, 'map16_7fc800.bin')), 0x1c800)
  // The recorder drops PPU writes it could not log ($2100-$21FF), so those are not compared;
  // WRAM addresses are 24-bit, so the one bound keeps them all.
  const { log: got } = recordWrites(bus, a => a >= 0x2200)
  let lastOp = 0
  const guard = bus.onInstruction
  bus.onInstruction = (a, op) => {
    lastOp = op
    guard?.(a, op)
  }
  Object.assign(cpu, { e: !!c.regs.e, d: c.regs.d, db: c.regs.db, pb: c.regs.pb, pc: c.regs.pc, s: c.regs.s, a: c.regs.a, x: c.regs.x, y: c.regs.y }) // prettier-ignore
  cpu.p = c.regs.p
  // Mid-routine entry from a recorded register set: no return frame, so run to the RTS at the recorded exit S.
  const r = runUntil(cpu, 400_000, k => k.s === c.exitS && k.pb === c.regs.pb && lastOp === 0x60)
  const err = r.kind === 'refused' ? r.reason : ''
  const want = c.writes.map(w => w >>> 0)
  let k = 0
  while (k < want.length && k < got.length && want[k] === got[k]) k++
  const ok = !err && r.kind === 'returned' && k === want.length && k === got.length
  const first = ok ? undefined : `${err} diverge@${k}/${want.length} want ${fmt(want[k])} got ${fmt(got[k])}` // prettier-ignore
  return { ok, first, n: want.length }
}

describe.skipIf(!existsSync(join(TRACE_DIR, SPRITE_TRACE_SET)) || !hasRom(VANILLA))(
  'sprite call replay vs Mesen traces',
  () => {
    const root = join(TRACE_DIR, SPRITE_TRACE_SET)
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
      // Exact, not a floor: a floor of 0.97 let the #593 low-first 16-bit RMW order back in
      // (1099 equal, tests green). This comparator seeds only Mesen's $7E:0000-$1FFF and Map16
      // (no hi-WRAM windows), so 1566 of 1578 is its number (1110 of 1122 before the #649 re-capture
      // of the 45 castle-entry maps added 456 calls, all write-for-write equal); the spike comparator
      // (spikes/sprite-oracle/oracle/compare_sprite_trace.mts), which seeds those windows too,
      // printed 1122 of 1122 on the old set (not re-run on the new one). The 12 misses are named so a change in WHICH calls miss is red too:
      // id $49 on map 0c3 and id $86 on maps 11e and 126, state the fixtures do not carry.
      expect(results.length).toBe(1578)
      expect(okN).toBe(1566)
      expect(results.filter(r => !r.ok).map(r => `${r.map}:${r.i}`)).toEqual([
        '0c3:4', '0c3:7', '0c3:10', '0c3:13', // prettier-ignore
        '11e:1', '11e:2', '11e:3', '11e:4',
        '126:1', '126:2', '126:3', '126:4',
      ]) // prettier-ignore
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
    // what Mesen held when the level's sprites ran. Measured 2026-10-09, vanilla, one
    // machine: both Map16 tables byte-identical on 131 of 154 maps. The other 23 are pinned in
    // levelStateVsMesen.test.ts: 5 differ only past the level's end, 18 are boss arenas (the
    // capture holds the game's arena fill, which the loader does not run). The 63 in-level
    // differences of 2026-10-05 were the harness reading Map16 in the castle-entry scene (#649). every header and Mario-entrance
    // cell equal on every map whose WRAM image was recorded. Asserted as floors, with the
    // counts checked non-empty so a comparison of nothing cannot pass.
    it('ROM-run level loader against Mesen level state', () => {
      const rom = freshRom()
      const cells = [0x5b, 0x5d, 0x64, 0x71, 0x76, 0x82, 0x83, 0x85, 0x86, 0x1692, 0x190e, 0x19, 0x187a, 0x1404, 0x1e, 0x20, ...Array.from({ length: 8 }, (_, i) => 0x1462 + i)] // prettier-ignore
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
      expect(identical).toBe(131)
      // The Iggy/Larry rooms (levels $096 $097 $196 $197) hold $FF90 in NextLayer1YPos
      // ($1464/$1465) in Mesen: GM12PrepLevel reaches CODE_0097BC (bank_00.asm:4854 -> 4863, IRQNMICommand
      // bit 7) -> 2763 (BVC .IggyLarry) -> 2793-2795, which stores -112. GM12 is part of level load
      // but not GM11, which the loader runs, so these cells stay unequal. $5E is not compared: CODE_0584E3
      // rewrites it (bank_05.asm:560) after GM11's STA $5E, so it matched before and after. Named so a
      // change in WHICH cells miss, or in the value, is red. Measured 2026-10-07, vanilla, one machine;
      // before the GM11 spans were run the same comparison missed 307 cells over 98 maps.
      const boss = ['096', '097', '196', '197']
      expect(badCells).toEqual(boss.flatMap(m => [`${m} cell 1464`, `${m} cell 1465`]))
      for (const m of boss) {
        const w = readFileSync(join(root, m, 'wram.bin'))
        expect([w[0x1464], w[0x1465]]).toEqual([0x90, 0xff])
      }
    }, 300_000)
  },
)

const fmt = (w: number | undefined): string => (w === undefined ? 'none' : `${(w >>> 8).toString(16)}=${(w & 255).toString(16)}`) // prettier-ignore
