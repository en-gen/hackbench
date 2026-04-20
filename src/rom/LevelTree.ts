import { isOverworldLevel } from './SmwRom'

/**
 * For each overworld level, BFS the exit graph to collect all transitively
 * reachable sub-area indices.  Returns a Map<overworldIndex, subIndices[]>.
 *
 * The BFS descends into any non-overworld child. `classifyLevels` dedupes
 * subareas by L1 pointer for display, which drops real reachable rooms
 * (e.g. $0D9, $0E5, $0EC in vanilla); gating on subarea-membership here
 * would truncate those chains. `visited` (seeded with the root) terminates
 * cycles like A -> B -> C -> A, which exist in vanilla pipe loops.
 */
export function buildTransitiveLevelMap(
  overworldIndices: number[],
  exitGraph: Map<number, number[]>,
): Map<number, number[]> {
  const result = new Map<number, number[]>()
  for (const root of overworldIndices) {
    const visited = new Set<number>([root])
    const queue = [root]
    const subs: number[] = []
    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const child of exitGraph.get(cur) ?? []) {
        if (visited.has(child)) continue
        if (isOverworldLevel(child)) continue
        visited.add(child)
        subs.push(child)
        queue.push(child)
      }
    }
    result.set(root, subs)
  }
  return result
}
