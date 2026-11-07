/**
 * What the game's own level load does with a sprite-list entry (#1011): a shooter, a generator and a scroll command are
 * routed away from the sprite slots and have no sprite of their own to draw (SMWDisX bank_02.asm:5223-5368, called at
 * :1410).
 *
 * The class is read by its effect: the ROM's own routine runs on the 65816 core, once per id, and the first of the cells
 * it writes (rammap.asm:1566 scroll command, :1873 generator, :1789 shooter slots) names the class. A run or a table
 * that proves nothing makes the result `status: 'unavailable'` with a reason, and the caller then runs the id as a
 * sprite: a call or stretch that is not the game's, a refused run, no routed or no normal id, or bands that do not hold.
 * The method, its limits and the evidence: docs/rom/map-data-mechanics.md, "How the level load routes a sprite-list
 * entry (#1011)".
 */
import {
  Refusal,
  SENTINEL,
  callSubroutine,
  nativeReset,
  runUntil,
  type CallResult,
} from '../../cpu/call'
import type { Cpu65816 } from '../../cpu/Cpu65816'
import type { RomFile } from '../../RomFile'
import { mapperProblem } from './Guards'
import { RunCache, smwMachine } from './Machine'

export type LoadClass = 'normal' | 'shooter' | 'generator' | 'scroll'

export type LoadClasses =
  | { status: 'ok'; of: (id: number, extraBits?: boolean) => LoadClass }
  | { status: 'unavailable'; reason: string }

/** The call in the sprite main loop (bank_02.asm:1410): one JSR opcode, whose operand is the routine. */
const CALL_SITE = 0x028b1d
const JSR = 0x20
/**
 * The main loop's own routine, CODE_028AB1 (bank_02.asm:1355, reached by JSL at bank_00.asm:4535): the stretch runs from its
 * fixed start on zeroed state with each seed set below. It ends in RTL, but the run stops at the loader's call, before that.
 */
const STRETCH_AT = 0x028ab1
/**
 * Cells each stretch run seeds (rammap.asm), one run per set. Sparkle timer :1890 = 2 takes the JSL at bank_02.asm:1389-1401,
 * which zero state skips. Lives :1908 = 2 and star :1635 = $FF run the lives branch (:1361-1373) and the star branch it falls
 * into (:1377-1387); lives = 1 with timer :1909 = 1 runs the countdown (:1363-1364).
 */
const STRETCH_SEEDS: Record<number, number>[] = [
  { 0x18d3: 2 },
  { 0x18e4: 2, 0x1490: 0xff },
  { 0x18e4: 1, 0x18e5: 1 },
]
/** Instructions the stretch may take: the vanilla run is a few hundred, and a callee that loops is refused. */
const STRETCH_CAP = 10_000
/** The routine opens with a load of a direct-page cell (bank_02.asm:5224). */
const LDA_DP = 0xa5
const BANK2 = 0x020000
/** The routine reads its tables with absolute-word operands, so DB is its own bank. */
const ENTRY_DB = 2
/** Instructions one id may take; the longest vanilla run is far below it, and a hack that loops is refused. */
const STEP_CAP = 50_000
// RAM cells (rammap.asm): the scroll command (:1566), the generator number (:1873), the 8 shooter slots (:1789).
const SCROLL_CMD = 0x143e
const GENERATOR = 0x18b9
const SHOOTER_TABLE = 0x1783
const SHOOTER_SLOTS = 8
// Seeds: the list pointer (:939), the scroll direction whose boundary offset is zero (:435), where the list sits in WRAM.
const SPRITE_DATA_PTR = 0xce
const SCROLL_DIR = 0x55
const LIST_AT = 0xe000
const WRAM_BANK = 0x7e
const BOUNDARY_ZERO = 1
const LIST_END = 0xff
/** The entry's flags byte holds the extra bits; bit 3 is the one that moves ids on some hacks (measured). */
const EXTRA_BIT_3 = 0x08
const [FLAGS_AT, ID_AT, END_AT] = [1, 3, 4]

/** One id's verdict: its class and the value the decisive write stored (0 for a normal one). */
interface Row {
  cls: LoadClass
  value: number
}

/** The class the cell `off` of WRAM belongs to, or null. */
const classOfCell = (off: number): LoadClass | null =>
  off === SCROLL_CMD
    ? 'scroll'
    : off === GENERATOR
      ? 'generator'
      : off >= SHOOTER_TABLE && off < SHOOTER_TABLE + SHOOTER_SLOTS
        ? 'shooter'
        : null

