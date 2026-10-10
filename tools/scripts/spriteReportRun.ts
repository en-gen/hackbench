/**
 * Sprite report, the doing half (#828): argument and path rules, grading the
 * `layers_v5` captures with the accuracy test's grader, writing the pages and
 * committing them to the private validation repo. sprite-report.ts is the CLI.
 * Never pushes. The grading loop mirrors gradeAll in
 * test/suite/unit/sprites/spriteGrade.captures.test.ts, which is not exported
 * and is not edited here.
 */
import { execFileSync } from 'child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { runSprite, type SpriteModel } from '../../src/rom/sprites/interp/SpriteRunner'
import { loadLevelState } from '../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../src/rom/sprites/interp/SpriteSeed'
import {
  CAPTURE_DIR,
  VANILLA,
  freshRom,
  hasCaptures,
  hasRom,
  romPath,
} from '../../test/suite/support/corpus'
import { grade, passPieces, type RecordedPiece } from '../../test/suite/support/spriteGrade'
import { palette } from './capture_draw'
import { parseNum } from './capture_decode'
import { unzip } from './capture_render'
import {
  buildReport,
  contactSheet,
  encodePng,
  VERDICTS,
  isInside,
  renderPieces,
  type FrameSource,
  type ReportRow,
  type Rgba,
} from './spriteReport'

export interface Graded extends ReportRow {
  oursImg: Rgba | null
  hardwareImg: Rgba | null
}
export interface Filter {
  map?: number
  sprite?: number
}
export interface Io {
  repoRoot: string
  rom: string
  captures: string
  exists: (p: string) => boolean
  sha: () => { sha: string; dirty: boolean }
  grade: (f: Filter) => Graded[]
  env: Record<string, string | undefined>
  log: (s: string) => void
}
export interface Args {
  validation?: string
  out?: string
  commit: boolean
  force: boolean
  sheet: boolean
  filter: Filter
}

const USAGE =
  'usage: sprite-report [--validation <dir>] [--force] | --out <dir> --no-commit | --sheet (--map <hex> | --sprite <hex>) --out <dir>'

export function parseArgs(argv: string[]): Args | string {
  const a: Args = { commit: true, force: false, sheet: false, filter: {} }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    const next = (): string => argv[++i] ?? ''
    if (v === '--validation') a.validation = next()
    else if (v === '--out') a.out = next()
    else if (v === '--no-commit') a.commit = false
    else if (v === '--sheet') a.sheet = true
    else if (v === '--force') a.force = true
    else if (v === '--map') a.filter.map = parseInt(next(), 16)
    else if (v === '--sprite') a.filter.sprite = parseInt(next(), 16)
    else return `unknown argument ${v}\n${USAGE}`
  }
  if (a.sheet && (a.filter.map === undefined) === (a.filter.sprite === undefined))
    return `--sheet needs exactly one of --map, --sprite\n${USAGE}`
  if (!a.sheet && (a.filter.map !== undefined || a.filter.sprite !== undefined))
    return `--map and --sprite are for --sheet\n${USAGE}`
  if ((a.sheet || !a.commit) && !a.out)
    return `${a.sheet ? '--sheet' : '--no-commit'} needs --out\n${USAGE}`
  if (!a.sheet && a.commit && a.out)
    return `--out writes without committing: add --no-commit\n${USAGE}`
  return a
}

/** A sibling `hackbench-validation` by walking up from the checkout, unless the env names one. */
export function findValidation(
  repoRoot: string,
  env: Io['env'],
  exists: Io['exists'],
): string | undefined {
  if (env.HACKBENCH_VALIDATION) return resolve(env.HACKBENCH_VALIDATION)
  for (let d = resolve(repoRoot); ; d = dirname(d)) {
    if (exists(join(d, 'hackbench-validation'))) return join(d, 'hackbench-validation')
    if (dirname(d) === d) return undefined
  }
}

export function writeTree(dir: string, files: Map<string, string | Buffer>): void {
  for (const [rel, data] of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), data)
  }
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'core.autocrlf=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

const TICKED = /^- \[x\]/im

/** Throws when `<key>/` holds a ticked checkbox (a reviewer's work) and `force` is off. */
function refuseTicked(dir: string, force: boolean): void {
  if (force || !existsSync(dir)) return
  const hit = (d: string): boolean =>
    readdirSync(d, { withFileTypes: true }).some(e =>
      e.isDirectory()
        ? hit(join(d, e.name))
        : e.name.endsWith('.md') && TICKED.test(readFileSync(join(d, e.name), 'utf8')),
    )
  if (hit(dir))
    throw new Error(`${dir} has ticked checkboxes; --force overwrites them. Nothing written.`)
}

