/**
 * Turn a parsed N-SPC song into an AddmusicK song: MML text plus the BRR
 * samples it names.
 *
 * AddmusicK's driver descends from SMW's, so its hex commands keep SMW's
 * numbering ($DA instrument ... $F2 echo fade; SMWDisX VCmdPtrs,
 * bank_0E.asm:1510-1535). A source command is translated by MEANING: each
 * dialect's command slot maps to a meaning (VGMTrans NinSnesProfile.cpp),
 * and each meaning to the SMW opcode AddmusicK accepts.
 *
 * Transposes are applied to the notes here rather than emitted, and
 * subroutine calls become AddmusicK loops. Anything without a faithful
 * equivalent is dropped with a warning naming it, never approximated
 * silently.
 */
import type { NspcEngine } from './NspcEngine'
import type { NspcEvent, NspcSong } from './NspcSong'
import type { SoundImage } from './SourceScan'
import { readSample, toAmkBrr } from './Brr'

type Meaning =
  | 'prog'
  | 'pan'
  | 'panFade'
  | 'pitchSlide'
  | 'vibratoOn'
  | 'vibratoOff'
  | 'masterVolume'
  | 'masterVolumeFade'
  | 'tempo'
  | 'tempoFade'
  | 'globalTranspose'
  | 'transpose'
  | 'tremoloOn'
  | 'tremoloOff'
  | 'volume'
  | 'volumeFade'
  | 'call'
  | 'vibratoFade'
  | 'pitchEnvTo'
  | 'pitchEnvFrom'
  | 'pitchEnvOff'
  | 'tuning'
  | 'echoOn'
  | 'echoOff'
  | 'echoParam'
  | 'echoVolumeFade'
  | 'percBase'
  | null

/** Command slot (opcode - first command) to meaning. */
const DIALECT_MEANINGS: Record<NspcEngine['dialect'], Meaning[]> = {
  // SMW, VCmdPtrs (bank_0E.asm:1510-1535). $ED is undefined there.
  earlier: [
    'prog',
    'pan',
    'panFade',
    'pitchSlide',
    'vibratoOn',
    'vibratoOff',
    'masterVolume',
    'masterVolumeFade',
    'tempo',
    'tempoFade',
    'globalTranspose',
    'tremoloOn',
    'tremoloOff',
    'volume',
    'volumeFade',
    'call',
    'vibratoFade',
    'pitchEnvTo',
    'pitchEnvFrom',
    null,
    'tuning',
    'echoOn',
    'echoOff',
    'echoParam',
    'echoVolumeFade',
  ],
  // VGMTrans loadStandardVcmdMap.
  standard: [
    'prog',
    'pan',
    'panFade',
    'vibratoOn',
    'vibratoOff',
    'masterVolume',
    'masterVolumeFade',
    'tempo',
    'tempoFade',
    'globalTranspose',
    'transpose',
    'tremoloOn',
    'tremoloOff',
    'volume',
    'volumeFade',
    'call',
    'vibratoFade',
    'pitchEnvTo',
    'pitchEnvFrom',
    'pitchEnvOff',
    'tuning',
    'echoOn',
    'echoOff',
    'echoParam',
    'echoVolumeFade',
    'pitchSlide',
    'percBase',
  ],
}

/** The SMW opcode (and so AddmusicK hex command) for each meaning emitted as hex. */
const AMK_OP: Partial<Record<Exclude<Meaning, null>, number>> = {
  panFade: 0xdc,
  pitchSlide: 0xdd,
  vibratoOn: 0xde,
  vibratoOff: 0xdf,
  masterVolumeFade: 0xe1,
  tempoFade: 0xe3,
  tremoloOn: 0xe5,
  volumeFade: 0xe8,
  vibratoFade: 0xea,
  pitchEnvTo: 0xeb,
  pitchEnvFrom: 0xec,
  tuning: 0xee,
  echoOn: 0xef,
  echoOff: 0xf0,
  echoParam: 0xf1,
  echoVolumeFade: 0xf2,
}

const FIRST_CUSTOM_INSTRUMENT = 30

/**
 * Seconds for one pass through the song, or null when it never sets a tempo
 * or the driver's timer cannot be read. Timer 0 counts at 8 kHz and fires
 * every `period` counts (SMW writes $10: APU_Start, bank_0E.asm:57); each
 * firing adds the tempo to an 8-bit accumulator and a carry is one tick
 * (APU_Loop, bank_0E.asm:78-83).
 */