/** An unreadable loader, with the reason. */
const fail = (reason: string): LoadClasses => ({ status: 'unavailable', reason })

/** The routine's address from the call site, or why this ROM's call cannot be followed. */
function entryOf(rom: RomFile): number | string {
  const site = rom.readAt(CALL_SITE, 3)
  if (!site || site[0] !== JSR)
    return 'the sprite main loop does not call the level loader at the place it does in the game'
  const entry = BANK2 | site[1]! | (site[2]! << 8)
  return rom.readAt(entry, 1)?.[0] === LDA_DP
    ? entry
    : "the level loader's call goes to something that does not open the way the loader does"
}

/**
 * Runs the main loop's stretch before the call on the core (the calls run as ROM code, none is restated here) and
 * returns why it does not arrive at the loader's entry as the site's own JSR would, or null: at that JSR's stack depth,
 * holding its return address (the address of its last byte), under the routine's own PHB. A plain jump or call from a callee, or a pop out of it,
 * fails one of those; a hook that returns normally still arrives, and nothing above the stretch is run.
 */
function stretchProblem(
  cpu: Cpu65816,
  entry: number,
  seeds: Record<number, number>,
): string | null {
  nativeReset(cpu)
  cpu.a = cpu.x = cpu.y = 0 // nativeReset leaves them: a pass starts from the last one's
  for (const [cell, value] of Object.entries(seeds)) cpu.bus.write(+cell, value)
  cpu.db = ENTRY_DB
  cpu.pb = STRETCH_AT >> 16
  cpu.pc = STRETCH_AT & 0xffff
  const s0 = cpu.s
  const at = (c: Cpu65816) => c.pc === (entry & 0xffff) && (c.pb & 0x7f) === BANK2 >> 16
  const pushed = (c: Cpu65816) => c.bus.read(c.s + 1) | (c.bus.read(c.s + 2) << 8)
  const arrived = (c: Cpu65816) =>
    at(c) && c.s === s0 - 3 && pushed(c) === (CALL_SITE + 2) % 0x10000
  const off = (c: Cpu65816): CallResult | null =>
    c.s > s0 || (at(c) && !arrived(c)) ? { kind: 'refused', reason: '', at: 0, steps: 0 } : null
  const r = runUntil(cpu, STRETCH_CAP, arrived, off)
  return r.kind === 'returned'
    ? null
    : "the sprite main loop does not reach the level loader's call"
}

/** Whether a call ended at its return; a stack-balanced arrival at the return address in another bank's mirror of bank 2 counts. */
const returned = (r: CallResult, cpu: Cpu65816): boolean =>
  r.kind === 'returned' ||
  (r.kind === 'unbalanced' &&
    cpu.pc === SENTINEL &&
    r.s === r.expected &&
    (r.pb & 0x7f) === (r.expectedPb & 0x7f))

/** Why a run that decided nothing did not return. */
const whyNot = (r: CallResult): string =>
  r.kind === 'refused'
    ? r.reason
    : r.kind === 'budget'
      ? `did not return within ${STEP_CAP} steps`
      : 'returned with the stack or the bank wrong'

/** The first thing wrong with the bands the 256 runs gave, or null: some routed and some normal ids, then per class one run of at least two ids, in order, each value stepping with its id. */
function bandsProblem(rows: Row[]): string | null {
  const routed = rows.filter(r => r.cls !== 'normal').length
  if (routed === 0 || routed === rows.length) return 'the runs do not tell routed ids from sprites'
  let after = -1
  for (const cls of ['shooter', 'generator', 'scroll'] as const) {
    const ids = rows.flatMap((r, id) => (r.cls === cls ? [id] : []))
    if (!ids.length) continue
    const [first, last] = [ids[0]!, ids[ids.length - 1]!]
    if (last - first + 1 !== ids.length) return `the ${cls} ids are not one run`
    if (first <= after) return `the ${cls} ids do not come after the earlier class`
    // One id has nothing to step against, so a single flat value could be any cell write.
    if (ids.length < 2) return `the ${cls} ids are a single id, so its value cannot be checked`
    if (ids.some(id => rows[id]!.value - id !== rows[first]!.value - first))
      return `the ${cls} value does not step with the id`
    after = last
  }
  return null
}

const cache = new RunCache<LoadClasses>()

