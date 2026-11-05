/**
 * SpriteDispatch.ts -- where one ROM keeps its sprite INIT and MAIN pointer
 * tables, and what a given id resolves to. The tables are READ from the ROM's
 * own dispatch code (HandleSprite -> CallSpriteInit / CallSpriteMain), not
 * assumed at a vanilla address, so a hack that moved a table is followed.
 *
 * Fixed entry points, each byte-checked against the shape the runner depends
 * on and refused with a reason when it differs: the sprite loop ($01:808C,
 * `resolveLoop`, which also yields the setup and HandleSprite addresses),
 * InitSpriteTables ($07:F7D2, `checkInitTables`) and GetRand ($01:ACF9,
 * `checkGetRand`). SMWDisX bank_01.asm:110-127, bank_07.asm:1006,
 * bank_01.asm:6092. The level loader's entries are checked in LevelLoader.ts.
 */
import { mirror } from '../../addressing'
import type { RomFile } from '../../RomFile'
import { spanFingerprint } from '../../SubmapFlagGate'
import { Refusal, describe, nativeReset, runUntil } from '../../cpu/call'
import { bytesAt, shapeMatches } from './Guards'
import { recordWrites, RunCache, smwMachine, watchSram } from './Machine'

export const ENTRY = {
  /** JSL: ZeroSpriteTables + LoadSpriteTables (bank_07.asm:1006). */
  initSpriteTables: 0x07f7d2,
  /**
   * JSL: the game's own per-frame sprite loop. Sets DB to bank 1 (PHK PLB),
   * then for slots $0B..0 runs the OAM-index and timer setup and HandleSprite
   * (bank_01.asm:110-127). A routine that reads a bank-1 table through DB only
   * works under it, which is why the runner calls this and not HandleSprite.
   */
  spriteLoop: 0x01808c,
  /** Default HandleSprite address (bank_01.asm:181); `resolveLoop` reads the real one from the loop. */
  handleSprite: 0x018127,
  /**
   * JSL: CODE_0288DC (bank_02.asm:1097-1119), the item block spawn's dispatcher: by the content
   * index it either takes the free slot FindFreeSprSlot picks (egg, key, vine, balloon) or falls
   * to GenSpriteFromBlk (:1122), which writes the status and number, runs InitSpriteTables and
   * places the sprite and writes its cells (:1139-1292). `resolveBlockSpawn` fingerprints it (#566, #812).
   */
  blockSpawn: 0x0288dc,
  /** JSL: FindFreeSprSlot (bank_02.asm:5513), which the dispatcher calls for the egg, key, vine and balloon. */
  findFreeSprSlot: 0x02a9e4,
  /** JSL: GetRand, two steps of the RNG at `$148B/C` (bank_01.asm:6092). */
  getRand: 0x01acf9,
} as const

/** Entries in each table. Ids past this read bytes that are not pointers. */
export const SPRITE_TABLE_COUNT = 201

export interface SpriteTables {
  initTable: number
  mainTable: number
}

export type TablesResult = { ok: true; tables: SpriteTables } | { ok: false; reason: string }

const bytes = (rom: RomFile, a: number, n: number): number[] | null => bytesAt(rom, a, n)
const matches = shapeMatches

export type ShapeResult = { ok: true } | { ok: false; reason: string }

/** InitSpriteTables: JSL ZeroSpriteTables / JSL LoadSpriteTables / RTL (bank_07.asm:1006). */
export function checkInitTables(rom: RomFile): ShapeResult {
  const b = bytes(rom, ENTRY.initSpriteTables, 9)
  return matches(b, [0x22, null, null, null, 0x22, null, null, null, 0x6b])
    ? { ok: true }
    : { ok: false, reason: 'InitSpriteTables is not JSL / JSL / RTL' }
}

/**
 * A recognised build of the block spawn routine at `ENTRY.blockSpawn`: `length` bytes hashed as ONE contiguous
 * span (SHA-256, `spanFingerprint`) with the free operands zeroed. The JSL FindFreeSprSlot operand (3 bytes at
 * `callAt`) is read and checked on its own; `operands` are the other masked offsets (addresses a hack may
 * move). Branch displacements are hashed, so where each one lands is fixed by the fingerprint.
 */