export function songSeconds(image: SoundImage, song: NspcSong): number | null {
  const period = readTimerPeriod(image.aram)
  if (!period) return null
  const meanings = DIALECT_MEANINGS[image.engine.dialect]
  let tempo = 0
  let seconds = 0
  const scan = (events: NspcEvent[]) => {
    for (const ev of events) {
      if (ev.k === 'vcmd' && meanings[ev.op - image.engine.vcmdFirst] === 'tempo')
        tempo = ev.params[0]
      else if (ev.k === 'call') scan(ev.body)
    }
  }
  for (const section of song.order) {
    for (const t of section.tracks) if (t) scan(t.events)
    if (!tempo) return null
    seconds += section.ticks / ((8000 / period) * (tempo / 256))
  }
  return seconds
}

function readTimerPeriod(aram: Uint8Array): number | null {
  const periods = new Set<number>()
  // `MOV A,#p : MOV !$00FA,A` and `MOV $FA,#p`.
  for (let at = 0; at + 5 <= aram.length; at++) {
    if (
      aram[at] === 0xe8 &&
      aram[at + 2] === 0xc5 &&
      aram[at + 3] === 0xfa &&
      aram[at + 4] === 0x00
    )
      periods.add(aram[at + 1])
    if (aram[at] === 0x8f && aram[at + 2] === 0xfa) periods.add(aram[at + 1])
  }
  periods.delete(0)
  return periods.size === 1 ? [...periods][0] : null
}
const NOTE_NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b']
/** Longest single rest/tie emitted; longer spans are split. */
const MAX_TICKS = 96

export interface AmkFile {
  path: string
  bytes: Uint8Array
}

export interface AmkExport {
  mml: string
  samples: AmkFile[]
  warnings: string[]
  /** Bytes of BRR data the song brings; the ARAM cost AddmusicK will report. */
  sampleBytes: number
}

export interface ExportOptions {
  /** Folder under AddmusicK's samples/ that holds this song's BRRs. */
  folder: string
  title: string
  game: string
}

const h2 = (n: number) => '$' + (n & 0xff).toString(16).toUpperCase().padStart(2, '0')

interface InstrumentRef {
  /** The source record's bytes: SRCN, ADSR1, ADSR2, GAIN, mult, [frac]. */
  record: number[]
  /** Percussion plays a fixed note; null for pitched instruments. */
  fixedNote: number | null
  amk: number
  key: string
}

class Emitter {
  out: string[] = []
  octave: number | null = null
  instrument: number | null = null
  transposeGlobal = 0
  transposeVoice = 0
  percBase = 0
  logical: InstrumentRef | null = null

  constructor(
    private ctx: ExportContext,
    private voice: number,
  ) {}

  push(s: string) {
    this.out.push(s)
  }

  length(ticks: number, first: string, rest: string) {
    let remaining = ticks
    let tok = first
    while (remaining > 0) {
      const n = Math.min(remaining, MAX_TICKS)
      this.push(`${tok}=${n}`)
      remaining -= n
      tok = rest
    }
  }

  selectInstrument(ref: InstrumentRef) {
    if (this.instrument !== ref.amk) {
      this.push(`@${ref.amk}`)
      this.instrument = ref.amk
    }
  }

  note(n: number, ticks: number) {
    let note = n
    if (note < 0 || note > 71) {
      this.ctx.warn(`voice ${this.voice}: note out of range after transpose, clamped`)
      note = Math.max(0, Math.min(71, note))
    }
    const octave = Math.floor(note / 12) + 1
    if (octave !== this.octave) {
      this.push(`o${octave}`)
      this.octave = octave
    }
    this.length(ticks, NOTE_NAMES[note % 12], '^')
  }

