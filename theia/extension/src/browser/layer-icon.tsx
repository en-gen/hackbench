/**
 * A graphics layer's toolbar icon: a square frame with the layer's digit (or
 * "S" for sprites) inside, 16x16, 1px stroke, `currentColor`, in the codicon
 * style. The glyphs are paths, not font text, so they match at every zoom and
 * theme. Layer roles vary per map (#561), so the role is the tooltip's job, not
 * the icon's: the icon says which layer, in the fixed order 1, 2, 3, S.
 *
 * `LayerToggle` is the one show/hide button built on it, shared by the Map
 * tab and the Overworld view.
 */
import * as React from '@theia/core/shared/react'

export type LayerGlyph = '1' | '2' | '3' | 'S'

/** Each glyph centred in the frame's 13 x 13 interior, about 5 x 7. */
const GLYPHS: Record<LayerGlyph, string> = {
  '1': 'M6.5 6 L8.5 4.5 V11.5',
  '2': 'M5.5 5.8 A2.5 2.2 0 0 1 10.5 5.8 C10.5 8 5.5 9.2 5.5 11.5 H10.5',
  '3': 'M5.5 5 C6.5 3.8 10.5 3.9 10.3 6 C10.2 7.3 8.8 7.8 7.5 7.8 C9 7.8 10.5 8.4 10.5 9.9 C10.5 11.8 6.3 12 5.5 10.6', // prettier-ignore
  S: 'M10.3 5.6 C9.8 4.2 5.7 4.2 5.7 6.1 C5.7 8 10.3 7.8 10.3 9.9 C10.3 11.8 6.2 11.8 5.5 10.3',
}

export function LayerIcon({ glyph }: { glyph: LayerGlyph }): React.ReactElement {
  return (
    <svg
      className="hb-layer-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" data-part="frame" />
      <path d={GLYPHS[glyph]} data-part="glyph" data-glyph={glyph} />
    </svg>
  )
}

/** A layer's show/hide button. `label` is its tooltip; a disabled button says why in it. */
export function LayerToggle(props: {
  glyph: LayerGlyph
  label: string
  pressed: boolean
  disabled?: boolean
  control: string
  onClick(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      data-control={props.control}
      data-glyph={props.glyph}
      className={
        'hb-icon-btn hb-layer-btn' + (props.pressed ? ' hb-icon-btn-on' : ' hb-icon-btn-off')
      }
      aria-pressed={props.pressed}
      disabled={props.disabled}
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
    >
      <LayerIcon glyph={props.glyph} />
    </button>
  )
}
