/**
 * The sprite subject of the Properties view (#984), derived only from the `MapSpriteDto` the map view draws
 * from. Ported in spirit from the reference extension's `spriteProps()` (src/webview/mapEditor/spriteProps.ts);
 * no shell imports, so it is unit tested without Theia.
 */
import type { MapSpriteDto, SpritePartDto } from '../common/project-protocol'
import { spriteLabel } from './map-view-model'

const TILE = 16

/** What the pane says for a sprite with one pose (or none that can be played); the reason is appended when known. */
export const NOT_ANIMATED = 'Not animated: this sprite shows one pose.'
export const LOADING_FRAMES = 'Checking for animation frames...'
export const animatedText = (n: number) => `Animated: ${n} frames, looping.`

/** Why a sprite is drawn as a numbered marker, in words; the engine's own reason is kept when it is not one of these. */
const WHY_NOT_DRAWN: Record<string, string> = {
  extraBits:
    'It uses the extra-bits marker that custom sprites use, so vanilla art would be wrong.',
  noParts: 'Its code drew no tiles.',
  charsNotLoaded: 'Some of its graphics are not loaded on this map.',
  noDescriptor: 'The app has no drawing rules for this sprite yet.',
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
  /** Anything the pane knows it is not showing (interpret, else warn). */
  notes: string[]
}

export function spriteProps(s: MapSpriteDto): SpriteProps {
  const parts = s.status === 'drawn' && s.parts ? s.parts : null
  const notes: string[] = []
  if (s.status === 'placeholder') {
    notes.push(`Not drawn: ${WHY_NOT_DRAWN[s.reason ?? ''] ?? s.reason ?? 'no reason recorded.'}`)
  }
  if (s.unverified) notes.push(`Unverified: ${s.unverified}.`)
  notes.push('Behaviour and extra settings are not interpreted in this view yet.')
  return {
    label: spriteLabel(s),
    id: s.id,
    name: s.name,
    col: Math.floor(s.x / TILE),
    row: Math.floor(s.y / TILE),
    parts,
    paletteRows: parts ? [...new Set(parts.map(p => p.palette))].sort((a, b) => a - b) : [],
    notes,
  }
}
