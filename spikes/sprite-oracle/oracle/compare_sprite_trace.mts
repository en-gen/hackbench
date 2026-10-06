/**
 * Comparator: replays every call recorded by spikes/sprite-oracle/mesen/sprite_routine_trace.lua
 * (level or spawn fixtures) through hackbench's 65816 core and diffs the
 * core's write log against Mesen's.
 *
 *   tsx compare_sprite_trace.mts <fixture dir> [more dirs...]
 *     --core <Cpu65816.ts>   (default: env HB_CPU_CORE, else the repo's src/rom/cpu/Cpu65816.ts)
 *     --rom  <rom>           (default: env HB_ROM)
 *     --json <out.json>      machine-readable results
 *
 * A fixture dir is one map (sprite-trace/<sha>/<map>) or one spawn id
 * (sprite-spawn/<sha>/<id>); give the parent and every child holding a
 * calls.json is used.
 *
 * Per call: seed the core with the recorded registers and the recorded WRAM
 * ($7E0000-$7E1FFF, also visible through the bank $00-$0F mirrors), the
 * recorded Map16 ($7EC800/$7FC800), the ROM read-only (LoROM), and a small
 * model of the hardware multiplier/divider ($4202-$4206 -> $4214-$4217, which
 * sprite code uses). Run from HandleSprite ($01:8127) until the loop's DEX at
 * $01:80B2 is next to execute (SMWDisX bank_01.asm:125-126), then compare the
 * ordered write logs byte for byte: (address, value) pairs.
 *
 * Verdicts: MATCH (identical logs), DIVERGED (first differing write, with the
 * instruction that produced it), COULD_NOT_RUN (core exception, step budget).
 * Reads of anything not seeded are counted and named; they are the likeliest
 * cause of a divergence and are reported as the cause when one precedes it.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runUntil } from '../../../src/rom/cpu/call.ts'

const args = process.argv.slice(2)
const opt = (n: string) => {
  const i = args.indexOf(n)
  if (i < 0) return undefined
  return args.splice(i, 2)[1]
}
const repoCore = join(import.meta.dirname, '..', '..', '..', 'src', 'rom', 'cpu', 'Cpu65816.ts')
const corePath = resolve(opt('--core') ?? process.env.HB_CPU_CORE ?? repoCore)
const romPath = opt('--rom') ?? process.env.HB_ROM ?? ''
const jsonOut = opt('--json')
if (!existsSync(corePath) || !existsSync(romPath) || args.length === 0) {
  console.error('usage: compare_sprite_trace.mts <fixture dir>... --core <Cpu65816.ts> --rom <rom> [--json out]')
  process.exit(2)
}
const rom = readFileSync(romPath)
const { Cpu65816 } = await import(pathToFileURL(corePath).href)

const HANDLE_SPRITE = 0x018127
const LOOP_NEXT = 0x0180b2
const STEP_BUDGET = 400_000
const WRAM_LO = 0x2000

interface Call {
  i: number
  frame: number
  kind: string
  slot: number
  id: number
  status: number
  regs: { a: number; x: number; y: number; s: number; d: number; db: number; p: number; e: number; pc: number; pb: number }
  writes: number[]
  nmi: number
  irq?: number
  unlogged: number
  exitS: number
}
interface Frame {
  f: number
  owners: number[]
  ppu: Record<string, number>
  cam: Record<string, number>
}

type Verdict = 'MATCH' | 'DIVERGED' | 'COULD_NOT_RUN'
export interface Result {
  dir: string
  call: number
  frame: number
  id: number
  slot: number
  kind: string
  verdict: Verdict
  cause: string
  /** index of the first differing write, expected/got packed (addr<<8|value) */
  at?: number
  expected?: number
  got?: number
  pc?: number
  opcode?: number
  steps: number
  tainted: boolean
  interrupted: number
  unseededReads: string[]
  oam?: OamGrade
  /** adjacent write pairs that matched only after swapping (16-bit read-modify-write order) */
  /** slot position after the call: Mesen's (entry WRAM + its write log) vs the core's */
  pos?: { ok: boolean; expected: number[]; got: number[] }
}
interface OamGrade {
  entries: number
  mismatches: { idx: number; field: string; expected: number; got: number }[]
}

const hex = (n: number, w = 2) => n.toString(16).toUpperCase().padStart(w, '0')


