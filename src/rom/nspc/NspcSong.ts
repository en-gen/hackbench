/**
 * Parse one N-SPC song out of a sound-RAM image into an event list.
 *
 * Structure (SMW APU_0C01, bank_0E.asm:989-1027): a song is a list of
 * words. A word with a nonzero high byte points at a section of eight
 * track pointers; $0000 ends the song; $00nn is a counted jump whose target
 * follows. Within a section every voice runs its track in lockstep, and the
 * first track to reach its $00 ends the section for all of them.
 *
 * The block list is walked exactly as the driver's counter logic does, so
 * finite repeats unroll and the infinite loop is found as the first repeated
 * (position, counter) state rather than guessed from the last jump.
 *
 * Every byte read must lie in an uploaded range. A failure says which kind
 * it is, because the scanner treats them differently: bytes that are not a
 * song end the song table, data that runs into unfilled RAM does not.
 */
import type { SoundImage } from './SourceScan'
import type { NspcEngine } from './NspcEngine'

export type NspcEvent =
  /** note: semitones above the lowest note byte ($80). q: the dur%/velocity byte, when one was given here. */
  | { k: 'note'; note: number; ticks: number; q?: number }
  | { k: 'tie'; ticks: number; q?: number }
  | { k: 'rest'; ticks: number; q?: number }
  | { k: 'perc'; index: number; ticks: number; q?: number }
  | { k: 'vcmd'; op: number; params: number[] }
  | { k: 'call'; addr: number; count: number; body: NspcEvent[] }

export interface NspcTrack {
  addr: number
  events: NspcEvent[]
  ticks: number
}

export interface NspcSection {
  addr: number
  /** Eight voices; null where the section leaves a voice idle. */
  tracks: (NspcTrack | null)[]
  /** The section ends when its shortest active track does. */
  ticks: number
}

export interface NspcSong {
  addr: number
  /** Sections in play order, repeats unrolled. */
  order: NspcSection[]
  /** Index into order where playback loops back to, or null if the song ends. */
  loopIndex: number | null
  fingerprint: string
}

/**
 * `unwritten`: the data is well formed as far as it goes but runs into memory
 * this image never filled. `structure`: the bytes are not a song at all.
 */
export type SongResult =
  { ok: true; song: NspcSong } | { ok: false; kind: 'unwritten' | 'structure'; reason: string }

const MAX_TRACK_BYTES = 0x2000
const MAX_BLOCK_STEPS = 512
/**
 * Distinct bytes one song may read. Sections and subroutines are parsed once
 * each, so a real song reads less than sound RAM holds; random bytes read as
 * a block list can reach hundreds of sections and millions of events, which
 * exhausted a 4 GB heap scanning ALTTP's bank candidates.
 */
const MAX_SONG_BYTES = 0x10000

class ParseError extends Error {
  constructor(
    message: string,
    readonly kind: 'unwritten' | 'structure' = 'structure',
  ) {
    super(message)
  }
}

class Reader {
  constructor(
    private image: SoundImage,
    public at: number,
    private budget: { left: number },
  ) {}
  byte(): number {
    if (--this.budget.left < 0) throw new ParseError('song reads more bytes than sound RAM holds')
    if (this.at > 0xffff || !this.image.written[this.at])
      throw new ParseError(`reads unwritten RAM at $${this.at.toString(16)}`, 'unwritten')
    return this.image.aram[this.at++]
  }
  peek(): number {
    if (this.at > 0xffff || !this.image.written[this.at])
      throw new ParseError(`reads unwritten RAM at $${this.at.toString(16)}`, 'unwritten')
    return this.image.aram[this.at]
  }
}

/**
 * Shared by every reader in one song: parsed subroutines and the byte budget.
 * Subroutines are keyed by address AND incoming duration, because duration
 * is per-voice driver state (SMW keeps it at $0200+X, set only by a duration
 * byte; APU_0C7A, bank_0E.asm:1055) that carries across sections and into
 * a subroutine. ALTTP's tracks routinely start with a bare note.
 */
interface SongContext {
  subs: Map<string, { events: NspcEvent[]; duration: number }>
  budget: { left: number }
}

function callOp(engine: NspcEngine): number {
  // CALL sits at the same slot in both dialects: SMW's $E9 is $DA+$0F
  // (VCmdPtrs, bank_0E.asm:1525), Standard's $EF is $E0+$0F (VGMTrans loadStandardVcmdMap).
  return engine.vcmdFirst + 0x0f
}

