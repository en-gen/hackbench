/**
 * Which handlers the map expander draws from the interpreter (#342). Kept apart
 * from interpretedDraw.ts, which pulls in the interpreter and so Node's
 * `crypto`: the expander is bundled for the browser and must not reach it.
 */

/** Standard-object handlers drawn by the interpreter. CODE_0DADEB is the cloud slope (bank_0D.asm:2671). */
const INTERPRETED_HANDLERS: ReadonlySet<number> = new Set([0x0dadeb])

/** The same ROM address in $00-$7F and its $80-$FF mirror compares equal. */
export const mirror = (a: number): number => a & 0x7fffff

export const isInterpretedHandler = (a: number): boolean => INTERPRETED_HANDLERS.has(mirror(a))

const hex6 = (n: number): string => '$' + n.toString(16).toUpperCase().padStart(6, '0')

/** Record, once, that a port drew `handler` with the interpreter unable to vouch for it. */
export function noteUnverified(unverified: string[], handler: number, why: string): void {
  const line = `Handler ${hex6(handler)} is drawn by the built-in model, not verified against this ROM: ${why}.`
  if (!unverified.includes(line)) unverified.push(line)
}
