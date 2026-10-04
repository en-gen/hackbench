const { contrastRatio } = require('./palette-color.cjs')

/**
 * What shows through a graphics canvas's transparent pixels, read from the
 * screen rather than from CSS: a class that is present but paints nothing,
 * or a checkerboard hidden behind an opaque fill, both pass a style check.
 */

/** Half of `background-size` in pixel-canvas.css. */
const CHECKER_CELL_CSS_PX = 8

/**
 * Screenshots the visible part of the canvas, then samples the on-screen
 * color at every native pixel whose alpha is 0, split by which checker
 * square it falls in. Returns each square's most common color.
 *
 * Split by square, not just "two colors seen": overlays (hover dim, handle
 * outlines) add colors of their own, which made a flat background pass.
 */
async function transparentShowsThrough(page, selector, coverSelector) {
  // Only what is on screen: a canvas taller than its scroll box screenshots
  // blank beyond the box, which reads as a flat color.
  const clip = await page.evaluate(sel => {
    const canvas = document.querySelector(sel)
    let r = canvas.getBoundingClientRect()
    let [x0, y0, x1, y1] = [r.left, r.top, r.right, r.bottom]
    for (let n = canvas.parentElement; n; n = n.parentElement) {
      if (getComputedStyle(n).overflow === 'visible') continue
      r = n.getBoundingClientRect()
      ;[x0, y0, x1, y1] = [
        Math.max(x0, r.left),
        Math.max(y0, r.top),
        Math.min(x1, r.right),
        Math.min(y1, r.bottom),
      ]
    }
    x0 = Math.max(x0, 0)
    y0 = Math.max(y0, 0)
    x1 = Math.min(x1, innerWidth)
    y1 = Math.min(y1, innerHeight)
    return {
      x: Math.ceil(x0),
      y: Math.ceil(y0),
      width: Math.floor(x1 - Math.ceil(x0)),
      height: Math.floor(y1 - Math.ceil(y0)),
    }
  }, selector)
  const png = (await page.screenshot({ clip })).toString('base64')
  return page.evaluate(
    async ({ sel, png, cell, clip, cover }) => {
      const canvas = document.querySelector(sel)
      const box = canvas.getBoundingClientRect()
      const native = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      // A plane stacked above this one hides what it covers: only pixels clear in both show through.
      const over = cover && document.querySelector(cover)
      const above = over && over.getContext('2d').getImageData(0, 0, over.width, over.height).data
      const img = new Image()
      img.src = `data:image/png;base64,${png}`
      await img.decode()
      const shot = document.createElement('canvas')
      shot.width = img.width
      shot.height = img.height
      const sctx = shot.getContext('2d')
      sctx.drawImage(img, 0, 0)
      const onScreen = sctx.getImageData(0, 0, img.width, img.height).data
      const shotPerCss = img.width / clip.width
      const cssPerNative = box.width / canvas.width
      const counts = [new Map(), new Map()]
      let transparentPixels = 0
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (native[(y * canvas.width + x) * 4 + 3] !== 0) continue
          if (above && above[(y * canvas.width + x) * 4 + 3] !== 0) continue
          // Center of the native pixel, in CSS px from the canvas's top left.
          const cx = (x + 0.5) * cssPerNative
          const cy = (y + 0.5) * cssPerNative
          const vx = box.left + cx - clip.x
          const vy = box.top + cy - clip.y
          if (vx < 0 || vy < 0 || vx >= clip.width || vy >= clip.height) continue
          const square = (Math.floor(cx / cell) + Math.floor(cy / cell)) % 2
          const i = (Math.floor(vy * shotPerCss) * img.width + Math.floor(vx * shotPerCss)) * 4
          const key = `${onScreen[i]},${onScreen[i + 1]},${onScreen[i + 2]}`
          counts[square].set(key, (counts[square].get(key) ?? 0) + 1)
          transparentPixels++
        }
      }
      const mode = m => [...m].sort((a, b) => b[1] - a[1])[0]?.[0]
      return { transparentPixels, squares: counts.map(mode) }
    },
    { sel: selector, png, cell: CHECKER_CELL_CSS_PX, clip, cover: coverSelector },
  )
}

/** A two-tone checkerboard shows through: not a flat panel color, not invisible. */
async function expectCheckerboard(expect, page, selector, coverSelector) {
  const seen = await transparentShowsThrough(page, selector, coverSelector)
  expect(seen.transparentPixels, `${selector} has color-0 pixels to see through`).toBeGreaterThan(0)
  expect(seen.squares[0], `${selector} alternates tones`).not.toBe(seen.squares[1])
  const [a, b] = seen.squares.map(k => k.split(',').map(Number))
  expect(contrastRatio(a, b), `${selector} tones are distinguishable`).toBeGreaterThan(1.1)
}

module.exports = { expectCheckerboard }
