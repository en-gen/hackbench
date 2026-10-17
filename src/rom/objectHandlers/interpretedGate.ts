import { formatAddr, mirror } from '../addressing'
import { hex2s } from '../hex'

/**
 * Which handlers the map expander draws from the interpreter (#342). Kept apart
 * from interpretedDraw.ts, which pulls in the interpreter and so Node's
 * `crypto`: the expander is bundled for the browser and must not reach it.
 */

/** Standard-object handlers drawn by the interpreter. CODE_0DADEB is the cloud slope (bank_0D.asm:2671). */
const INTERPRETED_HANDLERS: ReadonlySet<number> = new Set([0x0dadeb])

export const isInterpretedHandler = (a: number): boolean => INTERPRETED_HANDLERS.has(mirror(a))

/** Record, once, that a port drew `handler` with the interpreter unable to vouch for it. */
export function noteUnverified(unverified: string[], handler: number, why: string): void {
  const line = `Handler ${formatAddr(handler)} is drawn by the built-in model, not verified against this ROM: ${why}.`
  if (!unverified.includes(line)) unverified.push(line)
}

/** The note for a handler that refused on an opcode gate; `parseRefusedLine` reads it back (#301). */
export function formatRefusedLine(
  handler: number,
  opcodeAt: number,
  expected: number,
  found: number | null,
): string {
  const was = found === null ? 'nothing' : hex2s(found)
  return `Handler ${formatAddr(handler)} refused: the byte at ${formatAddr(opcodeAt)} is ${was}, not the ${hex2s(expected)} opcode it reads through, so the object is not drawn.`
}

/**
 * The handler of a line `formatRefusedLine` wrote, or null for any other note
 * (a drawn-but-unverified one, a dispatch-path one). Kept beside the format so
 * the two change together; the expander uses it to attribute the line to an
 * object without a change at every noteRefused call site.
 */
export function parseRefusedLine(line: string): { handler: number; reason: string } | null {
  const m = /^Handler \$([0-9A-F]{6}) refused:/.exec(line)
  return m ? { handler: parseInt(m[1], 16), reason: line } : null
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
  found: number | null,
  reason?: string,
): void {
  const line = reason
    ? `Handler ${formatAddr(handler)} refused: ${reason}, so the object is not drawn.`
    : formatRefusedLine(handler, opcodeAt, expected, found)
  if (unverified && !unverified.includes(line)) unverified.push(line)
}
