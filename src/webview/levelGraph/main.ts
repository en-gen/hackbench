/**
 * Level interconnection graph webview.
 *
 * Receives { type:'load', nodes, edges, slug } from the extension host.
 * Renders a hierarchical SVG graph: columns = BFS depth from overworld roots,
 * rows = position within the depth group.  Nodes are clickable links that
 * send { type:'openLevel', levelIndex } back to the extension.
 *
 * Navigation: mouse-wheel to zoom, drag to pan.
 */

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void
}
export {}

interface GraphNode {
  id: number
  hex: string
  name: string | null
  isOverworld: boolean
}

interface GraphEdge {
  source: number
  target: number
}

interface LayoutNode extends GraphNode {
  x: number
  y: number
}

const vscode = acquireVsCodeApi()

const SVG_NS = 'http://www.w3.org/2000/svg'
const NODE_W = 210
const NODE_H = 24
const COL_GAP = 160
const ROW_GAP = 30
const MARGIN = 20

// ── Layout ────────────────────────────────────────────────────────────────────

function buildLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: LayoutNode[]; width: number; height: number } {
  const nodeMap = new Map<number, GraphNode>(nodes.map(n => [n.id, n]))

  // Build adjacency list (outgoing edges)
  const adj = new Map<number, number[]>()
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source)!.push(e.target)
  }

  // Collect all node IDs referenced by at least one edge
  const referenced = new Set<number>()
  for (const e of edges) {
    referenced.add(e.source)
    referenced.add(e.target)
  }

  // BFS depth from overworld roots
  const depth = new Map<number, number>()
  const queue: number[] = []
  for (const n of nodes) {
    if (n.isOverworld && referenced.has(n.id)) {
      depth.set(n.id, 0)
      queue.push(n.id)
    }
  }
  let qi = 0
  while (qi < queue.length) {
    const id = queue[qi++]
    const d = depth.get(id)!
    for (const nb of (adj.get(id) ?? [])) {
      if (!depth.has(nb)) {
        depth.set(nb, d + 1)
        queue.push(nb)
      }
    }
  }
  // Unreachable but referenced nodes get depth = max+1
  {
    const maxDepth = Math.max(0, ...depth.values())
    for (const id of referenced) {
      if (!depth.has(id)) depth.set(id, maxDepth + 1)
    }
  }

  // Forward-push pass: for every edge A→B where depth[A] >= depth[B],
  // push B to depth[A]+1. Repeat until stable (capped at node-count
  // iterations to handle cycles — any remaining back-edges get filtered
  // during rendering instead of looping forever).
  for (let pass = 0; pass < depth.size; pass++) {
    let changed = false
    for (const e of edges) {
      const da = depth.get(e.source)
      const db = depth.get(e.target)
      if (da === undefined || db === undefined) continue
      if (da >= db) {
        depth.set(e.target, da + 1)
        changed = true
      }
    }
    if (!changed) break
  }

  // Group nodes by depth
  const byDepth = new Map<number, number[]>()
  for (const [id, d] of depth) {
    if (!byDepth.has(d)) byDepth.set(d, [])
    byDepth.get(d)!.push(id)
  }

  // Assign positions
  const layout: LayoutNode[] = []
  const allDepths = Array.from(byDepth.keys()).sort((a, b) => a - b)
  let totalHeight = 0

  for (const d of allDepths) {
    const group = byDepth.get(d)!.sort((a, b) => a - b)
    const colHeight = group.length * ROW_GAP
    if (colHeight > totalHeight) totalHeight = colHeight
    const x = MARGIN + d * (NODE_W + COL_GAP)
    for (let i = 0; i < group.length; i++) {
      const id = group[i]
      const base = nodeMap.get(id)!
      layout.push({ ...base, x, y: MARGIN + i * ROW_GAP })
    }
  }

  const width  = MARGIN * 2 + (allDepths.length) * (NODE_W + COL_GAP)
  const height = MARGIN * 2 + totalHeight
  return { nodes: layout, width, height }
}

