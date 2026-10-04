import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Resvg } from '@resvg/resvg-js'
// @ts-expect-error untyped generator module
import * as gen from '../../../tools/scripts/gen-app-icon.mjs'
import { appIconPath } from '../../../theia/extension/src/electron-main/icon-path'

const repo = path.resolve(__dirname, '../../..')
const d: string = gen.readPath()
const SIZES: number[] = gen.ICON_SIZES
const roles = gen.classify(d) as { outer: string; holes: string[]; eyes: string[] }
const committed = (name: string) => fs.readFileSync(path.join(gen.OUT_DIR, name))

const cache = new Map<string, Buffer>()
const rgba = (svg: string, n: number): Buffer => {
  const key = `${n}:${svg}`
  if (!cache.has(key)) cache.set(key, gen.render(svg, n).pixels)
  return cache.get(key)!
}
const VB = '0 -0.20733 95.41467 95.41467'
// Oracles are built here from fixed inputs (the path's own subpaths and a
// restated gradient), not from the production layers.
const wrap = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB}"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="95" x2="0" y2="0"><stop offset="0" stop-color="#2b2b2b"/><stop offset="1" stop-color="#9a9a9a"/></linearGradient></defs>${body}</svg>`
const outerAlone = (fill: string) => wrap(`<path fill="${fill}" d="${roles.outer}"/>`)
const holesAlone = wrap(roles.holes.map(h => `<path fill="#000" d="${h}"/>`).join(''))
const silhouette = (n: number) => rgba(outerAlone('#000'), n)
const holeAlpha = (n: number) => rgba(holesAlone, n)

const count = (svg: string, n: number, bad: (px: Buffer, sil: Buffer, i: number) => boolean) => {
  const px = rgba(svg, n)
  const sil = silhouette(n)
  let c = 0
  for (let i = 0; i < n * n; i++) if (bad(px, sil, i)) c++
  return c
}
// Silhouette pixels (holes count as opaque) that the icon leaves see-through.
const seams = (svg: string, n: number) =>
  count(svg, n, (px, sil, i) => sil[i * 4 + 3] === 255 && px[i * 4 + 3] < 254)
// Icon alpha differing from the silhouette alpha. Both antialias the same
// outer edge once. The one real difference: below ~30 px a hole edge can sit
// inside an outer-edge pixel (the side spots are under one pixel from the
// outline at 16 px), and its white adds up to 29/255 there (measured at 16 px;
// 1 at 32 px, 0 from 40 px up). A leak is ~255, so 32 separates them.
const alphaOff = (svg: string, n: number) =>
  count(svg, n, (px, sil, i) => Math.abs(px[i * 4 + 3] - sil[i * 4 + 3]) > 32)
// Outer-edge pixels (partly covered, no hole content) must equal the outer
// contour alone in gradient, per channel within 1/255.
const rimOff = (svg: string, n: number) => {
  const ref = rgba(outerAlone('url(#g)'), n)
  const holes = holeAlpha(n)
  return count(svg, n, (px, sil, i) => {
    if (sil[i * 4 + 3] === 0 || sil[i * 4 + 3] === 255 || holes[i * 4 + 3] > 0) return false
    return [0, 1, 2, 3].some(k => Math.abs(px[i * 4 + k] - ref[i * 4 + k]) > 1)
  })
}