export interface DispatcherSpan {
  length: number
  callAt: number
  operands: readonly number[]
  fingerprints: readonly string[]
}

/** The masked offsets of `span`: the JSL operand, then its other free operands. */
export const spanMask = (span: DispatcherSpan): number[] => [
  span.callAt,
  span.callAt + 1,
  span.callAt + 2,
  ...span.operands,
]

/**
 * CODE_0288DC to the sprite status write inside GenSpriteFromBlk (bank_02.asm:1097-1142): the dispatcher, the
 * free-slot search and the status write as one 81-byte span, 74 unknown after the 7 masked operands
 * (#566, #812, #1082). Evidence for the digest: the vanilla USA ROM, one read, one machine, 2026-10-18;
 * BlockSpawn.test.ts measures it on the corpus.
 */
export const BLOCK_SPAWN_DISPATCHER: DispatcherSpan = Object.freeze({
  length: 81,
  callAt: 34,
  operands: Object.freeze([71, 72, 76, 77]),
  fingerprints: Object.freeze(['53fd0df8db207572ceea5c312570fb43e1a13a8bbb097abbcc6253ca97d9dd38']),
})

/**
 * The block spawn's fixed shape (bank_02.asm:1097-1142): the whole span by fingerprint, then the FindFreeSprSlot
 * its masked JSL reaches. Anything else is refused. `dispatcher` replaces the real build for a synthetic ROM.
 */
export function resolveBlockSpawn(
  rom: RomFile,
  dispatcher: DispatcherSpan = BLOCK_SPAWN_DISPATCHER,
): { ok: true; entry: number } | { ok: false; reason: string } {
  const { length, callAt } = dispatcher
  const dispatch = rom.readAt(ENTRY.blockSpawn, length)
  const fp = spanFingerprint(dispatch, spanMask(dispatcher))
  if (fp === null || !dispatcher.fingerprints.includes(fp))
    return { ok: false, reason: 'the item block spawn dispatcher is not a build this reader knows' } // prettier-ignore
  // The operand is masked from the hash, so its call must reach the FindFreeSprSlot the game uses: the same address, with its own opening bytes.
  const call = dispatch![callAt]! | (dispatch![callAt + 1]! << 8) | (dispatch![callAt + 2]! << 16)
  if (call !== ENTRY.findFreeSprSlot || !matches(bytes(rom, call, 5), [0x64, 0x0e, 0x8b, 0x4b, 0xab]))
    return { ok: false, reason: 'the item block spawn dispatcher does not call the FindFreeSprSlot this reader knows' } // prettier-ignore
  return { ok: true, entry: ENTRY.blockSpawn }
}

/** GetRand: PHY LDY #1 JSL step DEY JSL step PLY RTL (bank_01.asm:6092). */
export function checkGetRand(rom: RomFile): ShapeResult {
  const b = bytes(rom, ENTRY.getRand, 14)
  // The two JSL banks are $01 or its FastROM mirror $81 (36 of 101 SMWC hacks); same code.
  const ok =
    matches(b, [
      0x5a,
      0xa0,
      0x01,
      0x22,
      null,
      null,
      null,
      0x88,
      0x22,
      null,
      null,
      null,
      0x7a,
      0x6b,
    ]) &&
    (b![6] & 0x7f) === 0x01 &&
    (b![11] & 0x7f) === 0x01
  return ok
    ? { ok: true }
    : { ok: false, reason: 'GetRand is not the two-step shape this runner knows' }
}

export type LoopResult = { ok: true; setup: number; handle: number } | { ok: false; reason: string }

/**
 * Checks the game's sprite loop at `ENTRY.spriteLoop` is the shape the runner
 * relies on (PHB PHK PLB, then a countdown over slots that does STX $15E9, JSR
 * setup, JSR handle) and RESOLVES the setup and HandleSprite addresses from its
 * two JSR operands. A loop that differs is refused, not guessed at.
 */
