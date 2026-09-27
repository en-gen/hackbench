/**
 * Pure placement math for pixel-image-button.tsx, split out (same reason as
 * map16-view-model.ts) so it is unit-testable without React or a DOM.
 */

export interface FrameSize {
  width: number
  height: number
}

export type FrameAlign = { x: 'start' | 'center' | 'end'; y: 'start' | 'center' | 'end' }

export const CENTER_ALIGN: FrameAlign = { x: 'center', y: 'center' }

/**
 * Where `img`'s top-left corner lands inside `frame`, in native pixels.
 *
 * A picture that exactly fills the frame gets `{0,0}` under every `align`
 * value - the slack is 0 on both axes, so the "start"/"center"/"end"
 * branches all agree - which is what makes `align` genuinely IGNORED for a
 * full-frame picture rather than merely defaulted to center.
 *
 * A picture LARGER than the frame is a caller bug: `warn` names both sizes
 * so it is loud, and the math still returns a placement (never NaN) so the
 * caller can clip against it rather than throw.
 */
export function placeInFrame(
  img: FrameSize,
  frame: FrameSize,
  align: FrameAlign = CENTER_ALIGN,
  warn: (message: string) => void = console.warn,
): { x: number; y: number } {
  if (img.width > frame.width || img.height > frame.height) {
    warn(
      `pixel-image-button: a ${img.width}x${img.height} image does not fit its ${frame.width}x${frame.height} frame; clipping`,
    )
  }
  const along = (imgLen: number, frameLen: number, a: 'start' | 'center' | 'end'): number => {
    const slack = frameLen - imgLen
    if (a === 'start') return 0
    if (a === 'end') return slack
    return Math.floor(slack / 2)
  }
  return { x: along(img.width, frame.width, align.x), y: along(img.height, frame.height, align.y) }
}