// ── SVG rendering ─────────────────────────────────────────────────────────────

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

function renderGraph(
  container: HTMLElement,
  nodes: LayoutNode[],
  edges: GraphEdge[],
  svgW: number,
  svgH: number,
  slug: string,
): void {
  container.innerHTML = ''

  const posMap = new Map<number, LayoutNode>(nodes.map(n => [n.id, n]))

  const svg = svgEl('svg', {
    width: svgW, height: svgH,
    viewBox: `0 0 ${svgW} ${svgH}`,
    style: 'user-select:none',
  })

  // Arrow marker — fill:context-stroke so the arrowhead inherits the edge stroke color.
  const defs = svgEl('defs', {})
  const marker = svgEl('marker', {
    id: 'arrow', markerWidth: 8, markerHeight: 8,
    refX: 7, refY: 3, orient: 'auto',
  })
  const arrowPath = svgEl('path', { d: 'M0,0 L0,6 L8,3 Z', fill: 'context-stroke' })
  marker.appendChild(arrowPath)
  defs.appendChild(marker)
  svg.appendChild(defs)

  // Edges — build per-node lookup for hover highlighting.
  const allEdgePaths: SVGPathElement[] = []
  const nodeEdgePaths = new Map<number, SVGPathElement[]>()

  const edgeGroup = svgEl('g', {})
  for (const e of edges) {
    const src = posMap.get(e.source)
    const tgt = posMap.get(e.target)
    if (!src || !tgt) continue
    // Skip back-edges that survive the forward-push cap (cycles)
    if (src.x >= tgt.x) continue
    const x1 = src.x + NODE_W
    const y1 = src.y + NODE_H / 2
    const x2 = tgt.x - 8   // leave room for arrowhead
    const y2 = tgt.y + NODE_H / 2
    const cp1x = x1 + (x2 - x1) * 0.5
    const path = svgEl('path', {
      d: `M${x1},${y1} C${cp1x},${y1} ${cp1x},${y2} ${x2},${y2}`,
      fill: 'none',
      stroke: 'var(--vscode-charts-lines, #555)',
      'stroke-width': 1,
      'marker-end': 'url(#arrow)',
      opacity: 0.6,
    })
    allEdgePaths.push(path)
    for (const id of [e.source, e.target]) {
      if (!nodeEdgePaths.has(id)) nodeEdgePaths.set(id, [])
      nodeEdgePaths.get(id)!.push(path)
    }
    edgeGroup.appendChild(path)
  }
  svg.appendChild(edgeGroup)

  // Nodes
  const nodeGroup = svgEl('g', {})
  for (const n of nodes) {
    const g = svgEl('g', {
      transform: `translate(${n.x},${n.y})`,
      style: 'cursor:pointer',
    })
    g.dataset['levelId'] = String(n.id)

    const fill = n.isOverworld
      ? 'var(--vscode-editorInfo-background, #1a3a5c)'
      : 'var(--vscode-editor-inactiveSelectionBackground, #3a3a3a)'

    const rect = svgEl('rect', {
      width: NODE_W, height: NODE_H, rx: 3, ry: 3,
      fill,
      stroke: 'var(--vscode-focusBorder, #007fd4)',
      'stroke-width': 1,
    })

    const nameStr = n.name
      ? (n.name.length > 24 ? n.name.slice(0, 24) + '…' : n.name)
      : null

    const baseText = {
      y: 16,
      'font-size': 11,
      'font-family': 'var(--vscode-font-family, sans-serif)',
    }

    g.appendChild(rect)
    if (nameStr) {
      const nameEl = svgEl('text', {
        ...baseText, x: 6,
        fill: 'var(--vscode-editor-foreground, #ccc)',
      })
      nameEl.textContent = nameStr
      g.appendChild(nameEl)

      const idEl = svgEl('text', {
        ...baseText, x: NODE_W - 6, 'text-anchor': 'end',
        fill: 'var(--vscode-descriptionForeground, #999)',
      })
      idEl.textContent = `$${n.hex}`
      g.appendChild(idEl)
    } else {
      const idEl = svgEl('text', {
        ...baseText, x: 6,
        fill: 'var(--vscode-editor-foreground, #ccc)',
      })
      idEl.textContent = `$${n.hex}`
      g.appendChild(idEl)
    }

    g.addEventListener('click', () => {
      vscode.postMessage({ type: 'openLevel', levelIndex: n.id, slug })
    })
    g.addEventListener('mouseenter', () => {
      rect.setAttribute('stroke-width', '2')
      rect.setAttribute('stroke', 'var(--vscode-textLink-foreground, #3794ff)')
      const connected = new Set(nodeEdgePaths.get(n.id) ?? [])
      for (const p of allEdgePaths) {
        if (connected.has(p)) {
          p.setAttribute('stroke', 'var(--vscode-textLink-foreground, #3794ff)')
          p.setAttribute('stroke-width', '2')
          p.setAttribute('opacity', '1')
        } else {
          p.setAttribute('opacity', '0.1')
        }
      }
    })
    g.addEventListener('mouseleave', () => {
      rect.setAttribute('stroke-width', '1')
      rect.setAttribute('stroke', 'var(--vscode-focusBorder, #007fd4)')
      for (const p of allEdgePaths) {
        p.setAttribute('stroke', 'var(--vscode-charts-lines, #555)')
        p.setAttribute('stroke-width', '1')
        p.setAttribute('opacity', '0.6')
      }
    })

    nodeGroup.appendChild(g)
  }
  svg.appendChild(nodeGroup)

  container.appendChild(svg)

  // Zoom / pan — fit to viewport on first render
  setupZoomPan(container, svg, svgW, svgH)
}