export function resolveLoop(rom: RomFile): LoopResult {
  const b = bytes(rom, ENTRY.spriteLoop, 64)
  if (!matches(b, [0x8b, 0x4b, 0xab])) return { ok: false, reason: 'sprite loop does not start PHB PHK PLB' } // prettier-ignore
  // LDX #$0B / STX $15E9 / JSR setup / JSR handle / DEX / BPL back
  const core = [0xa2, 0x0b, 0x8e, 0xe9, 0x15, 0x20, null, null, 0x20, null, null, 0xca, 0x10, 0xf4]
  // More than one match means we cannot say which one runs: unavailable, not a guess.
  const hits: number[] = []
  for (let i = 3; i + core.length <= b!.length; i++) if (matches(b!.slice(i), core)) hits.push(i)
  if (hits.length > 1)
    return { ok: false, reason: 'sprite loop countdown matches more than once; which one runs is unknown' } // prettier-ignore
  if (hits.length === 0)
    return { ok: false, reason: 'sprite loop is not the countdown shape this runner knows' }
  const i = hits[0]
  return { ok: true, setup: 0x010000 | (b![i + 6] | (b![i + 7] << 8)), handle: 0x010000 | (b![i + 9] | (b![i + 10] << 8)) } // prettier-ignore
}

/** WRAM table the ExecutePtr probe points its return frame at: 256 words, each one distinct. */
const PROBE_TABLE = 0x1000
const probeWord = (k: number): number => 0x9000 + k * 3
const PROBE_X = 0x2a
const PROBE_Y = 0x55
/** The game's ExecutePtr is 16 instructions; 48 leaves room for a hook, and a run past it is a different routine. */
const PROBE_STEPS = 48

/**
 * Per .claude/rules/rom-interpretation.md stock-code exception (added in #1030): a fixed entry, a step budget and a
 * refusal with a reason. The entry chain: HandleSprite (fixed, `ENTRY.handleSprite` or the loop's own JSR operand)
 * -> its JSL operand -> ExecutePtr. Runs the routine at `entry` the way a JSL to
 * ExecutePtr is called (bank_00.asm:847: A = index, the table inline after the call) for ALL 256 indices, and
 * returns null when it is the 16-bit pointer-table jump, else why not. Each index must land on that table word,
 * in the table's bank, with the call frame popped, X and Y kept, and no register or SRAM write. ExecutePtrLong
 * reads 24-bit entries and lands elsewhere for every index but 0. The table is our own, in WRAM.
 */
function notWordTableJump(rom: RomFile, entry: number): string | null {
  let m: ReturnType<typeof smwMachine>
  try {
    m = smwMachine(rom)
  } catch (e) {
    if (e instanceof Refusal) return e.message
    throw e
  }
  const { bus, cpu } = m
  for (let k = 0; k < 256; k++) {
    bus.wram[PROBE_TABLE + 2 * k] = probeWord(k) & 0xff
    bus.wram[PROBE_TABLE + 2 * k + 1] = probeWord(k) >> 8
  }
  const sram = watchSram(bus)
  for (let k = 0; k < 256; k++) {
    nativeReset(cpu)
    const s0 = cpu.s
    // The JSL frame: bank byte, then the address of the call's last byte (the table starts after it).
    for (const b of [0x7e, (PROBE_TABLE - 1) >> 8, (PROBE_TABLE - 1) & 0xff]) {
      bus.write(cpu.s, b)
      cpu.s = (cpu.s - 1) & 0xffff
    }
    cpu.a = k
    cpu.x = PROBE_X
    cpu.y = PROBE_Y
    cpu.pb = entry >>> 16
    cpu.pc = entry & 0xffff
    const want = probeWord(k)
    const r = runUntil(cpu, PROBE_STEPS, c => c.pb === 0x7e && c.pc === want)
    const why = describe(r, PROBE_STEPS)
    if (why) return `index ${k}: ${why}`
    if (cpu.s !== s0) return `index ${k}: the call frame was not popped (S=$${cpu.s.toString(16)})`
    if (cpu.x !== PROBE_X || cpu.y !== PROBE_Y) return `index ${k}: X or Y was not kept`
  }
  if (bus.hwWrites.size !== 0) return 'it wrote a hardware register'
  return sram.writes > 0 ? 'it wrote SRAM' : null
}

