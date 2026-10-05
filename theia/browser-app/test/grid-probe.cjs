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

module.exports = { readGrid }
