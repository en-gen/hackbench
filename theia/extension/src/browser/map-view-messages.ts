import type { MapDetailsDto } from '../common/project-protocol'

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

/** The missing-ROM sentence after a "Sprites unavailable: " style lead reads on in lower case. */
export const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

/** The sprite toggle's accessible name when some sprites are unverified: no code names; the raw text is the title's second line. */
export const unverifiedLabel = (): string =>
  'Sprites · unverified: this ROM changes code the sprites depend on.'

/** One warning line in the map view's notes row. */
export interface FactNote {
  /** The line's `data-note` hook. */
  note: string
  text: string
  /** The tooltip: the technical text, on a second line after any plain words. */
  title?: string
  /** Drawn red: something the user must fix or distrust, not just a caveat. */
  error?: boolean
}

export interface FactNoteInput {
  /** The `mapDetails` answer, once it has arrived. */
  details?: MapDetailsDto
  /** `mapDetails` rejected: plain words, then the exception text (#786). */
  failed?: string
  failedDetail?: string
  /** `mapDetails` or `mapStart` said the base ROM is not on this machine. */
  romMissing?: string
  startWhy?: string
  startDetail?: string
  /** `mapStart` threw, so the start is unknown only for now: a map note, not a ROM one. */
  startRejected?: boolean
}

/**
 * Every warning the removed facts strip and Header panel carried (#1008, D80 call 2), as notes.
 * Order follows docs/design/map-facts-properties.md, "The design", item 2: notes first, "This
 * map" then "This ROM", so the later move into the Properties panel is a straight lift. The
 * start sits between the groups: the design files it under the ROM, or the map when it failed
 * just now, and either way it follows the map's notes and leads the ROM's.
 * Nothing here is hex the user must read: the reasons from the loaders stay in the tooltip.
 */
export function factNotes(i: FactNoteInput): FactNote[] {
  const out: FactNote[] = []
  if (i.failed)
    out.push({ note: 'map-details', text: i.failed, title: i.failedDetail, error: true })
  const d = i.details
  if (d) {
    if (d.nameUnavailable) {
      out.push({ note: 'name', text: 'Name unavailable', title: d.nameUnavailable })
    }
    if (d.levelDataUnavailable) {
      out.push({
        note: 'level-data',
        text: 'Level data unavailable',
        title: d.levelDataUnavailable,
      })
    } else {
      // The rest is read from the level data, so it is only claimed missing when that was read.
      if (d.orientationUnavailable) {
        out.push({ note: 'orientation', text: 'Orientation unavailable', title: d.orientationUnavailable }) // prettier-ignore
      }
      if (d.objectsUnavailable) {
        out.push({ note: 'objects', text: 'Objects unavailable', title: d.objectsUnavailable })
      }
      if (d.spriteUnavailable) {
        out.push({ note: 'sprite-data', text: 'Sprites unavailable', title: d.spriteUnavailable })
      }
    }
  }
  // A missing ROM already says so, in the ROM note below; its start reason would repeat it.
  if (i.startWhy && i.startWhy !== i.romMissing) {
    out.push({
      note: 'start',
      text: 'Start unavailable',
      title: withDetail(i.startWhy, i.startDetail),
    })
  }
  if (d?.gfxAssignmentNote) {
    out.push({ note: 'gfx-assignment', text: d.gfxAssignmentNote, error: true })
  }
  if (i.romMissing) out.push({ note: 'rom-missing', text: i.romMissing, error: true })
  return out
}
