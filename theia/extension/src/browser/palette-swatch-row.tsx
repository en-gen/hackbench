/**
 * One row of palette swatches, any length: a CGRAM row is 16, Back Area
 * Colors is 8. Indices are positions in this row, not CGRAM indices; the
 * caller supplies the gutter text. Unwritten cells are hatched and carry
 * no color and no BGR555, so nothing fabricated is ever shown.
 */
import * as React from '@theia/core/shared/react'
import { PaletteCellDto } from '../common/palette-protocol'
import { cssColor, formatBgr555 } from './palette-color-format'

export interface PaletteSwatchRowProps {
  cells: PaletteCellDto[]
  gutter?: string
  selectedIndex?: number
  /** Cells tied to the selection (frames sharing one ROM word). */
  highlighted?: Set<number>
  /** Cells the level animation overwrites every frame. */
  marker?: Set<number>
  /** Caption under a swatch, e.g. a frame number. */
  label?: (index: number) => string | undefined
  onSelect?: (index: number) => void
}

export function PaletteSwatchRow(props: PaletteSwatchRowProps): React.ReactElement {
  return (
    <div className="hb-palette-row">
      {props.gutter !== undefined && <span className="hb-palette-row-gutter">{props.gutter}</span>}
      <div className="hb-palette-swatches">{props.cells.map((c, i) => swatch(props, c, i))}</div>
    </div>
  )
}

function swatch(props: PaletteSwatchRowProps, cell: PaletteCellDto, i: number): React.ReactNode {
  const caption = props.label?.(i)
  if (!cell.written) {
    return (
      <span key={i} className="hb-palette-swatch-cell">
        <span
          className="hb-palette-swatch hb-palette-swatch-unwritten"
          title={`Index ${i}: not written by any table this view reads`}
        />
        {caption !== undefined && <span className="hb-palette-swatch-caption">{caption}</span>}
      </span>
    )
  }
  const classes = ['hb-palette-swatch']
  if (props.selectedIndex === i) classes.push('hb-palette-swatch-selected')
  if (props.highlighted?.has(i)) classes.push('hb-palette-swatch-linked')
  if (props.marker?.has(i)) classes.push('hb-palette-swatch-animated')
  const c = cell.color
  return (
    <span key={i} className="hb-palette-swatch-cell">
      <span
        className={classes.join(' ')}
        style={{ background: cssColor(c) }}
        title={`Index ${i} · ${cell.table} · ${formatBgr555(c)} · RGB ${c.r}, ${c.g}, ${c.b}`}
        onClick={() => props.onSelect?.(i)}
      />
      {caption !== undefined && <span className="hb-palette-swatch-caption">{caption}</span>}
    </span>
  )
}