/** The dispatch JSLs (HandleSprite, CallSpriteMain) must reach one routine, and it must be the 16-bit ExecutePtr. */
export function checkExecutePtr(rom: RomFile, jsl: number[][]): ShapeResult {
  // Keys fold the FastROM mirror ($80+ is the same code); the read keeps the raw bank (#513, #704).
  const targets = jsl.map(t => (t[2] << 16) | (t[1] << 8) | t[0])
  // mirror() keys $7E and $FE alike, so a WRAM call must be refused before keying. The
  // test is the read's own mapping (readByte -> loromToOffset), not a bank-half rule: on a
  // 4 MB ROM $40:06FA is ROM, while WRAM and past-the-data addresses read null.
  if (targets.some(t => rom.readByte(t) === null))
    return { ok: false, reason: 'a dispatch call does not reach ROM' }
  if (new Set(targets.map(mirror)).size !== 1)
    return { ok: false, reason: 'the dispatch calls do not all reach the same routine' }
  const why = notWordTableJump(rom, targets[0])
  if (why)
    return { ok: false, reason: `the dispatch calls do not reach the 16-bit ExecutePtr: ${why}` }
  return { ok: true }
}

/** Slots the CallSpriteInit probe runs as, and its step budget (the game's routine is 5 instructions, a hook may add some). */
const INIT_SLOTS = [0, 5, 11]
const INIT_STEPS = 48
/** The JSL's own frame in page 1 of WRAM (S starts at $01FF): the only stack bytes the run may write. */
const FRAME = [0x7e01fd, 0x7e01fe, 0x7e01ff]

/**
 * Per the stock-code exception (#1030): fixed entry, step budget, refusal with a reason. The entry chain:
 * HandleSprite (fixed) -> the second word of its status table -> CallSpriteInit. Runs CallSpriteInit at `entry` for every sprite number 0..255 in several slots until it
 * reaches `execPtr` (the routine HandleSprite calls). Each run must arrive through a JSL frame with the number from
 * `number`,X as the index, and its only writes the run status (`runStatus`, the value HandleSprite compares with)
 * into `status`,X and the frame itself. Returns where the inline table starts, the same in every run, or why not.
 */
const initCache = new RunCache<{ table: number } | { reason: string }>()
function initTableOf(
  rom: RomFile,
  entry: number,
  execPtr: number,
  cells: { status: number; runStatus: number; number: number },
): { table: number } | { reason: string } {
  const key = [entry, execPtr, cells.status, cells.runStatus, cells.number].join(',')
  const hit = initCache.lookup(rom, key)
  if (hit) return hit
  let m: ReturnType<typeof smwMachine>
  try {
    m = smwMachine(rom)
  } catch (e) {
    if (e instanceof Refusal) return { reason: e.message }
    throw e
  }
  const { bus, cpu } = m
  initCache.track(bus, rom)
  const sram = watchSram(bus)
  const clean = bus.snapshot()
  let table = -1
  for (const slot of INIT_SLOTS) {
    for (let n = 0; n < 256; n++) {
      bus.restore(clean)
      // Every number is tried, so a read without X (cell 0, still zero) or with the wrong X shows.
      bus.wram[cells.number + slot] = n
      nativeReset(cpu)
      const s0 = cpu.s
      cpu.x = slot
      cpu.pb = entry >>> 16
      cpu.pc = entry & 0xffff
      sram.writes = 0
      const writes = recordWrites(bus)
      const r = runUntil(cpu, INIT_STEPS, c => mirror((c.pb << 16) | c.pc) === mirror(execPtr))
      writes.stop()
      const at = `sprite $${n.toString(16)}, slot ${slot}`
      const fail = (why: string) => initCache.store(rom, key, bus, { reason: `${at}: ${why}` })
      const why = describe(r, INIT_STEPS)
      if (why) return fail(why)
      // Arrival is judged by the read's own mapping too: $7E:86FA folds to the same key as $FE:86FA but is WRAM, not code.
      if (rom.readByte((cpu.pb << 16) | cpu.pc) === null) return fail('it ended outside ROM')
      if (cpu.s !== s0 - 3) return fail('it did not arrive through a JSL frame')
      if ((cpu.a & 0xff) !== n) return fail('the index was not the sprite number')
      const only = (0x7e0000 + cells.status + slot) * 256 + cells.runStatus
      const extra = writes.log.filter(w => !FRAME.includes(Math.floor(w / 256)))
      if (extra.length !== 1 || extra[0] !== only) return fail('it wrote more than the run status')
      if (sram.writes > 0) return fail('it wrote SRAM')
      const ret = bus.read(cpu.s + 1) | (bus.read(cpu.s + 2) << 8)
      const t = (bus.read(cpu.s + 3) << 16) | ((ret + 1) & 0xffff)
      if (table >= 0 && t !== table) return fail('the table moved between runs')
      table = t
    }
  }
  return initCache.store(rom, key, bus, { table })
}

