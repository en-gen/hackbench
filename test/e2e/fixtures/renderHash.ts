import type { FrameLocator } from '@playwright/test'

export interface RenderSample {
  /** FNV-1a over the RGB channels of the composed map canvas. */
  hash: string
  /** Pixels with any non-zero colour channel. A coarse "how much is drawn". */
  litPixels: number
}

/**
 * What the map editor actually drew.
 *
 * This is not a graphics-correctness check and must not become one: it never
 * says what the pixels should be, only whether they moved. That is the whole
 * point. "Layer 1 is hidden" is a claim about the render, and the toolbar
 * button's own `on` class cannot support it: wireLayerBtn toggles that class
 * from the backing checkbox, so it still flips when the store link is severed
 * and layer 1 goes on drawing. See docs/vscode-ui-testing-spike.md for the
 * mutation run that established this, and oracleCanFail.spec.ts for the
 * committed proof that this sampler goes red where the class does not.
 */
export async function sampleRender(webview: FrameLocator): Promise<RenderSample> {
  return await webview.locator('#model-canvas').evaluate((el) => {
    const canvas = el as HTMLCanvasElement
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('#model-canvas has no 2d context')
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)

    let hash = 2166136261
    let litPixels = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (r | g | b) litPixels++
      hash = Math.imul(hash ^ r, 16777619)
      hash = Math.imul(hash ^ g, 16777619)
      hash = Math.imul(hash ^ b, 16777619)
    }
    return { hash: (hash >>> 0).toString(16), litPixels }
  })
}
