// Generates the window/taskbar icon from the title-bar mushroom path in
// build/icons/icon.svg: gray gradient fill, white backing under the holes.
// Run: node tools/scripts/gen-app-icon.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const ICON_SIZES = [16, 24, 32, 48, 256]
export const OUT_DIR = path.join(root, 'build/icons/app')
export const BACKING =
  '<ellipse cx="47.7" cy="42" rx="43" ry="38" fill="#fff"/>' +
  '<rect x="22" y="58" width="52" height="30" rx="10" fill="#fff"/>'
// Square viewBox centered on the 95.41467 x 95 artwork, so icon sizes do not distort it.
const VIEWBOX = '0 -0.20733 95.41467 95.41467'

export const readPath = () =>
  /<path d="([^"]+)"/.exec(readFileSync(path.join(root, 'build/icons/icon.svg'), 'utf8'))[1]

export const coloredSvg = (d, backing = BACKING) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}">` +
  '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="95" x2="0" y2="0">' +
  '<stop offset="0" stop-color="#2b2b2b"/><stop offset="1" stop-color="#9a9a9a"/></linearGradient></defs>' +
  `${backing}<path fill="url(#g)" d="${d}"/></svg>`

export const bareSvg = d =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}"><path d="${d}"/></svg>`

export const render = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render()

// ICO with PNG-compressed entries (supported since Vista). Size 256 is stored as 0.
export function buildIco(pngs) {
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const svg = coloredSvg(readPath())
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(path.join(OUT_DIR, 'icon.svg'), svg)
  writeFileSync(path.join(OUT_DIR, 'icon.png'), render(svg, 256).asPng())
  const pngs = ICON_SIZES.map(size => ({ size, png: render(svg, size).asPng() }))
  writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(pngs))
}