/**
 * Builds the tree in a scratch dir, then replaces reports/sprites/<key>/ and a
 * fresh latest/ under `base`. Ticks belong in <key>/ (kept, refused unless
 * forced); latest/ is regenerated every run and is never the place to tick.
 */
export function placeReport(
  base: string,
  key: string,
  files: Map<string, string | Buffer>,
  force: boolean,
): void {
  refuseTicked(join(base, key), force)
  const scratch = mkdtempSync(join(tmpdir(), 'sprite-report-'))
  try {
    writeTree(scratch, files)
    for (const dir of [key, 'latest']) {
      rmSync(join(base, dir), { recursive: true, force: true })
      mkdirSync(join(base, dir), { recursive: true })
      cpSync(scratch, join(base, dir), { recursive: true })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Places the report in `repo` and commits only <key>/ and latest/. Returns false when nothing changed; a failed commit is undone and rethrown. */
export function commitReport(
  repo: string,
  key: string,
  files: Map<string, string | Buffer>,
  force = false,
): boolean {
  const paths = [`reports/sprites/${key}`, 'reports/sprites/latest']
  placeReport(join(repo, 'reports', 'sprites'), key, files, force)
  try {
    git(repo, 'add', '-A', '--', ...paths)
    if (!git(repo, 'status', '--porcelain', '--', ...paths).trim()) return false
    git(repo, 'commit', '-m', `Sprite report for hackbench ${key}`, '--', ...paths)
    return true
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string }
    for (const undo of [
      ['reset', '-q', '--', ...paths],
      ['checkout', '-q', '--', 'reports/sprites/latest'], // fails on a first run, nothing tracked yet
      ['clean', '-fdq', '--', ...paths],
    ])
      try {
        git(repo, ...undo)
      } catch {
        // best effort; the thrown message below is the one that matters
      }
    throw new Error(
      `git commit failed, report undone: ${err.stderr || err.stdout || err.message}`,
      { cause: e },
    )
  }
}

/** The common git dir of the repo holding `dir`, or undefined when it is no repo. */
const commonDir = (dir: string): string | undefined => {
  try {
    return realpathSync.native(resolve(dir, git(dir, 'rev-parse', '--git-common-dir').trim()))
  } catch {
    return undefined
  }
}
/** Why `dir` is a hackbench repo (same git store as the checkout, or an origin naming en-gen/hackbench), else undefined. */
export function hackbenchRepo(dir: string, repoRoot: string): string | undefined {
  const [mine, theirs] = [commonDir(repoRoot), commonDir(dir)]
  if (mine && mine === theirs) return 'it shares its git store with the hackbench checkout'
  try {
    const url = git(dir, 'config', '--get', 'remote.origin.url').trim()
    if (/en-gen\/hackbench(\.git)?\/?$/i.test(url)) return `its origin is ${url}`
  } catch {
    // no origin
  }
  return undefined
}

/** Exit 0, 1 (missing input or nothing graded) or 2 (usage or refused path). */
export function run(argv: string[], io: Io): number {
  const fail = (code: number, msg: string): number => (io.log(msg), code)
  const ok = (msg: string): number => fail(0, msg)
  const a = parseArgs(argv)
  if (typeof a === 'string') return fail(2, a)
  const missing = [
    ...(io.exists(io.rom) ? [] : [`the vanilla ROM (${io.rom})`]),
    ...(io.exists(io.captures) ? [] : [`the layers_v5 captures (${io.captures})`]),
  ]
  if (missing.length) return fail(1, `missing: ${missing.join(' and ')}. Nothing written.`)
  const validation = findValidation(io.repoRoot, io.env, io.exists)
  const target = a.validation ? resolve(a.validation) : validation
  const inRepo = (p: string): string | undefined =>
    isInside(p, io.repoRoot) ? 'the hackbench checkout' : undefined
  if (a.sheet || !a.commit) {
    const bad =
      inRepo(a.out!) ?? (target && isInside(a.out!, target) ? 'the validation repo' : undefined)
    if (bad) return fail(2, `refusing ${a.out}: it is inside ${bad}. Nothing written.`)
  } else {
    if (!target || !io.exists(join(target, '.git')))
      return fail(
        1,
        `missing: the validation repo checkout (${target ?? 'no sibling hackbench-validation found; pass --validation'}). Nothing written.`,
      )
    if (inRepo(target))
      return fail(2, `refusing ${target}: it is inside the hackbench checkout. Nothing written.`)
    const why = hackbenchRepo(target, io.repoRoot)
    if (why) return fail(2, `refusing ${target}: ${why}. Nothing written.`)
  }
  const graded = io.grade(a.filter)
  if (!graded.length) return fail(1, 'no graded sprites matched. Nothing written.')
  const tally = Object.entries(Object.groupBy(graded, g => g.verdict))
    .map(([v, l]) => `${v} ${l!.length}`)
    .join(', ')
  if (a.sheet) {
    const cells = [...graded]
      .sort((x, y) => VERDICTS.indexOf(x.verdict) - VERDICTS.indexOf(y.verdict))
      .map(g => ({ verdict: g.verdict, ours: g.oursImg, hardware: g.hardwareImg }))
    const name = `sprite-sheet-${a.filter.map !== undefined ? `map-${a.filter.map.toString(16)}` : `sprite-${a.filter.sprite!.toString(16)}`}.png`
    writeTree(resolve(a.out!), new Map([[name, encodePng(contactSheet(cells))]]))
    return ok(
      `${join(resolve(a.out!), name)}: ${graded.length} sprites (${tally}); each cell is ours then hardware, border exact green, shape lime, close yellow, wrong red, empty/refused grey`,
    )
  }
  const { sha, dirty } = io.sha()
  const key = dirty ? `${sha}-dirty` : sha
  const files = new Map<string, string | Buffer>()
  const rows = graded.map((g, n) => {
    const stem = `img/${g.map}-${g.id.toString(16)}-${g.slot}-${n}`
    const row: ReportRow = {
      map: g.map,
      id: g.id,
      slot: g.slot,
      verdict: g.verdict,
      detail: g.detail,
    }
    if (g.oursImg) {
      row.ours = `${stem}-ours.png`
      files.set(row.ours, encodePng(g.oursImg))
    }
    if (g.hardwareImg) {
      row.hardware = `${stem}-hardware.png`
      files.set(row.hardware, encodePng(g.hardwareImg))
    }
    return row
  })
  for (const [k, v] of buildReport(rows, { sha, dirty })) files.set(k, v)
  try {
    if (a.commit) {
      const made = commitReport(target!, key, files, a.force)
      return ok(
        `${made ? 'committed' : 'no change to commit'} in ${target}: ${graded.length} sprites (${tally}). Not pushed.`,
      )
    }
    const base = join(resolve(a.out!), 'reports', 'sprites')
    placeReport(base, key, files, a.force)
    return ok(`${join(base, key)}: ${graded.length} sprites (${tally}). Nothing committed.`)
  } catch (e) {
    return fail(1, (e as Error).message)
  }
}

interface Rec {
  id: string
  slot: number
  listX: number
  listY: number
  cameraX: number
  cameraY: number
  marioAtInit?: { x: number; y: number }
  entries?: Entry[]
  frames?: { tiles?: RecordedPiece[] }[]
}

/** The map's sprite graphics, palette and OBSEL from its capture, or undefined when the capture lacks them. */
function frameSource(entries: Map<string, () => Buffer>): FrameSource | undefined {
  const find = (n: string): (() => Buffer) | undefined =>
    [...entries].find(([k]) => k.split('/').pop() === n)?.[1]
  const json = (n: string): { samples?: { offset?: unknown }[]; OBSEL_2101?: { byte?: unknown } } | undefined => { const f = find(n); return f ? JSON.parse(f().toString('utf8')) : undefined } // prettier-ignore
  const offset = Number(json('capture_summary.json')?.samples?.[0]?.offset ?? 0)
  const at = (n: string): string => `frame_${String(offset).padStart(4, '0')}_${n}`
  const [vram, cgram, ppu] = [find(at('vram.bin')), find(at('cgram.bin')), json(at('ppu.json'))]
  const obsel = parseNum(ppu?.OBSEL_2101?.byte)
  if (!vram || !cgram || Number.isNaN(obsel)) return undefined
  return { vram: new Uint8Array(vram()), pal: palette(new Uint8Array(cgram())), obsel }
}

/**
 * The recorded frame the grader scores best against our chosen pass: grade()
 * against each frame singly, best verdict wins, ties go to the first. Empty and
 * refused models tie everywhere and show the first frame.
 */
export function gradedFrame(m: SpriteModel, want: RecordedPiece[][]): RecordedPiece[] {
  const rank = want.map(w => VERDICTS.indexOf(grade(m, [w]).verdict))
  return want[rank.indexOf(Math.min(...rank))]
}

interface Entry {
  entry: number
  x: number
  y: number
  tile: number
  attr: number
  sizeXHigh: number
}

/**
 * `frame` in OAM index order. The capture sorts each frame's tiles as JSON
 * text, so only the record's `entries` (headless_capture.lua:1352) know the
 * order; a piece is matched to the entry with its tile, attr and size under one
 * shared offset. Null when no offset explains every piece (the entries are
 * another frame's, or absent).
 */
export function oamOrder(
  frame: RecordedPiece[],
  entries: Entry[] | undefined,
): RecordedPiece[] | null {
  if (!entries || entries.length !== frame.length) return null
  const es = entries.map(e => ({
    ...e,
    x: e.x + (e.sizeXHigh & 1) * 256,
    large: (e.sizeXHigh & 2) !== 0,
  }))
  const same = (p: RecordedPiece, e: (typeof es)[0]): boolean =>
    p.tile === e.tile && p.attr === e.attr && p.large === e.large
  const mod = (a: number, m: number): number => ((a % m) + m) % m
  for (const e0 of es.filter(e => same(frame[0], e))) {
    const [tx, ty] = [frame[0].dx - e0.x, frame[0].dy - e0.y]
    const used = new Set<number>()
    const hit: { p: RecordedPiece; n: number }[] = []
    for (const p of frame) {
      const e = es.find(
        c =>
          !used.has(c.entry) &&
          same(p, c) &&
          !mod(p.dx - c.x - tx, 512) &&
          !mod(p.dy - c.y - ty, 256),
      )
      if (!e) break
      used.add(e.entry)
      hit.push({ p, n: e.entry })
    }
    if (hit.length === frame.length) return hit.sort((a, b) => a.n - b.n).map(h => h.p)
  }
  return null
}

/** Grades every captured sprite (or the filtered ones) with the 'rom' seed and 64 passes, as the accuracy test does. */
export function gradeCaptures(f: Filter): Graded[] {
  const rom = freshRom()
  const out: Graded[] = []
  for (const file of readdirSync(CAPTURE_DIR).sort()) {
    if (!file.endsWith('.zip')) continue
    const map = file.slice(0, -4)
    if (f.map !== undefined && parseInt(map, 16) !== f.map) continue
    const entries = unzip(readFileSync(join(CAPTURE_DIR, file)))
    const key = [...entries.keys()].find(k => k.endsWith('sprite_spawns.json'))
    if (!key) continue
    const spawns: Rec[] = JSON.parse(entries.get(key)!().toString('utf8')).spawns ?? []
    const src = frameSource(entries)
    const lvl = loadLevelState(rom, parseInt(map, 16))
    for (const rec of spawns) {
      const id = parseInt(rec.id.slice(1), 16)
      const want = (rec.frames ?? []).flatMap(fr => (fr.tiles?.length ? [fr.tiles] : []))
      if (!want.length || id > 0xc8 || (f.sprite !== undefined && id !== f.sprite)) continue
      const seed = withSeed({
        loaded: lvl.ok ? lvl.wram : undefined,
        slot: rec.slot,
        mainPasses: 64,
        sprite: { x: rec.listX, y: rec.listY },
        camera: { x: rec.cameraX, y: rec.cameraY },
        mario: rec.marioAtInit ?? { x: rec.listX, y: rec.listY },
      })
      const m = runSprite(rom, id, seed)
      const g = grade(m, want)
      const ours = m.chosen !== undefined && !m.refusal ? passPieces(m, m.chosen) : []
      const hw = gradedFrame(m, want)
      const ordered = oamOrder(hw, rec.entries)
      const note = ordered || hw.length < 2 ? undefined : 'hardware overlap order unknown'
      out.push({
        map, id, slot: rec.slot, verdict: g.verdict,
        detail: [g.detail, note].filter(Boolean).join('. ') || undefined,
        oursImg: src ? renderPieces(ours, src) : null,
        hardwareImg: src ? renderPieces(ordered ?? hw, src) : null,
      }) // prettier-ignore
    }
  }
  return out
}

export function realIo(repoRoot: string, log: (s: string) => void = console.log): Io {
  const git1 = (...a: string[]): string => git(repoRoot, ...a).trim()
  return {
    repoRoot,
    rom: romPath(VANILLA),
    captures: CAPTURE_DIR,
    exists: p =>
      p === CAPTURE_DIR ? hasCaptures() : p === romPath(VANILLA) ? hasRom(VANILLA) : existsSync(p),
    sha: () => ({ sha: git1('rev-parse', 'HEAD'), dirty: git1('status', '--porcelain') !== '' }),
    grade: gradeCaptures,
    env: process.env,
    log,
  }
}
