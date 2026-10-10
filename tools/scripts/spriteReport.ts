/**
 * Sprite report, the pure half (#828): page text, frame pixels, PNG bytes, the
 * path guard. No ROM, so a synthetic test reaches all of it. The
 * rendered frames are ROM graphics (copyrighted): spriteReportRun.ts writes
 * them only outside this repository.
 */
import { deflateSync } from 'zlib'
import { existsSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { crc32 } from './capture_render'
import { objAttr, objSize, drawObj } from './capture_draw'

export const VERDICTS = ['exact', 'shape', 'close', 'wrong', 'empty', 'refused'] as const
export type ReportVerdict = (typeof VERDICTS)[number]

/** One graded sprite; image fields are links relative to the page, absent when nothing was drawn. */
export interface ReportRow {
  map: string
  id: number
  slot: number
  verdict: ReportVerdict
  detail?: string
  ours?: string
  hardware?: string
}

const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0')
const anchor = (r: ReportRow, n: number): string => `m${r.map}-s${hex2(r.id)}-${r.slot}-${n}`

/** Page files by relative path. Every row lands on exactly one verdict page and once in the index. */
export function buildReport(
  rows: ReportRow[],
  head: { sha: string; dirty: boolean },
): Map<string, string> {
  const files = new Map<string, string>()
  const keyed = rows.map((r, n) => ({ r, a: anchor(r, n) }))
  for (const v of VERDICTS) {
    const mine = keyed.filter(k => k.r.verdict === v)
    const body = mine.map(({ r, a }) =>
      [
        `<a id="${a}"></a>`,
        `### Sprite ${hex2(r.id)}, map ${r.map}, slot ${r.slot} (${v})`,
        '',
        '| ours | hardware |',
        '| --- | --- |',
        `| ${r.ours ? `![ours](${r.ours})` : 'none drawn'} | ${r.hardware ? `![hardware](${r.hardware})` : 'none recorded'} |`,
        ...(r.detail ? ['', r.detail] : []),
        '',
        '- [ ] corrupted',
        '',
      ].join('\n'),
    )
    files.set(
      `${v}.md`,
      `# ${v} (${mine.length})\n\n[index](index.md)\n\n${body.join('\n') || 'No sprites.\n'}`,
    )
  }
  const counts = VERDICTS.map(
    v => `[${v}](${v}.md): ${keyed.filter(k => k.r.verdict === v).length}`,
  )
  const byId = [...keyed].sort(
    (x, y) => x.r.id - y.r.id || x.r.map.localeCompare(y.r.map) || x.r.slot - y.r.slot,
  )
  const lines = byId.map(
    ({ r, a }) =>
      `- ${hex2(r.id)} map ${r.map} slot ${r.slot}: [${r.verdict}](${r.verdict}.md#${a})`,
  )
  files.set(
    'index.md',
    [
      `# Sprite report for hackbench ${head.sha}${head.dirty ? ' (working tree had uncommitted changes)' : ''}`,
      '',
      `${rows.length} graded. ${counts.join(', ')}.`,
      '',
      '## By sprite id',
      '',
      ...lines,
      '',
    ].join('\n'),
  )
  return files
}

export interface Rgba {
  w: number
  h: number
  px: Uint8Array
}
export interface DrawPiece {
  dx: number
  dy: number
  tile: number
  attr: number
  large: boolean
}
export interface FrameSource {
  vram: Uint8Array
  /** 256 RGB triples (capture_draw.palette). */
  pal: Uint8Array
  obsel: number
}

const BACKDROP = [48, 48, 56]

/**
 * The pieces drawn back to front on a grey backdrop, cropped to their bounds;
 * the same source draws both sides of a row, so a difference is in the pieces
 * and never in the renderer. Null when there are no pieces.
 */
export function renderPieces(pieces: DrawPiece[], src: FrameSource, scale = 2): Rgba | null {
  if (!pieces.length) return null
  const box = pieces.map(p => ({ p, s: objSize(src.obsel, +p.large) }))
  const x0 = Math.min(...box.map(b => b.p.dx))
  const y0 = Math.min(...box.map(b => b.p.dy))
  const w = Math.max(...box.map(b => b.p.dx + b.s[0])) - x0
  const h = Math.max(...box.map(b => b.p.dy + b.s[1])) - y0
  const px = new Uint8Array(w * scale * h * scale * 4)
  for (let i = 0; i < w * h * scale * scale; i++) px.set([...BACKDROP, 255], i * 4)
  const put = (x: number, y: number, ci: number) => {
    for (let k = 0; k < scale * scale; k++) {
      const o = ((y * scale + ((k / scale) | 0)) * w * scale + x * scale + (k % scale)) * 4
      px.set([src.pal[ci * 3], src.pal[ci * 3 + 1], src.pal[ci * 3 + 2], 255], o)
    }
  }
  // OAM entry 0 is drawn on top, so the list runs in reverse.
  for (const { p } of [...box].reverse()) {
    const o = objAttr(src.obsel, p.tile, p.attr, +p.large)
    drawObj(src.vram, o, p.dx - x0, p.dy - y0, (x, y, ci) => {
      if (x >= 0 && y >= 0 && x < w && y < h) put(x, y, ci)
    })
  }
  return { w: w * scale, h: h * scale, px }
}

/** Verdict border colours for the contact sheet. */
const BORDER: Record<ReportVerdict, number[]> = {
  exact: [60, 200, 90],
  shape: [170, 210, 60],
  close: [235, 200, 50],
  wrong: [230, 70, 60],
  empty: [150, 150, 150],
  refused: [150, 150, 150],
}

export interface SheetCell {
  verdict: ReportVerdict
  ours: Rgba | null
  hardware: Rgba | null
}

/** One image: each cell is ours then hardware inside a verdict-coloured box, `cols` cells per row. */
export function contactSheet(cells: SheetCell[], cols = 6): Rgba {
  const pad = 3
  const cw = Math.max(8, ...cells.flatMap(c => [c.ours?.w ?? 0, c.hardware?.w ?? 0])) * 2 + pad * 3
  const ch = Math.max(8, ...cells.flatMap(c => [c.ours?.h ?? 0, c.hardware?.h ?? 0])) + pad * 2
  const rows = Math.max(1, Math.ceil(cells.length / cols))
  const w = cw * Math.min(cols, Math.max(1, cells.length))
  const h = ch * rows
  const px = new Uint8Array(w * h * 4).fill(20)
  const set = (x: number, y: number, c: number[]) => px.set([...c, 255], (y * w + x) * 4)
  const half = (cw - pad * 3) / 2
  cells.forEach((c, i) => {
    const [ox, oy] = [(i % cols) * cw, ((i / cols) | 0) * ch]
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++)
        if (x < 2 || y < 2 || x >= cw - 2 || y >= ch - 2) set(ox + x, oy + y, BORDER[c.verdict])
    ;[c.ours, c.hardware].forEach((img, side) => {
      if (!img) return
      const bx = ox + pad + side * (half + pad)
      for (let y = 0; y < img.h; y++)
        px.set(img.px.subarray(y * img.w * 4, (y + 1) * img.w * 4), ((oy + pad + y) * w + bx) * 4)
    })
  })
  return { w, h, px }
}

const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])))
  return Buffer.concat([head, Buffer.from(type), data, crc])
}

/** 8-bit RGBA PNG; the CRC is capture_render's, the layout the same as gen_diff_images.ts. */
export function encodePng(img: Rgba): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.w, 0)
  ihdr.writeUInt32BE(img.h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(img.h * (1 + img.w * 4))
  for (let y = 0; y < img.h; y++)
    raw.set(img.px.subarray(y * img.w * 4, (y + 1) * img.w * 4), y * (1 + img.w * 4) + 1)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** `p` resolved, with its nearest existing ancestor realpath'd so junctions and 8.3 or UNC spellings compare equal. */
function real(p: string): string {
  let head = resolve(p)
  const tail: string[] = []
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head))
    head = dirname(head)
  }
  const r = join(realpathSync.native(head), ...tail)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** True when `path` is `root` or lies under it, after following links in the existing part of both. */
export function isInside(path: string, root: string): boolean {
  const rel = relative(real(root), real(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