/** Reads both table bases from the dispatch code, or says what did not match. */
export function resolveTables(rom: RomFile, handle: number = ENTRY.handleSprite): TablesResult {
  // HandleSprite: LDA $14C8,X / BEQ / CMP #$08 / BNE +3 / JMP CallSpriteMain / JSL ExecutePtr / table
  const h = bytes(rom, handle, 16 + 4)
  if (!matches(h, [0xbd, 0xc8, 0x14, 0xf0, null, 0xc9, 0x08, 0xd0, 0x03, 0x4c, null, null, 0x22]))
    return { ok: false, reason: 'HandleSprite is not the dispatch shape this reader knows' }
  const mainEntry = 0x010000 | (h![10] | (h![11] << 8))
  // Status 1 (INIT) is the second word of the status table that follows the JSL.
  const initEntry = 0x010000 | (h![18] | (h![19] << 8))
  // CallSpriteMain: STZ abs / LDA $9E,X / JSL ExecutePtr / table
  const m = bytes(rom, mainEntry, 9)
  if (!matches(m, [0x9c, null, null, 0xb5, 0x9e, 0x22]))
    return { ok: false, reason: 'CallSpriteMain is not the dispatch shape this reader knows' }
  const ep = checkExecutePtr(rom, [h!.slice(13, 16), m!.slice(6, 9)])
  if (!ep.ok) return ep
  // CallSpriteInit is run, not matched: its cells come from HandleSprite's and CallSpriteMain's own operands.
  const execPtr = (h![15] << 16) | (h![14] << 8) | h![13]
  const init = initTableOf(rom, initEntry, execPtr, {
    status: h![1] | (h![2] << 8),
    runStatus: h![6]!,
    number: m![4]!,
  })
  if ('reason' in init)
    return {
      ok: false,
      reason: `CallSpriteInit is not the dispatch shape this reader knows: ${init.reason}`,
    }
  return { ok: true, tables: { initTable: init.table, mainTable: mainEntry + 9 } }
}

export interface ResolvedHandler {
  /** Pointer word and the bank-1 address it names. */
  pointer: number
  address: number
}

/** Pointer for `id` in one table, refusing past the table or into non-code. */
export function resolvePointer(
  rom: RomFile,
  table: number,
  id: number,
): { ok: true; handler: ResolvedHandler } | { ok: false; reason: string } {
  if (id < 0 || id >= SPRITE_TABLE_COUNT)
    return { ok: false, reason: `id $${id.toString(16)} is past the ${SPRITE_TABLE_COUNT}-entry pointer table` } // prettier-ignore
  const pair = bytesAt(rom, table + id * 2, 2)
  const w = pair ? pair[0] | (pair[1] << 8) : null
  if (w === null) return { ok: false, reason: 'pointer table is not readable' }
  const address = 0x010000 | w
  // A code pointer lands in the cart's upper half; below $8000 is registers or WRAM.
  if (w < 0x8000 || bytesAt(rom, address, 1) === null)
    return { ok: false, reason: `pointer $${w.toString(16)} is not in ROM code` }
  return { ok: true, handler: { pointer: w, address } }
}
