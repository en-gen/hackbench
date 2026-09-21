// Shared oracle for the encodeOverride(levelId) contract. Used by both
// encodeOverride.test.ts (must report zero violations) and
// encodeOverride.mutants.test.ts (must report at least one violation per
// planted defect), so the two files cannot silently drift onto different
// definitions of "correct".
//
// Spec: tools/mesen/headless_capture.lua, the "TRACED MECHANISM" comment
// block and the encodeOverride() reference implementation beneath it.
// ROM decode cited there to SMWDisX bank_05.asm:7216-7227.

export type EncodeResult = { overrideByte: number; submapFlag: 0 | 1 } | null
export type EncodeFn = (levelId: number) => EncodeResult

// Independent decode, transcribed from bank_05.asm:7216-7227 directly, never
// from encodeOverride. Checking against the ROM's own inverse is the
// strongest oracle here: it verifies actual game behavior, not a second copy
// of the forward formula.
export function decodeOverride(overrideByte: number, submapFlag: number): number {
  const E = overrideByte >= 0x25 ? overrideByte - 0x24 : overrideByte
  return E | (submapFlag << 8)
}

// Built from the two range endpoints the spec states (levelId 0x001-0x0DB,
// 0x101-0x1DB), not a hand-typed list, so a slip here can't coincidentally
// agree with a slip in the implementation under test.
export function buildReachableSet(): Set<number> {
  const set = new Set<number>()
  for (let low = 1; low <= 0xDB; low++) {
    set.add(low)
    set.add(0x100 + low)
  }
  return set
}

// The forward formula restated once, canonically, for exact-value boundary
// checks (item 4 of the brief needs literal expected numbers, which
// necessarily means restating the spec -- round-trip below is the check that
// avoids doing that). Kept separate from decodeOverride on purpose.
export function expectedEncode(levelId: number): EncodeResult {
  if (levelId < 0 || levelId > 0x1FF) return null
  const submapFlag = (levelId >= 0x100 ? 1 : 0) as 0 | 1
  const lowByte = levelId % 0x100
  if (lowByte === 0) return null
  if (lowByte > 0xDB) return null
  const overrideByte = lowByte < 0x25 ? lowByte : lowByte + 0x24
  return { overrideByte, submapFlag }
}

// Every check the contract makes for one levelId, as violation strings
// (empty = compliant). levelId may be passed outside 0-0x1FF on purpose, to
// exercise the range-edge guard the same way as an in-range slot.
export function checkLevel(encode: EncodeFn, levelId: number, reachable: Set<number>): string[] {
  const tag = `0x${(levelId & 0xffff).toString(16).padStart(3, '0')}`
  const violations: string[] = []
  const result = encode(levelId)
  const shouldAccept = reachable.has(levelId)

  if (shouldAccept && result === null) {
    violations.push(`${tag}: expected acceptance, got rejection`)
    return violations
  }
  if (!shouldAccept && result !== null) {
    violations.push(`${tag}: expected rejection, got ${JSON.stringify(result)}`)
    return violations
  }
  if (result === null) return violations

  if (!Number.isInteger(result.overrideByte) || result.overrideByte < 0 || result.overrideByte > 255) {
    violations.push(`${tag}: overrideByte ${result.overrideByte} does not fit in a byte`)
  }
  const expectedSubmap = levelId >= 0x100 ? 1 : 0
  if (result.submapFlag !== expectedSubmap) {
    violations.push(`${tag}: submapFlag ${result.submapFlag}, expected ${expectedSubmap}`)
  }
  const exact = expectedEncode(levelId)
  if (exact && result.overrideByte !== exact.overrideByte) {
    violations.push(`${tag}: overrideByte ${result.overrideByte}, expected ${exact.overrideByte}`)
  }
  const decoded = decodeOverride(result.overrideByte, result.submapFlag)
  if (decoded !== levelId) {
    violations.push(`${tag}: round-trip failed, decoded 0x${decoded.toString(16)}`)
  }
  return violations
}

// Sweeps a set of levelIds and aggregates violations, so both test files run
// the same check over whatever domain they need (the documented 512 slots,
// plus out-of-range edge points for mutants that drop the range guard).
export function findViolations(encode: EncodeFn, levelIds: number[]): string[] {
  const reachable = buildReachableSet()
  return levelIds.flatMap((levelId) => checkLevel(encode, levelId, reachable))
}

export function fullRange(): number[] {
  const ids: number[] = []
  for (let levelId = 0x000; levelId <= 0x1ff; levelId++) ids.push(levelId)
  return ids
}
