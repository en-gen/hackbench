import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
// @ts-expect-error untyped generator module
import * as gen from '../../../tools/scripts/gen-app-icon.mjs'
import { appIconPath } from '../../../theia/extension/src/electron-main/icon-path'

const repo = path.resolve(__dirname, '../../..')
const d: string = gen.readPath()
const committed = (name: string) => fs.readFileSync(path.join(gen.OUT_DIR, name))
const SIZES: number[] = gen.ICON_SIZES
const rgba = (svg: string, n: number): Buffer => gen.render(svg, n).pixels
const alphaOf = (px: Buffer) => Array.from({ length: px.length / 4 }, (_, i) => px[i * 4 + 3])
const bareAlpha = (n: number) => alphaOf(rgba(gen.bareSvg(d), n))

// Exterior = pixels reachable from the border through near-transparent bare
// pixels. Holes (spots, face) are enclosed, so they are not exterior.
function exteriorOf(bare: number[], n: number) {
  const out = new Uint8Array(bare.length)
  const stack: number[] = []
  const push = (i: number) => {
    if (!out[i] && bare[i] <= 32) {
      out[i] = 1
      stack.push(i)
    }
  }
  for (let k = 0; k < n; k++) [k, (n - 1) * n + k, k * n, k * n + n - 1].forEach(push)
  while (stack.length) {
    const i = stack.pop()!
    const x = i % n
    if (x > 0) push(i - 1)
    if (x < n - 1) push(i + 1)
    if (i >= n) push(i - n)
    if (i < n * (n - 1)) push(i + n)
  }
  return out
}

// Antialiasing leaves at most a faint fringe outside; a backing leak is ~255,
// so 64/255 separates them.
const leaks = (n: number, backing?: string) => {
  const outside = exteriorOf(bareAlpha(n), n)
  return alphaOf(rgba(gen.coloredSvg(d, backing), n)).filter((a, i) => outside[i] && a > 64).length
}

// A hole pixel is enclosed and at most 32/255 covered by the path. The backing
// covers the rest, and two antialiased layers sharing an edge combine to
// 1 - p(1-p) >= 0.89 for p <= 32/255, i.e. alpha >= 227; 220 leaves margin.
const holeGaps = (n: number, backing?: string) => {
  const bare = bareAlpha(n)
  const outside = exteriorOf(bare, n)
  return alphaOf(rgba(gen.coloredSvg(d, backing), n)).filter(
    (a, i) => !outside[i] && bare[i] <= 32 && a < 220,
  ).length
}

// Brightness over a dark taskbar (#202020) of the outline-edge pixels, with the
// backing versus without it. Pixels are premultiplied, so over = rgb + bg(1-a).
// Pixels that touch a hole are skipped (white belongs there). The same gradient
// path is drawn both times, so any other difference is the backing leaking into
// the outline. Rounding allows a mean of 1/255; a rim is +24..+44.
const rimShift = (n: number, backing?: string) => {
  const bare = bareAlpha(n)
  const outside = exteriorOf(bare, n)
  const withB = rgba(gen.coloredSvg(d, backing), n)
  const without = rgba(gen.coloredSvg(d, ''), n)
  const holes = alphaOf(
    rgba(gen.coloredSvg('M0 0', gen.backingSvg(d)).replace('fill="url(#g)"', 'fill="none"'), n),
  )
  const over = (px: Buffer, i: number) => {
    const bg = 0x20 * (1 - px[i * 4 + 3] / 255)
    return (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3 + bg
  }
  let sum = 0
  let count = 0
  for (let i = 0; i < bare.length; i++) {
    const x = i % n
    const y = Math.floor(i / n)
    const nearOutside =
      (x > 0 && outside[i - 1]) ||
      (x < n - 1 && outside[i + 1]) ||
      (y > 0 && outside[i - n]) ||
      (y < n - 1 && outside[i + n])
    if (!outside[i] && !holes[i] && bare[i] > 0 && bare[i] < 255 && nearOutside) {
      sum += over(withB, i) - over(without, i)
      count++
    }
  }
  return count ? sum / count : 0
}

// The first attempt: the outer contour scaled 1%, which rimmed at small sizes.
const SCALED_CONTOUR = `<path fill="#fff" transform="translate(47.7 47.5) scale(.99) translate(-47.7 -47.5)" d="${gen.outerContour(d)}"/>`
// The hand-placed backing before that; it left slivers.
const OLD_BACKING =
  '<ellipse cx="47.7" cy="42" rx="43" ry="38" fill="#fff"/>' +
  '<rect x="22" y="58" width="52" height="30" rx="10" fill="#fff"/>'

function expectValidIco(ico: Buffer) {
  expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 5])
  SIZES.forEach((size, i) => {
    const e = 6 + 16 * i
    expect([ico[e] || 256, ico[e + 1] || 256]).toEqual([size, size])
    const len = ico.readUInt32LE(e + 8)
    const png = ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + len)
    expect(png.length).toBe(len)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size])
  })
}

describe('app icon generator', () => {
  it('outer contour starts at the absolute point the relative m implies', () => {
    expect(gen.outerContour(d).startsWith('M6.812 68.674c')).toBe(true)
  })

  it('colored SVG carries the title-bar path unchanged', () => {
    expect(gen.coloredSvg(d)).toContain(`d="${d}"`)
  })

  it.each(SIZES)('backing stays inside the silhouette at %i px', n => {
    expect(leaks(n)).toBe(0)
  })

  it('oracle: an enlarged backing leaks outside the silhouette', () => {
    const bigger = `<path fill="#fff" transform="scale(1.05)" d="${gen.outerContour(d)}"/>`
    expect(leaks(256, bigger)).toBeGreaterThan(100)
  })

  it.each(SIZES)('backing covers every hole at %i px', n => {
    expect(holeGaps(n)).toBe(0)
  })

  it('oracle: the old ellipse + rect backing leaves holes uncovered', () => {
    expect(holeGaps(256, OLD_BACKING)).toBeGreaterThan(100)
  })

  it.each(SIZES)('backing does not brighten the outline at %i px', n => {
    expect(Math.abs(rimShift(n))).toBeLessThan(1)
  })

  it('oracle: the 0.99-scaled contour backing rims at 16 px', () => {
    expect(rimShift(16, SCALED_CONTOUR)).toBeGreaterThan(10)
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
