/**
 * Reads a view's grid overlay back for specs: the hook (`data-grid-lines`,
 * grid-overlay.tsx) AND real pixels from the overlay canvas, so a hook that
 * claims lines the canvas never painted cannot pass.
 */

/**
 * `null` when the view has no overlay. Positions are CSS px (`x`, `y`, unique
 * and sorted); `xLines`/`yLines` are the raw device-px lines. `rowHits` and
 * `colHits` list EVERY device pixel with alpha > 0 along the middle of the
 * first cell, so an extra, missing, doubled or shifted line shows up.
 */
async function readGrid(page, root) {
  return page.evaluate(sel => {
    const el = document.querySelector(`${sel} .hb-grid-overlay`)
    if (!el) return null
    const lines = JSON.parse(el.dataset.gridLines)
    const ctx = el.getContext('2d')
    const W = el.width
    const H = el.height
    const data = ctx.getImageData(0, 0, W, H).data
    const alpha = (x, y) => data[(y * W + x) * 4 + 3]
    const dpr = Number(el.dataset.gridDpr)
    const cell = Number(el.dataset.gridCellPx)
    const midX = Math.round((cell * dpr) / 2)
    const midY = Math.round((cell * dpr) / 2)
    const uniq = ls => [...new Set(ls.map(l => l.pos))].sort((a, b) => a - b)
    const byPos = (ls, pos) => ls.find(l => l.pos === pos)
    const x = uniq(lines.x)
    const y = uniq(lines.y)
    const rowHits = []
    for (let i = 0; i < W; i++) if (alpha(i, midY) > 0) rowHits.push(i)
    const colHits = []
    for (let j = 0; j < H; j++) if (alpha(midX, j) > 0) colHits.push(j)
    return {
      cell,
      dpr,
      canvasW: W,
      canvasH: H,
      cssW: parseFloat(el.style.width),
      x,
      y,
      xLines: lines.x,
      yLines: lines.y,
      // Pixels ON the second vertical / horizontal line and on the LAST of each.
      vLine: alpha(byPos(lines.x, x[1]).start, midY),
      vLast: alpha(byPos(lines.x, x[x.length - 1]).start, midY),
      hLine: alpha(midX, byPos(lines.y, y[1]).start),
      hLast: alpha(midX, byPos(lines.y, y[y.length - 1]).start),
      mid: alpha(midX, midY),
      rowHits,
      colHits,
    }
  }, root)
}

/**
 * A real composited screenshot of the top-left of a canvas, as base64 PNG.
 * `region` is at most 200 CSS px square, from the canvas's own corner, so the
 * grid's pixel coordinates apply to it unchanged. The caller owns the pointer.
 */
async function shootCanvas(page, canvasSel) {
  await page.locator(canvasSel).scrollIntoViewIfNeeded()
  const box = await page.locator(canvasSel).boundingBox()
  const clip = {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.min(200, Math.floor(box.width)),
    height: Math.min(200, Math.floor(box.height)),
  }
  const png = await page.screenshot({ clip })
  return { b64: png.toString('base64'), ...clip }
}

/**
 * Compares a grid-off and a grid-on shot of the same region, numerically in
 * the page. Pixels on the hook's lines should change (the grid is visible in
 * the composited page, so a canvas stacked BELOW the content fails); every
 * pixel more than one pixel from a line must be identical (it is an overlay,
 * not a repaint). The one-pixel slack absorbs a fractional canvas offset.
 */
async function compositedGridDiff(page, off, on, grid) {
  return page.evaluate(
    async ({ offB64, onB64, xLines, yLines }) => {
      // Decoded numerically in the page; no image ever leaves it.
      const decode = async b64 => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        const c = new OffscreenCanvas(bmp.width, bmp.height)
        const ctx = c.getContext('2d')
        ctx.drawImage(bmp, 0, 0)
        return ctx.getImageData(0, 0, bmp.width, bmp.height)
      }
      const a = await decode(offB64)
      const b = await decode(onB64)
      const W = a.width
      const H = a.height
      const mask = new Uint8Array(W * H)
      const mark = (x0, x1, y0, y1) => {
        for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
          for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) mask[y * W + x] = 1
      }
      for (const l of xLines) mark(l.start, l.start + l.size, l.from, l.to)
      for (const l of yLines) mark(l.from, l.to, l.start, l.start + l.size)
      // The canvas can sit at a fractional page offset (measured: 299.66, 120.59),
      // so the clip, rounded to whole pixels, may be up to a pixel off the canvas's
      // own origin. A line pixel counts as changed if it OR a neighbour changed,
      // and "other" pixels exclude the mask dilated by one pixel.
      const changed = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) {
        changed[i] =
          a.data[i * 4] !== b.data[i * 4] ||
          a.data[i * 4 + 1] !== b.data[i * 4 + 1] ||
          a.data[i * 4 + 2] !== b.data[i * 4 + 2]
            ? 1
            : 0
      }
      const near = (arr, x, y) => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            const yy = y + dy
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && arr[yy * W + xx]) return true
          }
        return false
      }
      let lineTotal = 0
      let lineChanged = 0
      let otherChanged = 0
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (mask[y * W + x]) {
            lineTotal++
            if (near(changed, x, y)) lineChanged++
          } else if (changed[y * W + x] && !near(mask, x, y)) otherChanged++
        }
      }
      return { W, H, bW: b.width, bH: b.height, lineTotal, lineChanged, otherChanged }
    },
    {
      offB64: off.b64,
      onB64: on.b64,
      xLines: grid.xLines,
      yLines: grid.yLines,
    },
  )
}

/** RGBA at each `[x, y]` of a screenshot, read in the page. */
async function samplePixels(page, shot, points) {
  return page.evaluate(
    async ({ b64, points }) => {
      // Decoded numerically in the page; no image ever leaves it.
      const decode = async b64 => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        const c = new OffscreenCanvas(bmp.width, bmp.height)
        const ctx = c.getContext('2d')
        ctx.drawImage(bmp, 0, 0)
        return ctx.getImageData(0, 0, bmp.width, bmp.height)
      }
      const img = await decode(b64)
      return points.map(([x, y]) => {
        const i = (y * img.width + x) * 4
        return Array.from(img.data.slice(i, i + 4)).join(',')
      })
    },
    { b64: shot.b64, points },
  )
}

module.exports = { readGrid, shootCanvas, compositedGridDiff, samplePixels }
