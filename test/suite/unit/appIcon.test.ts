import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
// @ts-expect-error untyped generator module
import * as gen from '../../../tools/scripts/gen-app-icon.mjs'
import { appIconPath } from '../../../theia/extension/src/electron-main/icon-path'

const d: string = gen.readPath()
const svgPath = (svg: string) => /<path fill="url\(#g\)" d="([^"]+)"/.exec(svg)![1]
const alpha = (svg: string) => {
  const px: Buffer = gen.render(svg, 256).pixels
  return Array.from({ length: px.length / 4 }, (_, i) => px[i * 4 + 3])
}
// Exterior = pixels reachable from the border through near-transparent bare
// pixels; the holes (spots, face) are enclosed, so they are not exterior.
const exterior = (bare: number[], n: number) => {
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
// Antialiasing on the identical outline leaves at most a faint fringe in the
// exterior; a backing leak is ~255 alpha, so a 64/255 threshold separates them.
const leaks = (backing?: string) => {
  const colored = alpha(gen.coloredSvg(d, backing))
  const outside = exterior(alpha(gen.bareSvg(d)), 256)
  return colored.filter((a, i) => outside[i] && a > 64).length
}

describe('app icon generator', () => {
  it('colored SVG carries the title-bar path unchanged', () => {
    expect(svgPath(gen.coloredSvg(d))).toBe(d)
    expect(svgPath(fs.readFileSync(path.join(gen.OUT_DIR, 'icon.svg'), 'utf8'))).toBe(d)
  })

  it('white backing stays inside the silhouette', () => {
    expect(leaks()).toBe(0)
  })

  it('oracle: an enlarged backing ellipse leaks outside the silhouette', () => {
    expect(leaks('<ellipse cx="47.7" cy="42" rx="48" ry="45" fill="#fff"/>')).toBeGreaterThan(100)
  })

  it('icon.ico parses and holds exactly the five sizes', () => {
    const ico = fs.readFileSync(path.join(gen.OUT_DIR, 'icon.ico'))
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1])
    const count = ico.readUInt16LE(4)
    const sizes = Array.from({ length: count }, (_, i) => ico[6 + 16 * i] || 256)
    expect(sizes).toEqual([16, 24, 32, 48, 256])
  })

  it('icon.png is a 256 px PNG', () => {
    const png = fs.readFileSync(path.join(gen.OUT_DIR, 'icon.png'))
    expect(png.readUInt32BE(16)).toBe(256)
  })
})

describe('appIconPath', () => {
  it('points at an existing file, absolute, per platform', () => {
    for (const [platform, name] of [
      ['win32', 'icon.ico'],
      ['linux', 'icon.png'],
    ]) {
      const p = appIconPath(platform)
      expect(path.isAbsolute(p)).toBe(true)
      expect(path.basename(p)).toBe(name)
      expect(fs.existsSync(p)).toBe(true)
    }
  })

  it('resolves from the compiled lib location too, not from cwd', () => {
    const lib = path.resolve(
      __dirname,
      '../../../theia/extension/lib/theia/extension/src/electron-main',
    )
    expect(appIconPath('win32', lib)).toBe(appIconPath('win32'))
  })

  it('throws when no assets exist above the start dir', () => {
    expect(() => appIconPath('win32', fs.mkdtempSync(path.join(os.tmpdir(), 'noicon-')))).toThrow(
      /not found/,
    )
  })
})
