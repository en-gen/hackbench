/** One row in a Level folder's sub-area tree; 'loop' and 'truncated' never expand. */
export interface LevelTreeNode {
  index: number
  children: LevelTreeNode[]
  kind: 'room' | 'loop' | 'truncated'
}

/**
 * Per-root caps. k chained branch-and-rejoin rooms give 2^k root-to-leaf paths, so
 * the cost is exponential in graph shape, not in the 512-slot table: a synthetic
 * 20-diamond chain reaches 4.19M nodes. Across this repo's six-ROM corpus no single
 * root exceeded 118 nodes (vanilla $022) or depth 6, but that is six ROMs measured,
 * not a property of exit graphs -- the caps, ~8x and 4x above it, are the bound.
 */
export const MAX_SUBTREE_NODES = 1000
export const MAX_SUBTREE_DEPTH = 24

/**
 * Used by the reference VS Code extension only; the Maps tree lists a root's
 * sub areas flat with `reachableSlots` below (#434), because this expansion
 * made vanilla $022 read 118 rows from 6 slots.
 *
 * Expand every root-to-leaf path in the exit graph into a nested tree. A sub-area
 * with two parents (vanilla $007 -> $0E6 -> $0E7 alongside $007 -> $0E8 -> $0E7)
 * expands in full under each: this renders how a player navigates, not the graph's
 * node set. Only a back edge, a child already on the path from the root, stops
 * expansion; testing the path rather than a global visited set is what separates the
 * two, and conflating them turns every diamond into a false cycle. Past a cap
 * nothing vanishes silently either: each child left unexpanded is emitted as a
 * 'truncated' marker at every level of the unwind.
 */
export function buildLevelSubtree(
  root: number,
  exitGraph: Map<number, number[]>,
  isOverworld: (index: number) => boolean,
): LevelTreeNode {
  const path = new Set<number>([root])
  let nodes = 1

  const expand = (index: number, depth: number): LevelTreeNode => {
    const children: LevelTreeNode[] = []
    for (const child of exitGraph.get(index) ?? []) {
      // An overworld child roots its own Level folder; it is not a sub-area here.
      if (isOverworld(child)) continue
      nodes++
      if (path.has(child)) {
        children.push({ index: child, children: [], kind: 'loop' })
      } else if (nodes >= MAX_SUBTREE_NODES || depth + 1 >= MAX_SUBTREE_DEPTH) {
        children.push({ index: child, children: [], kind: 'truncated' })
      } else {
        path.add(child)
        children.push(expand(child, depth + 1))
        path.delete(child)
      }
    }
    return { index, children, kind: 'room' }
  }

  return expand(root, 0)
}

/**
 * Every slot reachable from `root` through `exitGraph`, ascending, each once.
 * A child for which `isBoundary` holds (another overworld root, which heads
 * its own folder, or a slot that is no map) is neither listed nor entered, and
 * nor is anything reached only through it. The root itself is excluded.
 */
export function reachableSlots(
  root: number,
  exitGraph: Map<number, number[]>,
  isBoundary: (index: number) => boolean,
): number[] {
  const seen = new Set<number>([root])
  const stack = [root]
  while (stack.length > 0) {
    for (const child of exitGraph.get(stack.pop()!) ?? []) {
      if (seen.has(child) || isBoundary(child)) continue
      seen.add(child)
      stack.push(child)
    }
  }
  seen.delete(root)
  return [...seen].sort((a, b) => a - b)
}