function loadDir(dir: string) {
  const calls: Call[] = JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8'))
  const frames: Frame[] = existsSync(join(dir, 'frames.json')) ? JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')) : []
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { hiRegions?: number[][] }
  const hiRegions = meta.hiRegions ?? []
  return {
    calls,
    frames,
    hiRegions,
    hiLen: hiRegions.reduce((n, r) => n + r[1], 0),
    hi: existsSync(join(dir, 'wram_hi.bin')) ? readFileSync(join(dir, 'wram_hi.bin')) : Buffer.alloc(0),
    wram: readFileSync(join(dir, 'wram.bin')),
    m16lo: existsSync(join(dir, 'map16_7ec800.bin')) ? readFileSync(join(dir, 'map16_7ec800.bin')) : Buffer.alloc(0),
    m16hi: existsSync(join(dir, 'map16_7fc800.bin')) ? readFileSync(join(dir, 'map16_7fc800.bin')) : Buffer.alloc(0),
    oam: existsSync(join(dir, 'oam.bin')) ? readFileSync(join(dir, 'oam.bin')) : Buffer.alloc(0),
  }
}

function replay(fx: ReturnType<typeof loadDir>, call: Call, dirName: string, mod?: (cpu: any) => void): Result {
  const wram = new Uint8Array(fx.wram.subarray(call.i * WRAM_LO, (call.i + 1) * WRAM_LO))
  const entryWram = wram.slice()
  // Extra recorded WRAM windows (meta.hiRegions), per call, laid out back to back.
  const hiBuf = new Uint8Array(fx.hi.subarray(call.i * fx.hiLen, (call.i + 1) * fx.hiLen))
  // Writes to WRAM outside every recorded window (the LC_LZ2 output buffer at
  // $7EAD00+ that INIT of ids $29/$A0 fills, then copies back from) are kept
  // here so the routine reads its own output; a read of anything neither
  // recorded nor written is still reported as unseeded.
  const overlay = new Map<number, number>()
  const hiAt = (addr: number): number => {
    let o = 0
    for (const [start, len] of fx.hiRegions) {
      if (addr >= start && addr < start + len) return o + (addr - start)
      o += len
    }
    return -1
  }
  const got: number[] = []
  const gotPc: number[] = [], gotOp: number[] = []
  const unseeded: string[] = []
  let mulA = 0, mulB = 0, prod = 0, dvd = 0, wasDiv = false, quo = 0, rem = 0
  let lastPc = 0, lastOp = 0, steps = 0
  // unseededAt[k] = writes logged when unseeded[k] was first read, so a read can be blamed only for a write after it.
  const unseededAt: number[] = []
  const note = (s: string) => { if (unseeded.length < 8 && !unseeded.includes(s)) { unseeded.push(s); unseededAt.push(got.length) } }

  const bus = {
    read(addr: number): number {
      const bank = addr >> 16, off = addr & 0xffff
      if (bank === 0x7e || bank === 0x7f) {
        const h = hiAt(addr)
        if (h >= 0) return hiBuf[h]
        const o = overlay.get(addr)
        if (o !== undefined) return o
      }
      if (bank === 0x7e) {
        if (off < WRAM_LO) return wram[off]
        if (off >= 0xc800 && off - 0xc800 < fx.m16lo.length) return fx.m16lo[off - 0xc800]
        note('wram:7E' + hex(off, 4)); return 0
      }
      if (bank === 0x7f) {
        if (off >= 0xc800 && off - 0xc800 < fx.m16hi.length) return fx.m16hi[off - 0xc800]
        note('wram:7F' + hex(off, 4)); return 0
      }
      const lo = bank < 0x40 || (bank >= 0x80 && bank < 0xc0)
      if (lo && off < WRAM_LO) return wram[off]
      if (lo && off >= 0x2100 && off < 0x2200) { note('ppu:' + hex(off, 4)); return 0 }
      if (lo && off >= 0x4200 && off < 0x4400) {
        if (off === 0x4214) return quo & 0xff
        if (off === 0x4215) return (quo >> 8) & 0xff
        if (off === 0x4216) return (wasDiv ? rem : prod) & 0xff
        if (off === 0x4217) return ((wasDiv ? rem : prod) >> 8) & 0xff
        note('hw:' + hex(off, 4)); return 0
      }
      if (lo && off >= 0x8000) {
        const fo = (bank & 0x7f) * 0x8000 + (off - 0x8000)
        if (fo < rom.length) return rom[fo]
      }
      note('unmapped:' + hex(addr, 6)); return 0
    },
    write(addr: number, v: number): void {
      const bank = addr >> 16, off = addr & 0xffff
      let a: number
      if (bank === 0x7e || bank === 0x7f) a = addr
      else if (off < WRAM_LO && (bank < 0x40 || (bank >= 0x80 && bank < 0xc0))) a = 0x7e0000 + off
      else a = off
      // $2100-$21FF is dropped on the Mesen side (HDMA writes are indistinguishable there).
      if (a >= 0x2100 && a < 0x2200) return
      got.push(a * 256 + v); gotPc.push(lastPc); gotOp.push(lastOp)
      if (a >= 0x7e0000 && a < 0x7e0000 + WRAM_LO) wram[a - 0x7e0000] = v
      else if (a >= 0x7e0000) { const h = hiAt(a); if (h >= 0) hiBuf[h] = v; else overlay.set(a, v) }
      // Hardware multiplier/divider, as written by sprite code.
      if (a === 0x4202) mulA = v
      else if (a === 0x4203) { mulB = v; prod = mulA * mulB; wasDiv = false }
      else if (a === 0x4204) dvd = (dvd & 0xff00) | v
      else if (a === 0x4205) dvd = (dvd & 0xff) | (v << 8)
      else if (a === 0x4206) {
        if (v === 0) { quo = 0xffff; rem = dvd } else { quo = Math.floor(dvd / v); rem = dvd % v }
        wasDiv = true
      }
    },
    onInstruction(addr: number, op: number): void {
      lastPc = addr; lastOp = op
    },
  }
  const cpu = new Cpu65816(bus)
  const r = call.regs
  cpu.e = !!r.e
  cpu.p = r.p
  cpu.a = r.a; cpu.x = r.x; cpu.y = r.y; cpu.s = r.s; cpu.d = r.d; cpu.db = r.db
  cpu.pb = r.pb; cpu.pc = r.pc
  if (mod) mod(cpu)
  const base: Result = {
    dir: dirName, call: call.i, frame: call.frame, id: call.id, slot: call.slot, kind: call.kind,
    verdict: 'MATCH', cause: '', steps: 0, tainted: call.nmi > 0 || call.unlogged > 0, interrupted: (call.irq ?? 0) + call.nmi, unseededReads: unseeded,
  }
  // Mid-routine entry from recorded registers: no return frame, so run to the loop's DEX.
  let run
  try {
    run = runUntil(cpu, STEP_BUDGET, c => ((c.pb << 16) | c.pc) === LOOP_NEXT)
  } catch (e) {
    return { ...base, verdict: 'COULD_NOT_RUN', cause: String((e as Error).message ?? e), pc: lastPc, opcode: lastOp, steps }
  }
  steps = run.steps
  const stopped = run.kind === 'returned'
  if (!stopped && run.kind !== 'budget')
    return { ...base, verdict: 'COULD_NOT_RUN', cause: run.kind === 'refused' ? run.reason : run.kind, pc: lastPc, opcode: lastOp, steps }
  if (run.kind === 'budget')
    return { ...base, verdict: 'COULD_NOT_RUN', cause: 'step budget', pc: lastPc, opcode: lastOp, steps }
  base.steps = steps
  const exp = call.writes
  {
    const want = entryWram.slice()
    for (const w of exp) { const a = Math.floor(w / 256) - 0x7e0000; if (a >= 0 && a < WRAM_LO) want[a] = w & 255 }
    const at = (m: Uint8Array) => [m[0xe4 + call.slot] | (m[0x14e0 + call.slot] << 8), m[0xd8 + call.slot] | (m[0x14d4 + call.slot] << 8)]
    const e = at(want), g = at(wram)
    base.pos = { ok: e[0] === g[0] && e[1] === g[1], expected: e, got: g }
  }
  const n = Math.max(exp.length, got.length)
  // Write ORDER is compared as recorded: 16-bit read-modify-write (INC/DEC/ASL/LSR/ROL/ROR/TSB/TRB
  // on memory) writes the HIGH byte first on the hardware and in Mesen, and the core does too since
  // #593 (Cpu65816.ts). No swap is tolerated; a low-first core diverges here.
  for (let i = 0; i < n; i++) {
    if (exp[i] !== got[i]) {
      const cause =
        unseededAt.length > 0 && unseededAt[0] <= i
          ? 'unseeded read ' + unseeded[0]
          : got[i] === undefined
            ? 'core wrote fewer'
            : exp[i] === undefined
              ? 'core wrote more'
              : 'opcode ' + hex(lastOp)
      if (process.env.HB_DEBUG_CALL === dirName + ':' + call.i) {
        console.log('expected', exp.map(w => hex(Math.floor(w / 256), 6) + '=' + hex(w & 255)).join(' '))
        console.log('got     ', got.map((w, k) => hex(Math.floor(w / 256), 6) + '=' + hex(w & 255) + '@' + hex(gotPc[k], 6)).join(' '))
      }
      // The instruction that produced the first differing write when the core
      // wrote one; otherwise the last instruction it ran.
      const wpc = gotPc[i] ?? lastPc, wop = gotOp[i] ?? lastOp
      return { ...base, verdict: 'DIVERGED', cause: cause.startsWith('opcode') ? 'opcode ' + hex(wop) : cause, at: i, expected: exp[i], got: got[i], pc: wpc, opcode: wop }
    }
  }
  if (!stopped) return { ...base, verdict: 'COULD_NOT_RUN', cause: 'did not stop', pc: lastPc, opcode: lastOp }
  base.oam = gradeOam(fx, call, got, wram)
  return base
}