// Earlier backings, kept as planted defects the tests must catch.
const nonOuter = [...roles.holes, ...roles.eyes].join('')
const ROUND3 = wrap(`<path fill="#fff" d="${nonOuter}"/><path fill="url(#g)" d="${d}"/>`)
const SCALED = wrap(
  `<path fill="#fff" transform="translate(47.7 47.5) scale(.99) translate(-47.7 -47.5)" d="${roles.outer}"/><path fill="url(#g)" d="${d}"/>`,
)
const OLD_ELLIPSE = wrap(
  `<ellipse cx="47.7" cy="42" rx="43" ry="38" fill="#fff"/><path fill="url(#g)" d="${d}"/>`,
)
const LEAKY = wrap(
  `<path fill="#fff" transform="scale(1.05)" d="${roles.outer}"/><path fill="url(#g)" d="${d}"/>`,
)

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (b: Buffer) => {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
// Walks the PNG chunks from `off`, checking each CRC, and returns the offset
// just past IEND (throws if the stream ends before IEND or a CRC is wrong).
function pngEnd(buf: Buffer, off: number): number {
  expect(buf.subarray(off, off + 8).toString('hex')).toBe('89504e470d0a1a0a')
  let p = off + 8
  for (;;) {
    const len = buf.readUInt32BE(p)
    const type = buf.subarray(p + 4, p + 8)
    expect(crc32(buf.subarray(p + 4, p + 8 + len)), type.toString()).toBe(
      buf.readUInt32BE(p + 8 + len),
    )
    p += 12 + len
    if (type.toString() === 'IEND') return p
  }
}

function expectValidIco(ico: Buffer) {
  expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([
    0,
    1,
    SIZES.length,
  ])
  SIZES.forEach((size, i) => {
    const e = 6 + 16 * i
    expect([ico[e] || 256, ico[e + 1] || 256]).toEqual([size, size])
    expect([ico.readUInt16LE(e + 4), ico.readUInt16LE(e + 6)]).toEqual([1, 32])
    const len = ico.readUInt32LE(e + 8)
    const off = ico.readUInt32LE(e + 12)
    expect(pngEnd(ico, off), `entry ${size}`).toBe(off + len)
    expect([ico.readUInt32BE(off + 16), ico.readUInt32BE(off + 20)]).toEqual([size, size])
  })
}

describe('app icon generator', () => {
  it('has the sizes the owner approved, ascending', () => {
    expect(SIZES).toEqual([16, 20, 24, 30, 32, 40, 48, 64, 96, 128, 256])
  })

  it('classifies 1 outer contour, 4 holes and 2 eyes, by geometry', () => {
    expect(roles.outer.startsWith('M6.812 68.674c')).toBe(true)
    expect(roles.holes).toHaveLength(4)
    expect(roles.eyes).toHaveLength(2)
  })

  it('the subpaths reproduce icon.svg geometry, and the roles partition them', () => {
    const body = (s: string) => s.replace(/^\s*m\s*-?[\d.]+[\s,]*-?[\d.]+/i, '').replace(/z$/i, '')
    const original = d.split(/z/i).filter(c => /\S/.test(c))
    const subs: string[] = gen.subpaths(d)
    expect(subs.map(body)).toEqual(original.map(body))
    expect([roles.outer, ...roles.holes, ...roles.eyes].sort()).toEqual([...subs].sort())
  })

  it.each(SIZES)('no see-through seam inside the silhouette at %i px', n => {
    expect(seams(gen.coloredSvg(d), n)).toBe(0)
  })

  it.each(SIZES)('icon alpha equals the silhouette (no leak, no gap) at %i px', n => {
    expect(alphaOff(gen.coloredSvg(d), n)).toBe(0)
  })

  it.each(SIZES)('outer edge is the plain gradient edge at %i px', n => {
    expect(rimOff(gen.coloredSvg(d), n)).toBe(0)
  })

  it.each(SIZES)(
    'every pixel fully inside a hole and outside both eyes is pure white at %i px',
    n => {
      const px = rgba(gen.coloredSvg(d), n)
      const eyes = roles.eyes.map(e => rgba(wrap(`<path fill="#000" d="${e}"/>`), n))
      for (const [k, hole] of roles.holes.entries()) {
        const mask = rgba(wrap(`<path fill="#000" d="${hole}"/>`), n)
        let sampled = 0
        for (let i = 0; i < n * n; i++) {
          if (mask[i * 4 + 3] !== 255 || eyes.some(e => e[i * 4 + 3] !== 0)) continue
          sampled++
          expect([...px.subarray(i * 4, i * 4 + 4)], `hole ${k} pixel ${i}`).toEqual([
            255, 255, 255, 255,
          ])
        }
        expect(sampled, `hole ${k} has sample pixels`).toBeGreaterThan(0)
      }
    },
  )

  it('an eye center is gray, not white', () => {
    for (const eye of roles.eyes) {
      const box = new Resvg(gen.bareSvg(eye), {
        font: { loadSystemFonts: false },
      }).getBBox()!
      for (const n of [64, 256]) {
        const px = rgba(gen.coloredSvg(d), n)
        const x = Math.floor(((box.x + box.width / 2) / 95.41467) * n)
        const y = Math.floor(((box.y + box.height / 2 + 0.20733) / 95.41467) * n)
        const i = (y * n + x) * 4
        expect(px[i + 3]).toBe(255)
        expect(px[i]).toBeLessThan(128)
      }
    }
  })

  it('subpaths: absolute M after z is absolute, relative m is relative', () => {
    expect(gen.subpaths('m10 10h10v10h-10zM20 20h5v5h-5z')[1].startsWith('M20 20')).toBe(true)
    expect(gen.subpaths('m10 10h10v10h-10zm5 5h5v5h-5z')[1].startsWith('M15 15')).toBe(true)
  })

  it('classify refuses what it cannot read, with a reason', () => {
    const sq = (x: number, y: number, w: number) => `M${x} ${y}h${w}v${w}h-${w}z`
    expect(() => gen.classify(sq(0, 0, 10) + sq(20, 0, 10))).toThrow(/exactly one/)
    expect(() => gen.classify(sq(0, 0, 10) + sq(0, 0, 10))).toThrow(/identical/)
    expect(() =>
      gen.classify(sq(0, 0, 100) + sq(10, 10, 50) + sq(20, 20, 20) + sq(25, 25, 10)),
    ).toThrow(/depth/)
  })

  it('oracle: the round-3 backing leaves seams at every size', () => {
    for (const n of SIZES) expect(seams(ROUND3, n)).toBeGreaterThan(0)
  })

  it('oracle: the 1%-scaled contour backing rims the outline at 16 px', () => {
    expect(rimOff(SCALED, 16)).toBeGreaterThan(0)
  })

  it('oracle: the old ellipse backing leaves holes see-through', () => {
    expect(seams(OLD_ELLIPSE, 256)).toBeGreaterThan(100)
  })

  it('oracle: an enlarged backing leaks outside the silhouette', () => {
    expect(alphaOff(LEAKY, 256)).toBeGreaterThan(100)
  })

  it('generator output: square viewBox, gradient stops, valid ico', () => {
    const out = gen.buildAll()
    const [, , w, h] = /viewBox="([^"]+)"/.exec(out['icon.svg'])![1].split(' ').map(Number)
    expect(w).toBe(h)
    expect(out['icon.svg']).toContain('stop-color="#2b2b2b"')
    expect(out['icon.svg']).toContain('stop-color="#9a9a9a"')
    expectValidIco(out['icon.ico'])
  })

  it('committed svg, png and ico are byte-identical to fresh generator output', () => {
    for (const [name, data] of Object.entries<string | Buffer>(gen.buildAll())) {
      expect(committed(name).equals(Buffer.from(data)), name).toBe(true)
    }
  })

  it('committed icon.ico parses', () => {
    expectValidIco(committed('icon.ico'))
  })

  it('icon.png is 256 x 256', () => {
    const png = committed('icon.png')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([256, 256])
  })
})

