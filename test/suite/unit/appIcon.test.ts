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
const alpha = (svg: string) => {
  const px: Buffer = gen.render(svg, 256).pixels
  return Array.from({ length: px.length / 4 }, (_, i) => px[i * 4 + 3])
}
const bare = alpha(gen.bareSvg(d))
const N = 256

// Exterior = pixels reachable from the border through near-transparent bare
// pixels. Holes (spots, face) are enclosed, so they are not exterior.
const exterior = (() => {
  const out = new Uint8Array(bare.length)
  const stack: number[] = []
  const push = (i: number) => {
    if (!out[i] && bare[i] <= 32) {
      out[i] = 1
      stack.push(i)
    }
  }
  for (let k = 0; k < N; k++) [k, (N - 1) * N + k, k * N, k * N + N - 1].forEach(push)
  while (stack.length) {
    const i = stack.pop()!
    const x = i % N
    if (x > 0) push(i - 1)
    if (x < N - 1) push(i + 1)
    if (i >= N) push(i - N)
    if (i < N * (N - 1)) push(i + N)
  }
  return out
})()
// Antialiasing leaves at most a faint fringe outside; a backing leak is ~255,
// so 64/255 separates them.
const leaks = (backing?: string) =>
  alpha(gen.coloredSvg(d, backing)).filter((a, i) => exterior[i] && a > 64).length
// A hole pixel is transparent in the bare path and enclosed. The backing is
// opaque white, which rasterizes to exactly 255; 250 only tolerates rounding.
const holeGaps = (backing?: string) =>
  alpha(gen.coloredSvg(d, backing)).filter((a, i) => !exterior[i] && bare[i] <= 32 && a < 250)
    .length

// The hand-placed backing the programmatic contour replaced; it left slivers.
const OLD_BACKING =
  '<ellipse cx="47.7" cy="42" rx="43" ry="38" fill="#fff"/>' +
  '<rect x="22" y="58" width="52" height="30" rx="10" fill="#fff"/>'

describe('app icon generator', () => {
  it('outer contour starts at the absolute point the relative m implies', () => {
    expect(gen.outerContour(d).startsWith('M6.812 68.674c')).toBe(true)
  })

  it('colored SVG carries the title-bar path unchanged', () => {
    expect(gen.coloredSvg(d)).toContain(`d="${d}"`)
  })

  it('white backing stays inside the silhouette', () => {
    expect(leaks()).toBe(0)
  })

  it('oracle: an enlarged backing leaks outside the silhouette', () => {
    const bigger = gen.backingSvg(d).replace('scale(.99)', 'scale(1.05)')
    expect(leaks(bigger)).toBeGreaterThan(100)
  })

  it('backing covers every hole', () => {
    expect(holeGaps()).toBe(0)
  })

  it('oracle: the old ellipse + rect backing leaves holes uncovered', () => {
    expect(holeGaps(OLD_BACKING)).toBeGreaterThan(100)
  })

  it('committed svg, png and ico are byte-identical to fresh generator output', () => {
    for (const [name, data] of Object.entries<string | Buffer>(gen.buildAll())) {
      expect(committed(name).equals(Buffer.from(data)), name).toBe(true)
    }
  })

  it('icon.ico parses: five entries, each pointing at a PNG of its size', () => {
    const ico = committed('icon.ico')
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 5])
    const sizes = [16, 24, 32, 48, 256]
    sizes.forEach((size, i) => {
      const e = 6 + 16 * i
      expect([ico[e] || 256, ico[e + 1] || 256]).toEqual([size, size])
      const len = ico.readUInt32LE(e + 8)
      const png = ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + len)
      expect(png.length).toBe(len)
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size])
    })
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
