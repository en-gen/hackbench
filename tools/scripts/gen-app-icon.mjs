// Generates the window/taskbar icon from the title-bar mushroom path in
// build/icons/icon.svg: gray gradient fill over a white backing.
// Run: npm run gen:icon
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// The icon has no text; scanning system fonts costs ~250 ms per Resvg.
const NO_FONTS = { font: { loadSystemFonts: false } }
export const ICON_SIZES = [16, 20, 24, 30, 32, 40, 48, 64, 96, 128, 256]
export const OUT_DIR = path.join(root, 'build/icons/app')
// Square viewBox centered on the 95.41467 x 95 artwork, so icon sizes do not distort it.
const VIEWBOX = '0 -0.20733 95.41467 95.41467'

export const readPath = () =>
  /<path d="([^"]+)"/.exec(readFileSync(path.join(root, 'build/icons/icon.svg'), 'utf8'))[1]

// Absolute-start subpaths. A relative `m` after `z` is measured from the start
// of the subpath just closed, so each start is the previous start plus offset.
export function subpaths(d) {
  const m = /^\s*m\s*(-?[\d.]+)[\s,]*(-?[\d.]+)/i
  let x = 0
  let y = 0
  return d
    .split(/z/i)
    .filter(chunk => m.test(chunk))
    .map((chunk, i) => {
      const [dx, dy] = m.exec(chunk).slice(1).map(Number)
      ;[x, y] = i === 0 ? [dx, dy] : [x + dx, y + dy]
      return chunk.replace(m, `M${+x.toFixed(3)} ${+y.toFixed(3)}`) + 'z'
    })
}

const bbox = sub => {
  const b = new Resvg(bareSvg(sub), NO_FONTS).getBBox()
  return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height }
}
const inside = (a, b) =>
  a.x0 >= b.x0 - 0.01 && a.y0 >= b.y0 - 0.01 && a.x1 <= b.x1 + 0.01 && a.y1 <= b.y1 + 0.01
const area = b => (b.x1 - b.x0) * (b.y1 - b.y0)

// Roles by bounding box, never by index: the outer contour contains every other
// subpath, a hole is directly inside it, an eye is inside a hole.
const classified = new Map()
export function classify(d) {
  if (!classified.has(d)) classified.set(d, classifyUncached(d))
  return classified.get(d)
}

function classifyUncached(d) {
  const subs = subpaths(d).map(path => ({ path, box: bbox(path) }))
  const outer = subs.find(s => subs.every(o => o === s || inside(o.box, s.box)))
  const rest = subs.filter(s => s !== outer)
  const parent = s =>
    rest.filter(o => o !== s && inside(s.box, o.box)).sort((a, b) => area(a.box) - area(b.box))[0]
  return {
    outer: outer.path,
    holes: rest.filter(s => !parent(s)).map(s => s.path),
    eyes: rest.filter(s => parent(s)).map(s => s.path),
  }
}

const GRADIENT =
  '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="95" x2="0" y2="0">' +
  '<stop offset="0" stop-color="#2b2b2b"/><stop offset="1" stop-color="#9a9a9a"/></linearGradient></defs>'

// Opaque layers painted in order, so no two layers share an edge over
// transparency (that left a see-through seam): the outer contour in gradient
// (one antialiased outer edge), each hole as its own white path (own path, so
// winding cannot cancel it), each eye in the same gradient over the white.
export function coloredSvg(d) {
  const { outer, holes, eyes } = classify(d)
  const layer = (fill, p) => `<path fill="${fill}" d="${p}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}">${GRADIENT}` +
    layer('url(#g)', outer) +
    holes.map(h => layer('#fff', h)).join('') +
    eyes.map(e => layer('url(#g)', e)).join('') +
    '</svg>'
  )
}

export const bareSvg = d =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}"><path d="${d}"/></svg>`

export const render = (svg, size) =>
  new Resvg(svg, { ...NO_FONTS, fitTo: { mode: 'width', value: size } }).render()

// ICO with PNG-compressed entries (supported since Vista). Size 256 is stored as 0.
function buildIco(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(pngs.length, 4)
  let offset = head.length
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i
    head[e] = head[e + 1] = size === 256 ? 0 : size
    head.writeUInt16LE(1, e + 4)
    head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(png.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...pngs.map(p => p.png)])
}

/** The three committed files, as bytes. */
export function buildAll() {
  const svg = coloredSvg(readPath())
  const pngs = ICON_SIZES.map(size => ({ size, png: render(svg, size).asPng() }))
  return {
    'icon.svg': svg,
    'icon.png': pngs.find(p => p.size === 256).png,
    'icon.ico': buildIco(pngs),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT_DIR, { recursive: true })
  for (const [name, data] of Object.entries(buildAll()))
    writeFileSync(path.join(OUT_DIR, name), data)
}