describe('appIconPath', () => {
  const runtimeDir = path.join(repo, 'theia/electron-app/lib/backend')

  it('points at an existing absolute file, per platform', () => {
    for (const [platform, name] of [
      ['win32', 'icon.ico'],
      ['linux', 'icon.png'],
    ]) {
      const p = appIconPath(platform)!
      expect(path.isAbsolute(p)).toBe(true)
      expect(path.basename(p)).toBe(name)
      expect(fs.existsSync(p)).toBe(true)
    }
  })

  it('resolves from the bundled backend directory, not from the cwd', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'))
    vi.spyOn(process, 'cwd').mockReturnValue(elsewhere)
    try {
      expect(appIconPath('win32', runtimeDir)).toBe(appIconPath('win32'))
      expect(fs.existsSync(appIconPath('win32')!)).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('is undefined, not a throw, when the assets are missing', () => {
    expect(appIconPath('win32', fs.mkdtempSync(path.join(os.tmpdir(), 'noicon-')))).toBeUndefined()
  })

  it('is undefined when the folder exists but the file does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emptyicon-'))
    fs.mkdirSync(path.join(dir, 'build/icons/app'), { recursive: true })
    expect(appIconPath('win32', dir)).toBeUndefined()
  })
})

describe('electronMain registration', () => {
  it('theiaExtensions loads the compiled icon module in Electron main', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repo, 'theia/extension/package.json'), 'utf8'),
    ) as { theiaExtensions: { electronMain?: string }[] }
    const entry = pkg.theiaExtensions.find(e => e.electronMain)
    expect(entry?.electronMain).toBe('lib/theia/extension/src/electron-main/electron-main-module')
  })
})
