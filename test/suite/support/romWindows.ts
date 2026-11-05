/**
 * Copyright check for hand-written synthetic code (#841): does any run of `width` consecutive bytes from the
 * planted chunks also appear in a real cart? A hit means a fixture routine was copied from the game rather than
 * written for the test. `width` 8 is this check's own choice: docs/testing.md and check-content.mjs define no
 * window (the gate counts byte tokens and disassembly lines, not runs).
 */
export function romWindowHits(
  chunks: readonly (readonly number[])[],
  rom: Uint8Array,
  width: number,
): { chunk: number; at: number }[] {
  const hits: { chunk: number; at: number }[] = []
  const seen = new Set<string>()
  const key = (a: ArrayLike<number>, from: number) =>
    String.fromCharCode(...Array.from({ length: width }, (_, i) => a[from + i]!))
  for (let i = 0; i + width <= rom.length; i++) seen.add(key(rom, i))
  chunks.forEach((c, chunk) => {
    for (let at = 0; at + width <= c.length; at++)
      if (seen.has(key(c, at))) hits.push({ chunk, at })
  })
  return hits
}