/** OAM parts: the entries this call wrote in the OAM buffer ($0200 table, $0420
 *  size/x8 bytes), graded against what the PPU held at the end of its frame. */
function gradeOam(fx: ReturnType<typeof loadDir>, call: Call, got: number[], _wram: Uint8Array): OamGrade | undefined {
  // The PPU's OAM at the end of frame f is the buffer DMA'd during frame f-1
  // (MEASURED: a y change in the buffer at frame 1 shows in PPU OAM at frame
  // 2), so the buffer a call wrote in frame f is graded against frame f+1.
  const frame = fx.frames[call.frame]
  if (call.frame < 0 || !frame || fx.oam.length < (call.frame + 2) * 544) return undefined
  const ppu = fx.oam.subarray((call.frame + 1) * 544, (call.frame + 2) * 544)
  const mine = new Map<number, { b: number[]; sz: number | undefined }>()
  for (const w of got) {
    const a = Math.floor(w / 256), v = w & 255
    if (a >= 0x7e0200 && a < 0x7e0400) {
      const idx = (a - 0x7e0200) >> 2, e = mine.get(idx) ?? { b: [-1, -1, -1, -1], sz: undefined }
      e.b[(a - 0x7e0200) & 3] = v
      mine.set(idx, e)
    } else if (a >= 0x7e0420 && a < 0x7e04a0) {
      const idx = a - 0x7e0420, e = mine.get(idx) ?? { b: [-1, -1, -1, -1], sz: undefined }
      e.sz = v
      mine.set(idx, e)
    }
  }
  const out: OamGrade = { entries: 0, mismatches: [] }
  for (const [idx, e] of mine) {
    // Only entries Mesen's own attribution says this call wrote last: a later
    // writer (another slot, the OAM reset) legitimately replaced the rest.
    if (frame.owners[idx] !== call.i) continue
    out.entries++
    const hi = ppu[512 + (idx >> 2)] >> ((idx & 3) * 2)
    const ppuSz = (hi >> 1) & 1, ppuX8 = hi & 1
    const f = (name: string, exp: number, gotv: number) => { if (exp >= 0 && exp !== gotv) out.mismatches.push({ idx, field: name, expected: gotv, got: exp }) }
    f('x', e.b[0], ppu[idx * 4]); f('y', e.b[1], ppu[idx * 4 + 1])
    f('char', e.b[2], ppu[idx * 4 + 2])
    f('attr(palette/flips/prio/charbit8)', e.b[3], ppu[idx * 4 + 3])
    if (e.sz !== undefined) { f('size', (e.sz >> 1) & 1, ppuSz); f('x8', e.sz & 1, ppuX8) }
  }
  return out
}

