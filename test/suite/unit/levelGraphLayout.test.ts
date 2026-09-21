/**
 * buildLayout -- cycle handling.
 *
 * The exit graph can contain cycles (vanilla has a pipe loop: $1DB -> $1DD
 * -> $1DB). Before this fix, the forward-push relaxation pass had no way to
 * detect a cycle, so it kept pushing the looped nodes' depth upward on every
 * pass, capped only at `depth.size` iterations -- hundreds of columns deep on
 * a graph with hundreds of nodes. The canvas width was then computed from
 * the count of *distinct* depth values rather than the max depth reached, so
 * a node pushed to depth 300+ rendered tens of thousands of pixels past the
 * right edge of a canvas only a few thousand pixels wide.
 */
import { describe, it, expect } from 'vitest'
import {
  buildLayout,
  NODE_W,
  COL_GAP,
  MARGIN,
  type GraphNode,
  type GraphEdge,
} from '../../../src/webview/levelGraph/layout'

describe('buildLayout', () => {
  it('bounds depth on a cyclic graph instead of growing without limit', () => {
    // root -> A -> B -> A (cycle), plus root -> C (acyclic tail)
    const nodes: GraphNode[] = [
      { id: 0, hex: '000', name: 'root', isOverworld: true },
      { id: 1, hex: '001', name: 'A', isOverworld: false },
      { id: 2, hex: '002', name: 'B', isOverworld: false },
      { id: 3, hex: '003', name: 'C', isOverworld: false },
    ]
    const edges: GraphEdge[] = [
      { source: 0, target: 1 },
      { source: 1, target: 2 },
      { source: 2, target: 1 }, // closes the cycle
      { source: 0, target: 3 },
    ]

    const layout = buildLayout(nodes, edges)
    const maxDepthColumn = Math.max(...layout.nodes.map(n => (n.x - MARGIN) / (NODE_W + COL_GAP)))

    // Bounded by node count, nowhere near the hundreds/thousands a runaway
    // relaxation pass would produce.
    expect(maxDepthColumn).toBeLessThan(nodes.length)

    // Every node's x position must fit inside the returned canvas width.
    for (const n of layout.nodes) {
      expect(n.x + NODE_W).toBeLessThanOrEqual(layout.width)
    }
  })

  it('reproduces the vanilla $1DB <-> $1DD pipe loop without blowing up the canvas', () => {
    const nodes: GraphNode[] = [
      { id: 0x113, hex: '113', name: 'overworld root', isOverworld: true },
      { id: 0x1db, hex: '1DB', name: null, isOverworld: false },
      { id: 0x1dd, hex: '1DD', name: null, isOverworld: false },
    ]
    const edges: GraphEdge[] = [
      { source: 0x113, target: 0x1db },
      { source: 0x1db, target: 0x1dd },
      { source: 0x1dd, target: 0x1db },
    ]

    const layout = buildLayout(nodes, edges)
    for (const n of layout.nodes) {
      expect(n.x + NODE_W).toBeLessThanOrEqual(layout.width)
      expect(n.x).toBeLessThan(10_000) // sanity ceiling, not the old ~240,000px
    }
  })

  it('sizes the canvas from the maximum depth reached, not the count of distinct depths', () => {
    // root -> A (BFS depth 1). Y <-> Z is a separate cycle unreachable from
    // root, so both start at the "unreachable" fallback depth (max+1 = 2);
    // the back-edge-free direction of their cycle then pushes Z to depth 3,
    // and Z -> A pushes A from 1 to depth 4. Depth 1 ends up with no node in
    // it -- a real gap -- so distinct-depth count (4: {0,2,3,4}) is one less
    // than max depth + 1 (5), the exact mismatch that let nodes render past
    // a canvas sized from the distinct count.
    const nodes: GraphNode[] = [
      { id: 0, hex: '000', name: null, isOverworld: true }, // root
      { id: 1, hex: '001', name: null, isOverworld: false }, // A
      { id: 2, hex: '002', name: null, isOverworld: false }, // Y
      { id: 3, hex: '003', name: null, isOverworld: false }, // Z
    ]
    const edges: GraphEdge[] = [
      { source: 0, target: 1 }, // root -> A
      { source: 2, target: 3 }, // Y -> Z
      { source: 3, target: 2 }, // Z -> Y (one of these two is the back edge)
      { source: 3, target: 1 }, // Z -> A
    ]

    const layout = buildLayout(nodes, edges)
    const byId = new Map(layout.nodes.map(n => [n.id, n]))
    const depthOf = (x: number) => (x - MARGIN) / (NODE_W + COL_GAP)
    const maxDepth = Math.max(...layout.nodes.map(n => depthOf(n.x)))
    const distinctDepths = new Set(layout.nodes.map(n => depthOf(n.x))).size

    expect(distinctDepths).toBeLessThan(maxDepth + 1) // confirms the gap exists
    expect(layout.width).toBe(MARGIN * 2 + (maxDepth + 1) * (NODE_W + COL_GAP))
    // The node at the deepest column must still fit inside that width.
    expect(byId.get(1)!.x + NODE_W).toBeLessThanOrEqual(layout.width)
  })

  it('lays every non-back edge out left to right', () => {
    // The bounded-canvas assertions above catch a runaway relaxation pass but
    // would still pass on a boundedly-sized yet topologically wrong layout.
    // This pins the property the relaxation exists to establish: once back
    // edges are removed the rest is a DAG, so each remaining edge must land
    // its target in a strictly later column than its source.
    const nodes: GraphNode[] = [
      { id: 0, hex: '000', name: null, isOverworld: true },
      { id: 1, hex: '001', name: null, isOverworld: false },
      { id: 2, hex: '002', name: null, isOverworld: false },
      { id: 3, hex: '003', name: null, isOverworld: false },
      { id: 4, hex: '004', name: null, isOverworld: false },
    ]
    const edges: GraphEdge[] = [
      { source: 0, target: 1 },
      { source: 1, target: 2 },
      { source: 2, target: 3 },
      { source: 3, target: 1 }, // back edge
      { source: 0, target: 4 },
      { source: 4, target: 3 }, // forward edge into the middle of the chain
    ]

    const layout = buildLayout(nodes, edges)
    const col = new Map(layout.nodes.map(n => [n.id, (n.x - MARGIN) / (NODE_W + COL_GAP)]))

    let checked = 0
    for (const e of edges) {
      if (layout.backEdges.has(`${e.source}->${e.target}`)) continue
      expect(col.get(e.target)!).toBeGreaterThan(col.get(e.source)!)
      checked++
    }
    // Guards against the assertion loop vacuously skipping everything if
    // back-edge detection ever over-fires.
    expect(checked).toBe(edges.length - 1)
  })

  it('reports a back-edge set matching the renderer old geometric test', () => {
    // The renderer drops cycle edges. It used to infer them from geometry
    // (src.x >= tgt.x); it now asks the layout. Those two rules must select
    // the same edges, so this pins the equivalence on a graph built to stress
    // it: a cycle whose target is also the destination of a deep forward
    // chain, which is the shape most likely to separate the two if the depth
    // pass ever stops converging to a strict ordering.
    const nodes: GraphNode[] = [
      { id: 0, hex: '000', name: null, isOverworld: true },
      { id: 1, hex: '001', name: null, isOverworld: false }, // B
      { id: 2, hex: '002', name: null, isOverworld: false }, // A
      { id: 3, hex: '003', name: null, isOverworld: false }, // deep chain
      { id: 4, hex: '004', name: null, isOverworld: false },
    ]
    const edges: GraphEdge[] = [
      { source: 0, target: 1 }, // root -> B
      { source: 1, target: 2 }, // B -> A
      { source: 2, target: 1 }, // A -> B, the back edge
      { source: 0, target: 3 },
      { source: 3, target: 4 },
      { source: 4, target: 1 }, // deep forward edge into B
    ]

    const layout = buildLayout(nodes, edges)
    const byId = new Map(layout.nodes.map(n => [n.id, n]))

    expect(layout.backEdges.has('2->1')).toBe(true)
    for (const e of edges) {
      const geometric = byId.get(e.source)!.x >= byId.get(e.target)!.x
      expect(layout.backEdges.has(`${e.source}->${e.target}`)).toBe(geometric)
    }
  })
})
