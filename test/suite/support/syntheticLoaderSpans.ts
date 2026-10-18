/**
 * The level loader's span fingerprints for the synthetic cart: SHA-256 of the hand-written stand-ins
 * buildSyntheticRom() plants (syntheticSpriteRom.ts, syntheticGm11Spans.ts), taken from an unmutated
 * build, so a cart with a planted defect differs from them and is refused. The real list is
 * LOADER_SPANS (vanilla fingerprints); a test that runs the loader on a synthetic cart passes this one.
 */
import type { LoaderSpan } from '../../../src/rom/sprites/interp/LevelLoader'
import { LOADER_SPANS } from '../../../src/rom/sprites/interp/LevelLoader'
import { spanFingerprint } from '../../../src/rom/SubmapFlagGate'
import { buildBareSyntheticRom } from './syntheticSpriteRom'

/** Hashed length of each stand-in, by address: the whole hand-written head the loader checks. */
const STAND_IN_LENGTH: Record<number, number> = {
  0x0096f4: 38, // GM11 from the header call through the data call: the whole synthetic sequence
  0x00a796: 8,
  0x00f6db: 9,
  0x05d796: 11,
  0x05d8b7: 7,
  0x00a635: 8,
  0x05801e: 12,
}

/** Operand offsets zeroed in a stand-in's hash (as LOADER_SPANS masks relocatable operands): A796's LDA # count. */
const STAND_IN_MASK: Record<number, readonly number[]> = {
  0x0096f4: [3, 15, 16, 37], // the two JSL bank bytes and the music call's operand, as in LOADER_SPANS
  0x00a796: [3, 4],
}

let cached: readonly LoaderSpan[] | undefined

export const syntheticLoaderSpans = (): readonly LoaderSpan[] =>
  (cached ??= LOADER_SPANS.map(s => {
    const length = STAND_IN_LENGTH[s.at]
    if (!length) throw new Error(`no synthetic stand-in length for ${s.name}`)
    const mask = STAND_IN_MASK[s.at] ?? []
    const bytes = buildBareSyntheticRom().readAt(s.at, length)
    return { name: s.name, at: s.at, length, mask, sha: spanFingerprint(bytes, mask)! }
  }))