function setupZoomPan(container: HTMLElement, svg: SVGSVGElement, svgW: number, svgH: number): void {
  const cw = container.clientWidth  || window.innerWidth
  const ch = container.clientHeight || window.innerHeight
  let scale = Math.min(cw / svgW, ch / svgH) * 0.95
  let tx = (cw - svgW * scale) / 2
  let ty = (ch - svgH * scale) / 2
  let dragging = false
  let lastX = 0, lastY = 0

  const applyTransform = () => {
    svg.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`
    svg.style.transformOrigin = '0 0'
  }
  applyTransform()

  container.addEventListener('wheel', (e) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    scale = Math.max(0.1, Math.min(3, scale * factor))
    applyTransform()
  }, { passive: false })

  container.addEventListener('mousedown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    tx += e.clientX - lastX; ty += e.clientY - lastY
    lastX = e.clientX; lastY = e.clientY
    applyTransform()
  })
  window.addEventListener('mouseup', () => { dragging = false })
}

// ── Message handling ──────────────────────────────────────────────────────────

function showError(container: HTMLElement, msg: string): void {
  container.innerHTML = `<p style="color:var(--vscode-errorForeground,red);padding:16px">${msg}</p>`
}

function showLoading(container: HTMLElement): void {
  container.innerHTML = `<p style="padding:16px;color:var(--vscode-descriptionForeground,#888)">Loading level graph…</p>`
}

document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app')!
  showLoading(app)

  window.addEventListener('message', (event) => {
    const msg = event.data as { type: string; nodes?: GraphNode[]; edges?: GraphEdge[]; slug?: string; message?: string }

    if (msg.type === 'error') {
      showError(app, msg.message ?? 'Unknown error')
      return
    }

    if (msg.type === 'load') {
      const { nodes, edges, slug } = msg as { nodes: GraphNode[]; edges: GraphEdge[]; slug: string }
      if (!nodes?.length) {
        showError(app, 'No level connections found in this ROM.')
        return
      }
      const layout = buildLayout(nodes, edges)
      renderGraph(app, layout.nodes, edges, layout.width, layout.height, slug)
    }
  })

  // Signal ready to extension host
  vscode.postMessage({ type: 'ready' })
})
