// Generates the window/taskbar icon from the title-bar mushroom path in
// build/icons/icon.svg: gray gradient fill over a white backing.
// Run: npm run gen:icon
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const ICON_SIZES = [16, 24, 32, 48, 256]
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

// The outer silhouette is the second subpath; every other one is a hole or
// something inside one (spots, face, eyes).
export const outerContour = d => subpaths(d)[1]

// White under every subpath except the outer contour. It never reaches the
// outer edge, so it cannot rim or halo the outline at any size; its edges are
// the holes' own edges. Eyes get white too, and the gray path paints over them.
export const backingSvg = d =>
  `<path fill="#fff" d="${subpaths(d)
    .filter((_, i) => i !== 1)
    .join('')}"/>`

export const coloredSvg = (d, backing = backingSvg(d)) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}">` +
  '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="95" x2="0" y2="0">' +
  '<stop offset="0" stop-color="#2b2b2b"/><stop offset="1" stop-color="#9a9a9a"/></linearGradient></defs>' +
  `${backing}<path fill="url(#g)" d="${d}"/></svg>`

export const bareSvg = d =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}"><path d="${d}"/></svg>`

export const render = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render()

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