/** The game's own routing of a sprite-list id, read from this ROM by running its routine (or why it cannot be read). Cached by the ROM bytes the runs read. */
export function loadClasses(rom: RomFile): LoadClasses {
  // Neither check is a bus read, so neither can be left to the cache's key.
  const entry = entryOf(rom)
  if (typeof entry === 'string') return fail(entry)
  const mapper = mapperProblem(rom)
  if (mapper) return fail(mapper)
  const key = `loadClasses ${entry}`
  return cache.lookup(rom, key) ?? run(rom, entry, key)
}

/** Runs the routine for each id, then the scroll ids again with extra bit 3 set, on one machine put back between runs, and remembers the verdict. */
function run(rom: RomFile, entry: number, key: string): LoadClasses {
  const { bus, cpu } = smwMachine(rom)
  cache.track(bus, rom)
  // The stretch runs on zeroed state with the cell hooks off (a write to a routing cell here means nothing), then the
  // machine is put back, so nothing it left reaches the sweeps. Seeds: DB = 2 and WRAM zero; the sweeps' seeds are not needed.
  const blank = bus.snapshot()
  for (const seeds of STRETCH_SEEDS) {
    const unreached = stretchProblem(cpu, entry, seeds)
    if (unreached) return cache.store(rom, key, bus, fail(unreached))
    bus.restore(blank)
  }
  const w = bus.wram
  w[SCROLL_DIR] = BOUNDARY_ZERO
  w.set([LIST_AT & 0xff, LIST_AT >> 8, WRAM_BANK], SPRITE_DATA_PTR)
  w[LIST_AT + END_AT] = LIST_END // the list is: a header byte, then flags, x and id, then the end mark
  const seeded = bus.snapshot()
  const seen: { row: Row | null; read: boolean } = { row: null, read: false }
  bus.onRead = off => {
    if (off === LIST_AT + ID_AT) seen.read = true
  }
  bus.onWramWrite = (off, value) => {
    const cls = classOfCell(off)
    if (!cls) return
    seen.row = { cls, value }
    throw new Refusal('decided') // the class is known at the first write; what follows is not run
  }
  /** One row per id of `ids`, run with `flags` in the entry, or why the runs prove nothing. */
  const sweep = (flags: number, ids: number[]): Row[] | string => {
    const rows: Row[] = []
    for (const id of ids) {
      bus.restore(seeded) // WRAM, SRAM and the multiply units: no run sees an earlier run's state
      w[LIST_AT + FLAGS_AT] = flags
      w[LIST_AT + ID_AT] = id
      seen.row = null
      seen.read = false
      const regs = { db: ENTRY_DB, a: 0, x: 0, y: 0 }
      const r = callSubroutine(cpu, entry, { kind: 'jsr', maxSteps: STEP_CAP, regs })
      const at = `id $${id.toString(16).toUpperCase().padStart(2, '0')}`
      // A run that never read the entry decided nothing about it, whatever it wrote or returned.
      if (!seen.read) return `${at}: the routine finished without reading the list entry`
      if (seen.row) rows.push(seen.row)
      else if (returned(r, cpu)) rows.push({ cls: 'normal', value: 0 })
      else return `${at}: ${whyNot(r)}`
    }
    return rows
  }
  const plain = sweep(
    0,
    Array.from({ length: 256 }, (_, id) => id),
  )
  const bad = typeof plain === 'string' ? plain : bandsProblem(plain)
  if (bad || typeof plain === 'string') return cache.store(rom, key, bus, fail(bad!))
  // With bit 3 set, only the plain scroll ids are run again: it stays a scroll command only if every one stores the same value
  // in the same cell. Any other id gets no exemption from the extra-bits gate, so its box stays.
  const scrolls = plain.flatMap((r, id) => (r.cls === 'scroll' ? [id] : []))
  const again = sweep(EXTRA_BIT_3, scrolls)
  // All or nothing: one id that differs means the bit changes what the routine does with scroll ids, so none is trusted.
  const agree =
    typeof again !== 'string' &&
    scrolls.every((id, k) => again[k]!.cls === 'scroll' && again[k]!.value === plain[id]!.value)
  const exempt = new Set(agree ? scrolls : [])
  const result: LoadClasses = {
    status: 'ok',
    of: (id, extraBits) =>
      extraBits ? (exempt.has(id) ? 'scroll' : 'normal') : (plain[id]?.cls ?? 'normal'),
  }
  return cache.store(rom, key, bus, result)
}
