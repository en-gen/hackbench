/**
 * One char-switch toggle (blue, silver, ON/OFF; #573/#574), shared by the
 * Map16 inspector and the map tab: the switch's own ROM art on the shared
 * PixelImageButton, its name as text when the art cannot be read.
 */
import * as React from '@theia/core/shared/react'
import type { Map16SwitchButtonImages, Map16SwitchKind } from '../common/map16-protocol'
import { SWITCH_LABELS } from './map16-view-model'
import { PixelImageButton, type FrameImage } from './pixel-image-button'

/** Native size of every switch toggle's picture (Map16SwitchButtonImages). */
const SWITCH_BUTTON_PX = { width: 16, height: 16 }

export interface SwitchButtonImages {
  off: FrameImage
  on: FrameImage
}

export function decodeSwitchButton(
  dto: Map16SwitchButtonImages,
  decode: (base64: string) => Uint8ClampedArray,
): SwitchButtonImages {
  return {
    off: { ...SWITCH_BUTTON_PX, rgba: decode(dto.offRgba) },
    on: { ...SWITCH_BUTTON_PX, rgba: decode(dto.onRgba) },
  }
}

export function SwitchToggle(props: {
  kind: Map16SwitchKind
  images: SwitchButtonImages | undefined
  pressed: boolean
  reason?: string
  scale: number
  data: Record<string, string>
  onClick(): void
}): React.ReactElement {
  const { images, pressed } = props
  return (
    <PixelImageButton
      frame={SWITCH_BUTTON_PX}
      scale={props.scale}
      image={images && (pressed ? images.on : images.off)}
      label={SWITCH_LABELS[props.kind]}
      pressed={pressed}
      reason={images ? undefined : props.reason}
      onClick={props.onClick}
      data={props.data}
    />
  )
}
