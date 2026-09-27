/**
 * A button or toggle showing a pre-composited pixel-art picture in a FIXED
 * frame, so the control never resizes between states. Knows nothing about
 * switches or Map16; any image-driven button reuses it.
 */
import * as React from '@theia/core/shared/react'
import { placeInFrame, type FrameAlign, type FrameSize } from './pixel-image-button-model'
import { paintScaled } from './map16-pixels'

export interface FrameImage {
  /** Native pixel size of THIS picture - may be smaller than the frame; see `align`. */
  width: number
  height: number
  rgba: Uint8ClampedArray
}

export interface PixelImageButtonProps {
  /** The button's fixed native size; scaled up by `scale` on screen. */
  frame: FrameSize
  scale: number
  /** This state's picture, or undefined to fall back to `label` as text. */
  image: FrameImage | undefined
  align?: FrameAlign
  /** Accessible name AND the text shown when `image` is undefined. */
  label: string
  /** Present makes this a TOGGLE (renders `aria-pressed`); absent, a plain button. */
  pressed?: boolean
  /** Why there is no picture, shown in the tooltip alongside `label`. */
  reason?: string
  onClick(): void
  /** `data-*` attributes on the button: `{ control: 'x' }` becomes `data-control="x"`. */
  data?: Record<string, string>
}

export function PixelImageButton({
  frame,
  scale,
  image,
  align,
  label,
  pressed,
  reason,
  onClick,
  data,
}: PixelImageButtonProps): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    const { x: dx, y: dy } = placeInFrame(image, frame, align)
    const framed = new Uint8ClampedArray(frame.width * frame.height * 4)
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const fx = dx + x
        const fy = dy + y
        if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) continue
        const src = (y * image.width + x) * 4
        framed.set(image.rgba.subarray(src, src + 4), (fy * frame.width + fx) * 4)
      }
    }
    paintScaled(canvas, framed, frame.width, frame.height, scale)
    // Keyed on the pixels, not the wrapper object a parent rebuilds on every render.
  }, [
    image?.rgba,
    image?.width,
    image?.height,
    frame.width,
    frame.height,
    scale,
    align?.x,
    align?.y,
  ])

  const dataAttrs = Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]))
  const size = { width: frame.width * scale, height: frame.height * scale }

  return (
    <button
      type="button"
      {...dataAttrs}
      className={'hb-pixel-button' + (pressed ? ' hb-pixel-button-on' : '')}
      aria-label={label}
      title={reason ? `${label}: ${reason}` : label}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
      onClick={onClick}
    >
      {image ? (
        <canvas
          ref={canvasRef}
          className="hb-pixel-button-canvas"
          width={size.width}
          height={size.height}
          style={size}
        />
      ) : (
        <span className="hb-pixel-button-fallback" style={size}>
          {label}
        </span>
      )}
    </button>
  )
}