  /** Emit events, stopping after `budget` ticks. Returns ticks emitted. */
  events(events: NspcEvent[], budget: number, inLoop: boolean): number {
    const e = this.ctx.engine
    const meanings = DIALECT_MEANINGS[e.dialect]
    let used = 0
    for (const ev of events) {
      if (used >= budget) break
      if (ev.k === 'vcmd') {
        this.vcmd(meanings[ev.op - e.vcmdFirst] ?? null, ev.op, ev.params)
        continue
      }
      if (ev.k === 'call') {
        const bodyTicks = ev.count * ticksOf(ev.body)
        const transposes = ev.body.some(
          b =>
            b.k === 'vcmd' &&
            ['globalTranspose', 'transpose', 'percBase'].includes(
              meanings[b.op - e.vcmdFirst] ?? '',
            ),
        )
        if (!inLoop && used + bodyTicks <= budget && !transposes && ev.count > 1) {
          // State at the top of the second pass is whatever the first left; force it.
          this.push('[')
          this.octave = null
          this.instrument = null
          this.events(ev.body, Infinity, true)
          this.push(`]${ev.count}`)
          this.octave = null
          this.instrument = null
          used += bodyTicks
        } else {
          for (let i = 0; i < ev.count && used < budget; i++)
            used += this.events(ev.body, budget - used, inLoop)
        }
        continue
      }
      const ticks = Math.min(ev.ticks, budget - used)
      if (ev.q !== undefined)
        this.push(`q${(ev.q & 0x7f).toString(16).toUpperCase().padStart(2, '0')}`)
      if (ev.k === 'note') {
        if (this.logical) this.selectInstrument(this.logical)
        this.note(ev.note + this.transposeGlobal + this.transposeVoice, ticks)
      } else if (ev.k === 'perc') {
        const ref = this.ctx.percussion(ev.index, this.percBase)
        if (ref) {
          this.selectInstrument(ref)
          // Percussion pitch takes the global transpose too (SMW HandleVCmd falls into APU_05E3).
          this.note((ref.fixedNote ?? 0x24) + this.transposeGlobal, ticks)
        } else this.length(ticks, 'r', 'r')
      } else if (ev.k === 'tie') this.length(ticks, '^', '^')
      else this.length(ticks, 'r', 'r')
      used += ticks
    }
    return used
  }

  vcmd(meaning: Meaning, op: number, p: number[]) {
    switch (meaning) {
      case 'prog': {
        const ref = this.ctx.instrument(p[0])
        if (ref) {
          this.logical = ref
          this.selectInstrument(ref)
        }
        return
      }
      case 'volume':
        return this.push(`v${p[0]}`)
      case 'pan':
        return this.push(p[0] & 0xc0 ? `$DB ${h2(p[0])}` : `y${p[0]}`)
      case 'tempo':
        return this.push(`t${p[0]}`)
      case 'masterVolume':
        return this.push(`w${p[0]}`)
      case 'globalTranspose':
        this.transposeGlobal = (p[0] << 24) >> 24
        return
      case 'transpose':
        this.transposeVoice = (p[0] << 24) >> 24
        return
      case 'percBase':
        this.percBase = p[0]
        return
      case 'tremoloOff':
        return this.push('$E5 $00 $00 $00')
      case 'pitchEnvOff':
        return this.push('$EB $00 $00 $00')
      case 'pitchSlide': {
        // The target is a note byte: transpose it like any other note.
        const target = (p[2] & 0x7f) + this.transposeGlobal + this.transposeVoice
        return this.push(`$DD ${h2(p[0])} ${h2(p[1])} ${h2(0x80 + target)}`)
      }
      case null:
        this.ctx.warn(`voice ${this.voice}: command ${h2(op)} has no known meaning; dropped`)
        return
      default: {
        const amk = AMK_OP[meaning]
        if (amk === undefined) {
          this.ctx.warn(
            `voice ${this.voice}: ${meaning} (${h2(op)}) has no AddmusicK equivalent; dropped`,
          )
          return
        }
        this.push([h2(amk), ...p.map(h2)].join(' '))
      }
    }
  }
}

function ticksOf(events: NspcEvent[]): number {
  let t = 0
  for (const ev of events) {
    if (ev.k === 'call') t += ev.count * ticksOf(ev.body)
    else if (ev.k !== 'vcmd') t += ev.ticks
  }
  return t
}

class ExportContext {
  refs = new Map<string, InstrumentRef>()
  warnings = new Set<string>()
  constructor(
    public image: SoundImage,
    public engine: NspcEngine,
  ) {}

  warn(w: string) {
    this.warnings.add(w)
  }

  private add(key: string, record: number[], fixedNote: number | null): InstrumentRef {
    let ref = this.refs.get(key)
    if (!ref) {
      ref = { record, fixedNote, amk: FIRST_CUSTOM_INSTRUMENT + this.refs.size, key }
      this.refs.set(key, ref)
    }
    return ref
  }

