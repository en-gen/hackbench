/**
 * Animation frames under the inspector preview, 8 per row so the strip is
 * never wider than the preview column. The playing frame is highlighted;
 * a selected frame also highlights every other frame reading the same ROM word.
 */
import * as React from '@theia/core/shared/react'
import { PaletteAnimFrameDto, PaletteCellDto } from '../common/palette-protocol'
import { PaletteSwatchRow } from './palette-swatch-row'
import { chunk, FRAMES_PER_ROW, linkedIndices } from './palette-view-model'

export interface PaletteFrameStripProps {
  frames: PaletteAnimFrameDto[]
  playingIndex: number | undefined
  selectedIndex: number | undefined
  onSelect: (index: number) => void
}

export function PaletteFrameStrip(props: PaletteFrameStripProps): React.ReactElement {
  const linked =
    props.selectedIndex === undefined
      ? new Set<number>()
      : linkedIndices(props.frames, props.selectedIndex)
  // The selected frame carries the solid outline; the dashed one marks only the OTHER frames sharing its word.
  if (props.selectedIndex !== undefined) linked.delete(props.selectedIndex)
  const rows = chunk(
    props.frames.map((f, i) => ({ f, i })),
    FRAMES_PER_ROW,
  )
  return (
    <div className="hb-palette-frames">
      {rows.map((row, r) => {
        const base = r * FRAMES_PER_ROW
        const cells: PaletteCellDto[] = row.map(({ f }) => ({
          written: true,
          color: f.color,
          table: 'Animation frame',
          romAddr: f.romAddr,
        }))
        const local = (s: Set<number>) =>
          new Set([...s].filter(i => i >= base && i < base + row.length).map(i => i - base))
        const selected = props.selectedIndex ?? props.playingIndex
        return (
          <PaletteSwatchRow
            key={r}
            cells={cells}
            selectedIndex={selected !== undefined && selected >= base ? selected - base : undefined}
            highlighted={local(linked)}
            label={i => String(base + i)}
            onSelect={i => props.onSelect(base + i)}
          />
        )
      })}
    </div>
  )
}
