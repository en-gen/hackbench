/**
 * The sprite subject of the Properties view (#984), derived only from the `MapSpriteDto` the map view draws
 * from. Ported in spirit from the reference extension's `spriteProps()` (src/webview/mapEditor/spriteProps.ts);
 * no shell imports, so it is unit tested without Theia.
 */
import type { MapSpriteDto, SpritePartDto } from '../common/project-protocol'
import { RIDES_WITH_REASON } from '../common/project-protocol'
import type { FramesState } from './sprite-frames'

const TILE = 16

/** The panel's heading for a sprite: "Podoboo (sprite $33)", or "Sprite $33" when the table has no name. Formats only; the name comes from the DTO. */
export function spriteLabel(s: Pick<MapSpriteDto, 'id' | 'name'>): string {
  const id = '$' + s.id.toString(16).toUpperCase().padStart(2, '0')
  return s.name ? `${s.name} (sprite ${id})` : `Sprite ${id}`
}

/** The hover text of a marker, "Name (sprite $XX): why", or undefined for a sprite that is drawn (#1083). */
export const placeholderText = (
  s: Pick<MapSpriteDto, 'id' | 'name'> & Partial<Pick<MapSpriteDto, 'status' | 'reason'>>,
): string | undefined =>
  s.status === 'placeholder' ? `${spriteLabel(s)}: ${notDrawnText(s.reason)}` : undefined

/** What the pane says for a sprite with one pose; when frames could not be had it says `Animation not shown` instead. */
export const NOT_ANIMATED = 'Not animated: this sprite shows one pose.'
export const LOADING_FRAMES = 'Checking for animation frames...'
export const animatedText = (n: number) => `Animated: ${n} frames, looping.`

/** Why a sprite is drawn as a numbered marker, in words. The engine's own codes are not kept: an unknown one gets the generic line. */
const WHY_NOT_DRAWN: Record<string, string> = {
  extraBits:
    'It uses the extra-bits marker that custom sprites use, so vanilla art would be wrong.',
  noParts: 'Its code drew no tiles.',
  charsNotLoaded: 'Some of its graphics are not loaded on this map.',
  noDescriptor: 'The app has no drawing rules for this sprite yet.',
  unrevealed: 'It draws nothing at first, and the app could not tell what reveals it.',
}

/** Why a sprite is a marker, in words. The engine's reason codes never reach the screen: an unknown one gets the generic line. */
export function notDrawnText(reason: string | undefined): string {
  if (!reason) return 'The app has no reason recorded for this.'
  if (Object.hasOwn(WHY_NOT_DRAWN, reason)) return WHY_NOT_DRAWN[reason]!
  if (reason === 'customHandler') return 'This map runs different code for this sprite than the game does, so vanilla art would be wrong.' // prettier-ignore
  if (reason.startsWith('refused:')) return "The app could not run this sprite's code."
  if (reason.startsWith('drew no')) return WHY_NOT_DRAWN.noParts!
  return 'The app could not draw this sprite.'
}

/**
 * Why no animation is shown, in words. The node side and the player keep their reason codes (they are not
 * UI strings); this is the only place they become sentences, and an unknown one never reaches the screen.
 */
export function framesReasonText(reason: string): string {
  if (Object.hasOwn(WHY_NOT_DRAWN, reason)) return WHY_NOT_DRAWN[reason]!
  if (reason === RIDES_WITH_REASON)
    return 'Drawn as part of the sprite it rides with, not on its own.'
  if (reason === 'rom-not-located') return 'The ROM for this project could not be found.'
  if (reason.startsWith('refused:')) return "The app could not run this sprite's code."
  if (reason.startsWith('INIT erased')) return 'The sprite removes itself as it starts.'
  if (reason.startsWith('its parts are fixed')) return 'Its parts are fixed to the screen, so they have no place on the map to animate at.' // prettier-ignore
  if (reason.startsWith('it is drawn by a special routine')) return 'This sprite is drawn by its own routine, not frame by frame, so no animation is shown.' // prettier-ignore
  if (reason.startsWith('drew no')) return WHY_NOT_DRAWN.noParts!
  if (reason === 'it has no picture')
    return 'It has no picture on the map, so there is nothing to animate.'
  return 'The frames could not be worked out.'
}

/** The animation line under the picture; nothing while the player has not been asked yet. */
export function animationText(f: FramesState): string | undefined {
  switch (f.kind) {
    case 'idle':
      return undefined
    case 'loading':
      return LOADING_FRAMES
    case 'playing':
      return animatedText(f.frames.length)
    case 'still':
      return f.reason ? `Animation not shown: ${framesReasonText(f.reason)}` : NOT_ANIMATED
  }
}

export interface SpriteProps {
  label: string
  id: number
  name?: string
  /** Anchor in 16 px tiles, counted from the map's top-left. */
  col: number
  row: number
  /** null for a placeholder, which has no parts. */
  parts: SpritePartDto[] | null
  /** Distinct CGRAM rows the parts draw with, ascending. */
  paletteRows: number[]
  /** The engine's own reason for a placeholder, for a tooltip only; the words are in `notes`. */
  rawReason?: string
  /** Kept off `notes` so the raw cause can never reach the visible text or an accessible name; it is shown only on request (#1166). */
  rawUnverified?: string
  /** Anything the pane knows it is not showing (interpret, else warn). */
  notes: string[]
}