  private record(table: number, width: number, index: number): number[] | null {
    const at = table + index * width
    for (let i = 0; i < width; i++) if (!this.image.written[at + i]) return null
    return Array.from(this.image.aram.subarray(at, at + width))
  }

  instrument(index: number): InstrumentRef | null {
    if (index >= 0x80) {
      this.warn(`instrument ${h2(index)} uses the high-bit percussion form; not supported yet`)
      return null
    }
    const rec = this.record(this.engine.instrTable, this.engine.instrWidth, index)
    if (!rec) {
      this.warn(`instrument ${h2(index)} lies outside uploaded memory`)
      return null
    }
    return this.add(`i${index}`, rec, null)
  }

  percussion(index: number, base: number): InstrumentRef | null {
    const e = this.engine
    if (e.percTable !== null) {
      // SMW: its own table, one byte wider, the extra byte the note (HandleVCmd, bank_0E.asm:137-147).
      const rec = this.record(e.percTable, e.instrWidth + 1, index)
      if (!rec) {
        this.warn(`percussion ${index} lies outside uploaded memory`)
        return null
      }
      return this.add(`p${index}`, rec.slice(0, e.instrWidth), rec[e.instrWidth] & 0x7f)
    }
    this.warn('standard-dialect percussion pitch is not read from the driver yet; played at o4 c')
    const ref = this.instrument(base + index)
    return ref && this.add(`p${base + index}`, ref.record, 0x24)
  }
}

export function exportSong(image: SoundImage, song: NspcSong, opts: ExportOptions): AmkExport {
  const ctx = new ExportContext(image, image.engine)
  const channels: string[] = []

  for (let v = 0; v < 8; v++) {
    if (song.order.every(s => !s.tracks[v])) continue
    const em = new Emitter(ctx, v)
    song.order.forEach((section, i) => {
      if (i === song.loopIndex) {
        em.push('/')
        // AddmusicK restarts here with the state it had at the loop marker; keep it explicit.
        em.octave = null
        em.instrument = null
      }
      const track = section.tracks[v]
      if (track) {
        const used = em.events(track.events, section.ticks, false)
        if (used < section.ticks) em.length(section.ticks - used, 'r', 'r')
      } else if (section.ticks > 0) {
        em.length(section.ticks, 'r', 'r')
      }
    })
    channels.push(`#${v}\n${wrap(em.out)}`)
  }

  const samples: AmkFile[] = []
  const instrumentLines: string[] = []
  const sampleNames = new Map<number, string>()
  let sampleBytes = 0
  for (const ref of ctx.refs.values()) {
    const srcn = ref.record[0]
    let name = sampleNames.get(srcn)
    if (!name) {
      const sample = readSample(image, srcn)
      if (typeof sample === 'string') {
        ctx.warn(sample)
        continue
      }
      name = `${srcn.toString(16).padStart(2, '0')}.brr`
      sampleNames.set(srcn, name)
      const brr = toAmkBrr(sample)
      samples.push({ path: `samples/${opts.folder}/${name}`, bytes: brr })
      sampleBytes += sample.bytes.length
    }
    const [, adsr1, adsr2, gain, mult, frac = 0] = ref.record
    instrumentLines.push(
      `\t"${name}" ${[adsr1, adsr2, gain, mult, frac].map(h2).join(' ')}\t; @${ref.amk} ${ref.key}`,
    )
  }

  const mml = [
    '#amk 2',
    '',
    '#spc',
    '{',
    `\t#title "${opts.title.replace(/"/g, "'")}"`,
    `\t#game "${opts.game.replace(/"/g, "'")}"`,
    '\t#comment "Converted by the HackBench music import prototype"',
    '}',
    '',
    `#path "${opts.folder}"`,
    '',
    '#samples',
    '{',
    '\t#optimized',
    ...[...sampleNames.values()].map(n => `\t"${n}"`),
    '}',
    '',
    '#instruments',
    '{',
    ...instrumentLines,
    '}',
    '',
    ...channels,
    '',
  ].join('\n')

  return { mml, samples, warnings: [...ctx.warnings], sampleBytes }
}

function wrap(tokens: string[]): string {
  const lines: string[] = []
  let line = ''
  for (const t of tokens) {
    if (line.length + t.length > 96) {
      lines.push(line.trimEnd())
      line = ''
    }
    line += t + ' '
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines.join('\n')
}
