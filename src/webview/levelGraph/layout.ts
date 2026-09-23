/**
 * Pure graph-layout logic for the level-graph webview, split out from main.ts
 * so it can be unit-tested without a VS Code webview host (main.ts calls
 * acquireVsCodeApi() at module load, which only exists inside a webview).
 */

export interface GraphNode {
  id: number
  hex: string
  name: string | null
  isOverworld: boolean
}

export interface GraphEdge {
  source: number
  target: number
}

export interface LayoutNode extends GraphNode {
  x: number
  y: number
}

export const NODE_W = 210
export const NODE_H = 24
export const COL_GAP = 160
export const ROW_GAP = 30
export const MARGIN = 20

/**
 * Identify back edges via DFS from every node (grey/black coloring): an edge
 * to a node still on the current DFS stack closes a cycle. Vanilla SMW has
 * several, such as the $1DB -> $1DD -> $1DB pipe loop, and so do the other
 * corpus ROMs. Removing these edges before the forward-push relaxation pass
 * leaves a DAG, so relaxation is guaranteed to converge instead of pushing
 * depth toward the pass cap.
 */
function findBackEdges(nodeIds: number[], adj: Map<number, number[]>): Set<string> {
  const GREY = 1,
    BLACK = 2
  const color = new Map<number, number>()
  const backEdges = new Set<string>()

  for (const start of nodeIds) {
    if (color.get(start) !== undefined) continue
    // Iterative DFS: stack of [nodeId, nextChildIndex]
    const stack: Array<[number, number]> = [[start, 0]]
    color.set(start, GREY)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const [id, idx] = frame
      const children = adj.get(id) ?? []
      if (idx < children.length) {
        frame[1] = idx + 1
        const child = children[idx]!
        const childColor = color.get(child)
        if (childColor === undefined) {
          color.set(child, GREY)
          stack.push([child, 0])
        } else if (childColor === GREY) {
          backEdges.add(`${id}->${child}`)
        }
        // BLACK child: forward/cross edge, not a back edge.
      } else {
        color.set(id, BLACK)
        stack.pop()
      }
    }
  }
  return backEdges
}

export function buildLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: LayoutNode[]; width: number; height: number; backEdges: Set<string> } {
  const nodeMap = new Map<number, GraphNode>(nodes.map(n => [n.id, n]))

  // Adjacency list and the referenced-node set, built in one pass.
  const adj = new Map<number, number[]>()
  const referenced = new Set<number>()
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source)!.push(e.target)
    referenced.add(e.source)
    referenced.add(e.target)
  }

  // Back-edge membership is fixed once findBackEdges returns, so classify
  // every edge once here instead of re-testing it on each relaxation pass.
  const backEdges = findBackEdges(Array.from(referenced), adj)
  const forwardEdges = edges.filter(e => !backEdges.has(`${e.source}->${e.target}`))

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
    for (const nb of adj.get(id) ?? []) {
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

  // Forward-push pass: for every non-back edge A→B where depth[A] >= depth[B],
  // push B to depth[A]+1. Back edges are excluded, so the remaining edges
  // form a DAG and this is guaranteed to converge (capped at node-count
  // iterations as a defensive backstop, not a load-bearing bound).
  for (let pass = 0; pass < depth.size; pass++) {
    let changed = false
    for (const e of forwardEdges) {
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

  // Width must be sized from the maximum depth actually assigned, not the
  // count of distinct depth values -- gaps between them (e.g. from a node
  // pushed far ahead by a long forward chain) would otherwise leave a
  // narrower canvas than the x-coordinates it renders.
  const maxDepth = allDepths.length > 0 ? allDepths[allDepths.length - 1]! : 0
  const width = MARGIN * 2 + (maxDepth + 1) * (NODE_W + COL_GAP)
  const height = MARGIN * 2 + totalHeight
  // backEdges is returned so the renderer can drop exactly the cycle-closing
  // edges this pass identified, rather than re-deriving them from geometry
  // (`src.x >= tgt.x`), which is equivalent only as long as relaxation keeps
  // converging to a strict ordering on the non-back edges.
  return { nodes: layout, width, height, backEdges }
}
