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
export const MAX_PAD_INDEX = 3

export const DEFAULT_ASSIGNMENTS: readonly PlayerAssignment[] = [
  { keyboard: true, pad: 0 },
  { keyboard: false, pad: 1 },
]

/**
 * The drawing's colors per scheme, as the CSS custom properties controller-art
 * reads. PAL is exactly the source SVG's own colors (a unit test pins it to the
 * art's fallbacks); North American follows the owner-approved palette.
 */
export const SCHEME_COLORS: Readonly<Record<ControllerScheme, Readonly<Record<string, string>>>> = {
  pal: {
    '--hb-pad-a': '#ff4856',
    '--hb-pad-a-stroke': '#c72b3e',
    '--hb-pad-b': '#ffbb58',
    '--hb-pad-b-stroke': '#ba853d',
    '--hb-pad-x': '#0075fa',
    '--hb-pad-x-stroke': '#0054b3',
    '--hb-pad-y-1': '#00dea5',
    '--hb-pad-y-2': '#00f8b9',
    '--hb-pad-y-stroke': '#00ab7f',
    '--hb-pad-face': '#777f82',
    '--hb-pad-body-a': '#f6f6f4',
    '--hb-pad-body-b': '#f3f3ef',
    '--hb-pad-track': '#f4f4f1',
    '--hb-pad-track-stroke': '#fdfdfa',
    '--hb-pad-dish-a': '#dcdcdc',
    '--hb-pad-dish-b': '#eeeee9',
  },
  na: {
    '--hb-pad-a': '#4e3a86',
    '--hb-pad-a-stroke': '#2f2356',
    '--hb-pad-b': '#4e3a86',
    '--hb-pad-b-stroke': '#2f2356',
    '--hb-pad-x': '#b4a7d8',
    '--hb-pad-x-stroke': '#7d70a8',
    '--hb-pad-y-1': '#a99bd0',
    '--hb-pad-y-2': '#bfb3e0',
    '--hb-pad-y-stroke': '#7d70a8',
    '--hb-pad-face': '#7a7a82',
    '--hb-pad-body-a': '#d9d9dc',
    '--hb-pad-body-b': '#cfcfd3',
    '--hb-pad-track': '#b9b9be',
    '--hb-pad-track-stroke': '#c4c4c9',
    '--hb-pad-dish-a': '#bdbdc2',
    '--hb-pad-dish-b': '#c9c9ce',
  },
}

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

/**
 * Where the user is: the OS country when Electron supplies one, else the
 * region of the browser's languages. Undefined means unknown, which draws PAL.
 */
export function resolveRegion(
  osCountry: string | undefined,
  languages: readonly string[],
): string | undefined {
  return osCountry || localeRegion(languages)
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
  return players.map((a, i) => ({ ...a, keyboard: i === player ? on : a.keyboard && !on }))
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

/** A contested keyboard or pad stays with the first player; a stored duplicate would leak it to two ports. */
function exclusive(players: PlayerAssignment[]): PlayerAssignment[] {
  const pads = new Set<number>()
  let keyboard = false
  return players.map(p => {
    const mine = {
      keyboard: p.keyboard && !keyboard,
      pad: p.pad !== undefined && pads.has(p.pad) ? undefined : p.pad,
    }
    keyboard ||= mine.keyboard
    if (mine.pad !== undefined) pads.add(mine.pad)
    return mine
  })
}

/** Anything stored that is not usable falls back to the defaults. */
export function parseControllerSettings(raw: unknown): ControllerSettings {
  const fallback = { players: DEFAULT_ASSIGNMENTS.map(a => ({ ...a })), style: 'auto' as const }
  if (typeof raw !== 'object' || raw === null) return fallback
  const { players, style } = raw as Record<string, unknown>
  const parsed = Array.isArray(players) ? players.map(parsePlayer) : []
  const ok = parsed.length === PLAYER_COUNT && parsed.every(p => p !== undefined)
  return {
    players: ok ? exclusive(parsed as PlayerAssignment[]) : fallback.players,
    style: style === 'na' || style === 'pal' ? style : 'auto',
  }
}
