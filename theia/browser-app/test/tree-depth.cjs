/**
 * Deepest nesting below a list of roots: 0 when every root is a leaf.
 *
 * Kept out of the page and passed an explicit depth, because the inline
 * version was handed to Array.prototype.map, which supplies the element index
 * as the second argument: a flat list of N roots scored N-1.
 */
function maxDepth(nodes, depth = 0) {
  let deepest = 0
  for (const n of nodes) {
    const kids = n.children || []
    deepest = Math.max(deepest, kids.length ? maxDepth(kids, depth + 1) : depth)
  }
  return deepest
}

module.exports = { maxDepth }
