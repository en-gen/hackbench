/**
 * Which devices drive which player, and which controller drawing to show.
 * Pure, so it is unit-tested without Theia; persisted per machine by the
 * emulator widget through StorageService.
 */

export interface PlayerAssignment {
  /** The keyboard drives this player. */
  keyboard: boolean
  /** Gamepad index (navigator.getGamepads slot), or undefined for none. */
  pad: number | undefined
}

export type ControllerStyle = 'auto' | 'na' | 'pal'
export type ControllerScheme = 'na' | 'pal'

export interface ControllerSettings {
  players: PlayerAssignment[]
  style: ControllerStyle
}

export const PLAYER_COUNT = 2
const MAX_PAD_INDEX = 3

export const DEFAULT_ASSIGNMENTS: readonly PlayerAssignment[] = [
  { keyboard: true, pad: 0 },
  { keyboard: false, pad: 1 },
]

const NA_REGIONS = new Set(['US', 'CA', 'MX'])

/** North American colors for the US, Canada and Mexico; everyone else gets PAL. */
export function schemeForRegion(region: string | undefined): ControllerScheme {
  return region && NA_REGIONS.has(region.toUpperCase()) ? 'na' : 'pal'
}

/**
 * The region of the first language tag that names one. The OS country is not
 * reachable from the sandboxed Electron frontend; navigator.languages carries
 * the OS locale there and the browser's in the browser build.
 */
export function localeRegion(languages: readonly string[]): string | undefined {
  for (const tag of languages) {
    try {
      const region = new Intl.Locale(tag).region
      if (region) return region
    } catch {
      // A malformed tag names no region.
    }
  }
  return undefined
}

export function resolveScheme(
  style: ControllerStyle,
  region: string | undefined,
): ControllerScheme {
  return style === 'auto' ? schemeForRegion(region) : style
}

/** The keyboard belongs to one player at a time, so turning it on elsewhere clears the rest. */
export function assignKeyboard(
  players: readonly PlayerAssignment[],
  player: number,
  on: boolean,
): PlayerAssignment[] {
  return players.map((a, i) => ({ ...a, keyboard: i === player ? on : on ? false : a.keyboard }))
}

/** A pad drives one player at a time, so choosing it here takes it from the other. */
export function assignPad(
  players: readonly PlayerAssignment[],
  player: number,
  pad: number | undefined,
): PlayerAssignment[] {
  return players.map((a, i) => ({
    ...a,
    pad: i === player ? pad : pad !== undefined && a.pad === pad ? undefined : a.pad,
  }))
}

function parsePlayer(raw: unknown): PlayerAssignment | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { keyboard, pad } = raw as Record<string, unknown>
  return {
    keyboard: keyboard === true,
    pad:
      typeof pad === 'number' && Number.isInteger(pad) && pad >= 0 && pad <= MAX_PAD_INDEX
        ? pad
        : undefined,
  }
}

/** Anything stored that is not usable falls back to the defaults. */
export function parseControllerSettings(raw: unknown): ControllerSettings {
  const fallback = { players: DEFAULT_ASSIGNMENTS.map(a => ({ ...a })), style: 'auto' as const }
  if (typeof raw !== 'object' || raw === null) return fallback
  const { players, style } = raw as Record<string, unknown>
  const parsed = Array.isArray(players) ? players.map(parsePlayer) : []
  const ok = parsed.length === PLAYER_COUNT && parsed.every(p => p !== undefined)
  return {
    players: ok ? (parsed as PlayerAssignment[]) : fallback.players,
    style: style === 'na' || style === 'pal' ? style : 'auto',
  }
}
