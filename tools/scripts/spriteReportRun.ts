/**
 * Sprite report, the doing half (#828): argument and path rules, grading the
 * `layers_v5` captures with the accuracy test's grader, writing the pages and
 * committing them to the private validation repo. sprite-report.ts is the CLI.
 * Never pushes. The grading loop mirrors gradeAll in
 * test/suite/unit/sprites/spriteGrade.captures.test.ts, which is not exported
 * and is not edited here.
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { runSprite } from '../../src/rom/sprites/interp/SpriteRunner'
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
  sheet: boolean
  filter: Filter
}

const USAGE =
  'usage: sprite-report [--validation <dir>] | --out <dir> --no-commit | --sheet (--map <hex> | --sprite <hex>) --out <dir>'

export function parseArgs(argv: string[]): Args | string {
  const a: Args = { commit: true, sheet: false, filter: {} }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    const next = (): string => argv[++i] ?? ''
    if (v === '--validation') a.validation = next()
    else if (v === '--out') a.out = next()
    else if (v === '--no-commit') a.commit = false
    else if (v === '--sheet') a.sheet = true
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
  execFileSync('git', ['-c', 'core.autocrlf=false', '-C', cwd, ...args], { encoding: 'utf8' })

/** Writes reports/sprites/<sha>/ and a fresh latest/ in `repo`, then commits just those. Returns false when nothing changed. */
export function commitReport(
  repo: string,
  sha: string,
  files: Map<string, string | Buffer>,
): boolean {
  const base = join(repo, 'reports', 'sprites')
  rmSync(join(base, 'latest'), { recursive: true, force: true })
  rmSync(join(base, sha), { recursive: true, force: true })
  for (const dir of [sha, 'latest']) writeTree(join(base, dir), files)
  git(repo, 'add', '-A', '--', 'reports/sprites')
  if (!git(repo, 'status', '--porcelain', '--', 'reports/sprites').trim()) return false
  git(repo, 'commit', '-m', `Sprite report for hackbench ${sha}`, '--', 'reports/sprites')
  return true
}

/** Exit 0, 1 (missing input or nothing graded) or 2 (usage or refused path). */
export function run(argv: string[], io: Io): number {
  const fail = (code: number, msg: string): number => (io.log(msg), code)
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
  }
  const graded = io.grade(a.filter)
  if (!graded.length) return fail(1, 'no graded sprites matched. Nothing written.')
  const tally = Object.entries(Object.groupBy(graded, g => g.verdict))
    .map(([v, l]) => `${v} ${l!.length}`)
    .join(', ')
  if (a.sheet) {
    const order = ['exact', 'shape', 'close', 'wrong', 'empty', 'refused']
    const cells = [...graded]
      .sort((x, y) => order.indexOf(x.verdict) - order.indexOf(y.verdict))
      .map(g => ({ verdict: g.verdict, ours: g.oursImg, hardware: g.hardwareImg }))
    const name = `sprite-sheet-${a.filter.map !== undefined ? `map-${a.filter.map.toString(16)}` : `sprite-${a.filter.sprite!.toString(16)}`}.png`
    writeTree(resolve(a.out!), new Map([[name, encodePng(contactSheet(cells))]]))
    return (
      io.log(
        `${join(resolve(a.out!), name)}: ${graded.length} sprites (${tally}); each cell is ours then hardware, border exact green, shape lime, close yellow, wrong red, empty/refused grey`,
      ),
      0
    )
  }
  const { sha, dirty } = io.sha()
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
  if (a.commit) {
    const made = commitReport(target!, sha, files)
    return (
      io.log(
        `${made ? 'committed' : 'no change to commit'} in ${target}: ${graded.length} sprites (${tally}). Not pushed.`,
      ),
      0
    )
  }
  for (const dir of [sha, 'latest'])
    writeTree(join(resolve(a.out!), 'reports', 'sprites', dir), files)
  return (
    io.log(
      `${join(resolve(a.out!), 'reports', 'sprites', sha)}: ${graded.length} sprites (${tally}). Nothing committed.`,
    ),
    0
  )
}

interface Rec {
  id: string
  slot: number
  listX: number
  listY: number
  cameraX: number
  cameraY: number
  marioAtInit?: { x: number; y: number }
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

const pieceKey = (ps: RecordedPiece[]): string =>
  ps
    .map(p => [p.dx, p.dy, p.tile, p.attr & 0xcf, +p.large].join())
    .sort()
    .join(';')

/** The recorded frame the grader matched when one is identical to ours (priority bits ignored), else the first. */
export function closestFrame(want: RecordedPiece[][], ours: RecordedPiece[]): RecordedPiece[] {
  return want.find(w => pieceKey(w) === pieceKey(ours)) ?? want[0]
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
      out.push({
        map, id, slot: rec.slot, verdict: g.verdict, detail: g.detail,
        oursImg: src ? renderPieces(ours, src) : null,
        hardwareImg: src ? renderPieces(closestFrame(want, ours), src) : null,
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
