/** The map tab's missing-ROM wording (#786): pure, so it runs without a Theia shell. */
export const romMissingMessage = (title: string): string =>
  `The base ROM ${title} is not on this machine. Choose File > Project Properties... and locate it again.`

/** The raw text of a thrown value, for a tooltip beside plain words (#786). */
export const rawText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A rejected overlay call (#967): plain words for the toggle or note, the exception text apart. */
export const readFailed = (what: string) => (err: unknown) => {
  console.error(`${what} failed:`, err)
  return {
    status: 'unavailable' as const,
    reason: 'this map could not be read just now. Open the map again to try again.',
    detail: rawText(err),
  }
}

/** Plain words, then the technical text on a second tooltip line when there is some. */
export const withDetail = (text: string, detail?: string): string =>
  detail ? `${text}\n${detail}` : text

/** Every distinct `unverified` cause of the sprites, one per line (not split on `; `: a cause holds one itself); undefined when none (#1166). */
export const unverifiedCauses = (sprites: readonly { unverified?: string }[]): string | undefined =>
  [...new Set(sprites.flatMap(x => (x.unverified ? [x.unverified] : [])))].join('\n') || undefined

/** The missing-ROM sentence after a "Sprites unavailable: " style lead reads on in lower case. */
export const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

/** The sprite toggle's name when some sprites are unverified. It names no cause, because they differ (a level the loader refused, a memory setting, an earlier sprite); the causes follow on the title's other lines. */
export const unverifiedLabel = (): string =>
  'Sprites · unverified: some sprites may not be drawn exactly as in the game.'