function parseEvents(
  image: SoundImage,
  addr: number,
  ctx: SongContext,
  inSub: boolean,
  startDuration: number,
): { events: NspcEvent[]; ticks: number; duration: number } {
  const e = image.engine
  const r = new Reader(image, addr, ctx.budget)
  const events: NspcEvent[] = []
  let ticks = 0
  let duration = startDuration
  const start = addr
  for (;;) {
    if (r.at - start > MAX_TRACK_BYTES) throw new ParseError('track too long')
    let b = r.byte()
    if (b === 0x00) break
    let q: number | undefined
    if (b < 0x80) {
      duration = b
      if (r.peek() < 0x80) q = r.byte()
      b = r.byte()
    }
    if (b >= e.vcmdFirst) {
      const len = e.vcmdLens[b - e.vcmdFirst]
      if (!len || len > 5) throw new ParseError(`command $${b.toString(16)} has no length`)
      const params: number[] = []
      for (let i = 1; i < len; i++) params.push(r.byte())
      if (b === callOp(e)) {
        if (inSub) throw new ParseError('nested subroutine call')
        const target = params[0] | (params[1] << 8)
        const count = params[2]
        const key = `${target}:${duration}`
        let sub = ctx.subs.get(key)
        if (!sub) {
          const parsed = parseEvents(image, target, ctx, true, duration)
          sub = { events: parsed.events, duration: parsed.duration }
          ctx.subs.set(key, sub)
        }
        events.push({ k: 'call', addr: target, count, body: sub.events })
        ticks += count * sumTicks(sub.events)
        duration = sub.duration
      } else {
        events.push({ k: 'vcmd', op: b, params })
      }
      continue
    }
    if (duration === 0) throw new ParseError('note before any duration')
    if (b >= e.noteMin && b <= e.noteMax)
      events.push({ k: 'note', note: b - e.noteMin, ticks: duration, q })
    else if (b === e.tie) events.push({ k: 'tie', ticks: duration, q })
    else if (b >= e.percMin && b <= e.percMax)
      events.push({ k: 'perc', index: b - e.percMin, ticks: duration, q })
    else events.push({ k: 'rest', ticks: duration, q })
    ticks += duration
  }
  return { events, ticks, duration }
}

export function sumTicks(events: NspcEvent[]): number {
  let t = 0
  for (const ev of events) {
    if (ev.k === 'call') t += ev.count * sumTicks(ev.body)
    else if (ev.k !== 'vcmd') t += ev.ticks
  }
  return t
}

/** Parse a section with each voice's incoming duration; `durations` is updated to the outgoing ones. */
function parseSection(
  image: SoundImage,
  addr: number,
  ctx: SongContext,
  durations: number[],
): NspcSection {
  const r = new Reader(image, addr, ctx.budget)
  const tracks: (NspcTrack | null)[] = []
  for (let v = 0; v < 8; v++) {
    const ptr = r.byte() | (r.byte() << 8)
    if (ptr >> 8 === 0) {
      tracks.push(null)
      continue
    }
    const { events, ticks, duration } = parseEvents(image, ptr, ctx, false, durations[v])
    durations[v] = duration
    tracks.push({ addr: ptr, events, ticks })
  }
  const active = tracks.filter((t): t is NspcTrack => t !== null)
  if (active.length === 0) throw new ParseError(`section $${addr.toString(16)} has no tracks`)
  return { addr, tracks, ticks: Math.min(...active.map(t => t.ticks)) }
}

export function parseSong(image: SoundImage, addr: number): SongResult {
  try {
    const ctx: SongContext = { subs: new Map(), budget: { left: MAX_SONG_BYTES } }
    // Keyed by address and the voices' incoming durations, with the outgoing ones.
    const sections = new Map<string, { section: NspcSection; out: number[] }>()
    let durations = new Array<number>(8).fill(0)
    const order: NspcSection[] = []
    const seen = new Map<string, number>()
    const r = new Reader(image, addr, ctx.budget)
    let counter = 0
    let loopIndex: number | null = null

    for (let step = 0; step < MAX_BLOCK_STEPS; step++) {
      // A counter of 0 and one of $81-$FF behave identically at the next
      // jump (both reload the count), so they are one state; otherwise an
      // infinite loop would be unrolled once before being recognised.
      const idle = counter === 0 || counter > 0x80
      const state = `${r.at}:${idle ? 'idle' : counter}`
      const w = r.byte() | (r.byte() << 8)
      if (w >> 8 !== 0) {
        const again = seen.get(state)
        if (again !== undefined) {
          loopIndex = again
          break
        }
        seen.set(state, order.length)
        const key = `${w}:${durations.join()}`
        let s = sections.get(key)
        if (s) durations = s.out.slice()
        else {
          const incoming = durations.slice()
          const section = parseSection(image, w, ctx, durations)
          s = { section, out: durations.slice() }
          sections.set(`${w}:${incoming.join()}`, s)
        }
        order.push(s.section)
        continue
      }
      if (w === 0) break
      // Counted jump, mirroring the driver: DEC; zero skips; positive jumps;
      // negative (first visit) loads the count, then jumps.
      counter = (counter - 1) & 0xff
      if (counter === 0) {
        r.at += 2
        continue
      }
      if (counter >= 0x80) counter = w & 0xff
      r.at = r.byte() | (r.byte() << 8)
    }
    if (order.length === 0) return { ok: false, kind: 'structure', reason: 'no sections' }
    if (loopIndex === null && order.length >= MAX_BLOCK_STEPS)
      return { ok: false, kind: 'structure', reason: 'block list never ends' }
    const fingerprint = `${addr}:${order.map(s => s.addr).join(',')}:${loopIndex}`
    return { ok: true, song: { addr, order, loopIndex, fingerprint } }
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, kind: err.kind, reason: err.message }
    throw err
  }
}
