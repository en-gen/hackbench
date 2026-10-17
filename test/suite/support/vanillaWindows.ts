/**
 * Finds vanilla-ROM code or data bytes inside a synthetic cart (the copyright rule in docs/testing.md:
 * a committed fixture must not carry the game's own bytes). A window is 8 consecutive bytes with at
 * least 3 distinct values (so fill, zero runs and two-value tables are not flagged) that also occurs,
 * at any position, in the vanilla ROM. Evidence scope: a byte-for-byte window match, the cart and
 * the vanilla image both read as a flat LoROM file (no copier header).
 */
import { readFileSync } from 'node:fs'

export const WINDOW = 8
export const MIN_DISTINCT = 3

/** The file bytes without a 512-byte copier header, if it has one. */
export function stripHeader(file: Uint8Array): Uint8Array {
  return file.length % 1024 === 512 ? file.subarray(512) : file
}

export const loadVanillaBytes = (path: string): Uint8Array =>
  stripHeader(new Uint8Array(readFileSync(path)))

const key = (b: Uint8Array, i: number): string => Buffer.from(b.buffer, b.byteOffset + i, WINDOW).toString('latin1') // prettier-ignore

/** Every window of `bytes`, as a set the cart is searched against. */
export function windowSet(bytes: Uint8Array): Set<string> {
  const s = new Set<string>()
  for (let i = 0; i + WINDOW <= bytes.length; i++) s.add(key(bytes, i))
  return s
}

const distinct = (b: Uint8Array, i: number): number => new Set(b.subarray(i, i + WINDOW)).size

/** The SNES address (LoROM, bank 0 first) of a file offset. */
export const snesOf = (off: number): string =>
  `$${(off >> 15).toString(16).toUpperCase().padStart(2, '0')}:${(0x8000 | (off & 0x7fff)).toString(16).toUpperCase().padStart(4, '0')}` // prettier-ignore

/** The SNES address of every window of `cart` that is also a vanilla window; adjacent hits are not merged. */
export function vanillaHits(cart: Uint8Array, vanilla: ReadonlySet<string>): string[] {
  const hits: string[] = []
  for (let i = 0; i + WINDOW <= cart.length; i++)
    if (distinct(cart, i) >= MIN_DISTINCT && vanilla.has(key(cart, i))) hits.push(snesOf(i))
  return hits
}

/** Hits as `first-last xN` runs, for a failure message a person can read. */
export function summarize(hits: readonly string[]): string[] {
  const out: string[] = []
  for (const h of hits) {
    const last = out[out.length - 1]
    const [bank, addr] = h.slice(1).split(':') as [string, string]
    if (last) {
      const m = /^\$(\w\w):(\w{4})(?:\.\.(\w{4}))? x(\d+)$/.exec(last)!
      const end = parseInt(m[3] ?? m[2]!, 16)
      if (m[1] === bank && end + 1 === parseInt(addr, 16)) {
        out[out.length - 1] = `$${bank}:${m[2]}..${addr} x${+m[4]! + 1}`
        continue
      }
    }
    out.push(`$${bank}:${addr} x1`)
  }
  return out
}
