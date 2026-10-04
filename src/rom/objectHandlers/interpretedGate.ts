import { mirror } from '../addressing'

/**
 * Which handlers the map expander draws from the interpreter (#342). Kept apart
 * from interpretedDraw.ts, which pulls in the interpreter and so Node's
 * `crypto`: the expander is bundled for the browser and must not reach it.
 */

/** Standard-object handlers drawn by the interpreter. CODE_0DADEB is the cloud slope (bank_0D.asm:2671). */
const INTERPRETED_HANDLERS: ReadonlySet<number> = new Set([0x0dadeb])

export const isInterpretedHandler = (a: number): boolean => INTERPRETED_HANDLERS.has(mirror(a))

const hex6 = (n: number): string => '$' + n.toString(16).toUpperCase().padStart(6, '0')

/** Record, once, that a port drew `handler` with the interpreter unable to vouch for it. */
export function noteUnverified(unverified: string[], handler: number, why: string): void {
  const line = `Handler ${hex6(handler)} is drawn by the built-in model, not verified against this ROM: ${why}.`
  if (!unverified.includes(line)) unverified.push(line)
}

/**
 * Record, once, that a port refused to draw `handler` because the instruction
 * it reads through is not the expected one (#452). Unlike noteUnverified the
 * object is NOT drawn, so the viewer must not call it built-in-model drawn.
 */
export function noteRefused(
  unverified: string[] | undefined,
  handler: number,
  opcodeAt: number,
  expected: number,
  found: number | undefined,
): void {
  const h2 = (n: number): string => '$' + n.toString(16).toUpperCase().padStart(2, '0')
  const was = found === undefined ? 'nothing' : h2(found)
  const line = `Handler ${hex6(handler)} refused: the byte at ${hex6(opcodeAt)} is ${was}, not the ${h2(expected)} opcode it reads through, so the object is not drawn.`
  if (unverified && !unverified.includes(line)) unverified.push(line)
}