/**
 * The plain-words note for a sprite drawn away from the tile the map stores it on (R16): the distance is the
 * difference the run produced, never a constant here. Absent when the picture is on its stored tile.
 */
export function shiftNote(
  s: Pick<MapSpriteDto, 'x' | 'y' | 'stored' | 'afterInit' | 'onLine'>,
): string | undefined {
  if (!s.stored) return undefined
  const words = (dx: number, dy: number) =>
    [
      dx && `${Math.abs(dx)} px to the ${dx < 0 ? 'left' : 'right'}`,
      dy && `${Math.abs(dy)} px ${dy < 0 ? 'up' : 'down'}`,
    ]
      .filter(Boolean)
      .join(' and ')
  // Start-up code moves it to `afterInit`, its first step on to where it is first drawn; with no split, all is start-up.
  const mid = s.afterInit ?? { x: s.x, y: s.y }
  const [start, step] = [
    words(mid.x - s.stored.x, mid.y - s.stored.y),
    words(s.x - mid.x, s.y - mid.y),
  ]
  // Wording from what happened: a fall is not a "first step" (it can last many frames), and `onLine` is absent when no line was reached.
  const fell = s.onLine === 'fell'
  const cause = start
    ? step
      ? fell
        ? `Its start-up code moves it ${start}, and it then falls ${step} more onto its line`
        : `Its start-up code moves it ${start}, and its first step ${step} more, before it is first drawn`
      : `Its own start-up code moves it ${start} before it is first drawn`
    : step
      ? fell
        ? `It falls ${step} onto its line before it is first drawn`
        : `Its first step moves it ${step} before it is first drawn`
      : undefined
  if (!cause) return undefined
  const there = s.onLine ? 'where it first sits on its line' : 'there'
  return `${cause}, so the map draws it ${there}, as the game does. The highlighted tile is where the map stores it.`
}

/** The engine's cause is not for a first read, so the visible line is fixed plain words and the cause is shown only on request (#1166). */
export const UNVERIFIED_NOTE = 'Unverified: this sprite may not be drawn exactly as in the game.'

/** Decides which notes get a disclosure: only a note with engine text behind it, so a plain line never shows an empty control (#1166). */
export const noteTitle = (
  note: string,
  p: Pick<SpriteProps, 'rawReason' | 'rawUnverified'>,
): string | undefined =>
  note.startsWith('Not drawn')
    ? p.rawReason
    : note === UNVERIFIED_NOTE
      ? p.rawUnverified
      : undefined

/** The quiet marker's tooltip and Properties line (#1011): the sprite's name, then why nothing shows. Plain words. */
export function quietText(s: Pick<MapSpriteDto, 'kind' | 'name' | 'reason'>): string {
  if (s.kind === 'scroll')
    return 'Scroll command: changes how the screen scrolls; it has no picture in the game'
  if (s.kind === 'shooter')
    return `${s.name ?? 'Shooter'}: fires on a timer; nothing is drawn until it does`
  if (s.kind === 'generator')
    return `${s.name ?? 'Generator'}: runs in the background; it has no picture on the map`
  // A reason the Properties view has words for says why (the reveal search found no condition, #1132).
  const why = s.reason ? WHY_NOT_DRAWN[s.reason] : undefined
  if (why) return s.name ? `${s.name}: ${why}` : why
  // The words claim only what was checked: nothing drew in the app's run, which cannot tell a sprite that shows only in play.
  return s.name
    ? `${s.name}: nothing is drawn for it on the map; it may only show up in play`
    : 'Nothing is drawn for it on the map; it may only show up in play'
}

/** The engine's wording is for diagnosis and is long and technical, so the notes stay plain words and the raw text is carried apart for a tooltip or disclosure (#1166). */
export function spriteProps(s: MapSpriteDto): SpriteProps {
  const parts = s.status === 'drawn' && s.parts ? s.parts : null
  const notes: string[] = []
  if (s.status === 'placeholder') {
    notes.push(`Not drawn: ${notDrawnText(s.reason)}`)
  } else if (s.status === 'quiet') notes.push(quietText(s).replace(/\.?$/, '.'))
  if (s.unverified) notes.push(UNVERIFIED_NOTE)
  const shift = shiftNote(s)
  if (shift) notes.push(shift)
  if (s.note) notes.push(s.note)
  notes.push('Behavior and extra settings are not interpreted in this view yet.')
  return {
    label: spriteLabel(s),
    id: s.id,
    name: s.name,
    // The tile the map stores the sprite on, which is the drawn anchor unless the sprite's INIT shifts it (R16).
    col: Math.floor((s.stored?.x ?? s.x) / TILE),
    row: Math.floor((s.stored?.y ?? s.y) / TILE),
    parts,
    paletteRows: parts ? [...new Set(parts.map(p => p.palette))].sort((a, b) => a - b) : [],
    notes,
    ...(s.status === 'placeholder' && s.reason ? { rawReason: s.reason } : {}),
    ...(s.unverified ? { rawUnverified: s.unverified } : {}),
  }
}