export function collect(root: string): string[] {
  if (existsSync(join(root, 'calls.json'))) return [root]
  return readdirSync(root).map(n => join(root, n)).filter(p => statSync(p).isDirectory() && existsSync(join(p, 'calls.json'))).sort()
}

export function runAll(dirs: string[], mod?: (cpu: any) => void): Result[] {
  const results: Result[] = []
  for (const d of dirs) {
    const fx = loadDir(d)
    for (const c of fx.calls) results.push(replay(fx, c, d.split(/[\\/]/).slice(-1)[0], mod))
  }
  return results
}

function summarise(results: Result[]) {
  const tally = (key: (r: Result) => string) => {
    const m = new Map<string, Record<Verdict, number>>()
    for (const r of results) {
      const row = m.get(key(r)) ?? { MATCH: 0, DIVERGED: 0, COULD_NOT_RUN: 0 }
      row[r.verdict]++
      m.set(key(r), row)
    }
    return m
  }
  const total = { MATCH: 0, DIVERGED: 0, COULD_NOT_RUN: 0 }
  for (const r of results) total[r.verdict]++
  const causes = new Map<string, number>()
  for (const r of results) if (r.verdict !== 'MATCH') causes.set(r.cause, (causes.get(r.cause) ?? 0) + 1)
  const oamMis = new Map<string, number>()
  let oamEntries = 0
  for (const r of results) {
    oamEntries += r.oam?.entries ?? 0
    for (const m of r.oam?.mismatches ?? []) oamMis.set(m.field, (oamMis.get(m.field) ?? 0) + 1)
  }
  return { total, causes: [...causes].sort((a, b) => b[1] - a[1]), byKind: tally(r => r.kind), byId: tally(r => hex(r.id)), oamEntries, oamMis: [...oamMis] }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('compare_sprite_trace.mts')) {
  const dirs = args.flatMap(a => collect(resolve(a)))
  const results = runAll(dirs)
  const s = summarise(results)
  console.log(`calls ${results.length}: MATCH ${s.total.MATCH}  DIVERGED ${s.total.DIVERGED}  COULD_NOT_RUN ${s.total.COULD_NOT_RUN}`)
  console.log('by kind:', JSON.stringify([...s.byKind]))
  console.log('top causes:', JSON.stringify(s.causes.slice(0, 12)))
  console.log('per id:', [...s.byId].map(([k, v]) => `${k}:${v.MATCH}/${v.DIVERGED}/${v.COULD_NOT_RUN}`).join(' '))
  console.log(`oam entries graded ${s.oamEntries}, mismatches by field`, JSON.stringify(s.oamMis))
  if (process.env.HB_TABLE) {
    const byDir = new Map<string, Result[]>()
    for (const r of results) byDir.set(r.dir, [...(byDir.get(r.dir) ?? []), r])
    console.log('per fixture (M match, D diverged, X could not run; frame order; "+" = OAM parts and position also right):')
    for (const [d, rs] of byDir) console.log(`  ${d}: ${rs.map(r => (r.verdict === 'MATCH' ? 'M' : r.verdict === 'DIVERGED' ? 'D' : 'X') + (r.verdict === 'MATCH' && r.oam && r.oam.mismatches.length === 0 && r.pos?.ok ? '+' : '')).join('')}`)
  }
  const posBad = results.filter(r => r.pos && !r.pos.ok).length
  console.log(`slot position wrong after the call: ${posBad}`)
  const tainted = results.filter(r => r.tainted).length
  console.log(`tainted calls (NMI inside, or write log incomplete): ${tainted}`)
  for (const r of results.filter(x => x.verdict !== 'MATCH').slice(0, 10))
    console.log(`  ${r.dir} call ${r.call} id ${hex(r.id)} ${r.kind} ${r.verdict} ${r.cause} write#${r.at} exp ${r.expected !== undefined ? hex(Math.floor(r.expected / 256), 6) + '=' + hex(r.expected & 255) : '-'} got ${r.got !== undefined ? hex(Math.floor(r.got / 256), 6) + '=' + hex(r.got & 255) : '-'} pc ${r.pc !== undefined ? hex(r.pc, 6) : '-'}`)
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary: { total: s.total, causes: s.causes, oamMis: s.oamMis }, results }, null, 1))
}
