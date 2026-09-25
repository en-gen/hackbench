/**
 * Synthetic Mesen captures for the capture viewer tests. Laid out with their
 * own arithmetic, not tools/scripts/capture_decode.ts, so a helper bug there
 * cannot also shape the expected bytes.
 */
import * as D from '../../../../tools/scripts/capture_decode'

// Stored word order TR, BL, BR, TL: not its own inverse, so order[q] and
// order.indexOf(q) disagree. POS[q] is where quadrant q (0 TL 1 TR 2 BL 3 BR) sits.
export const NAMES = ['top-right', 'bottom-left', 'bottom-right', 'top-left']
export const POS = [3, 0, 1, 2]

function rng(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8
}

/** Word address in a 64x64 map at word `base`: four 32x32 screens, TL TR BL BR. */
export const addr64 = (tx: number, ty: number, base = 0x2000) =>
  base + (tx & 32 ? 0x400 : 0) + (ty & 32 ? 0x800 : 0) + (ty & 31) * 32 + (tx & 31)

/** Byte offset of Map16 cell (c, r) in one plane of the fixture's 3-screen grid. */
export const cellAt = (c: number, r: number, vert = false) =>
  vert
    ? Math.floor(r / 16) * 0x200 + Math.floor(c / 16) * 0x100 + (r % 16) * 16 + (c % 16)
    : Math.floor(c / 16) * 0x1b0 + r * 16 + (c % 16)

/** The Map16 id at (c, r): low plane, plus bit 0 of the high plane, 3 screens on. */
export const idAt = (grid: Uint8Array, c: number, r: number, vert = false) =>
  grid[cellAt(c, r, vert)] + (grid[3 * (vert ? 0x200 : 0x1b0) + cellAt(c, r, vert)] % 2) * 256

/**
 * A 3-screen map whose VRAM holds, for strips cam-7..cam+22 (1..30 by
 * default), the words grid + defs give. The camera at that strip makes
 * those the resident strips; the default crosses a screen boundary (stride)
 * and tilemap row 32 (the tall-screen term).
 */
export function fixture(opts: { vertical?: boolean; ids?: () => number; cam?: number } = {}) {
  const camStrip = opts.cam ?? 8
  const rnd = rng(0x1234)
  const vert = !!opts.vertical
  const [cols, rows, stride] = vert ? [32, 48, 0x200] : [48, 27, 0x1b0]
  const half = 3 * stride
  const at = (c: number, r: number) => cellAt(c, r, vert)
  const grid = new Uint8Array(half * 2)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const id = opts.ids ? opts.ids() : rnd() % 512
      grid[at(c, r)] = id % 256
      grid[half + at(c, r)] = Math.floor(id / 256) | 2 // bit 1 is not part of the id
    }
  const defs = new Uint8Array(512 * 8).map(() => rnd() & 0xff)
  const vram = new Uint8Array(0x10000)
  for (let s = Math.max(0, camStrip - 7); s <= camStrip + 22 && s < (vert ? rows : cols); s++)
    for (let k = 0; k < (vert ? cols : rows); k++) {
      const [c, r] = vert ? [k, s] : [s, k]
      const id = idAt(grid, c, r, vert)
      for (let q = 0; q < 4; q++) {
        const a = addr64(c * 2 + (q % 2), r * 2 + Math.floor(q / 2)) * 2
        vram[a] = defs[id * 8 + POS[q] * 2]
        vram[a + 1] = defs[id * 8 + POS[q] * 2 + 1]
      }
    }
  const meta: D.GridMeta = {
    orientation: vert ? 'vertical' : 'horizontal',
    screens: 3,
    bytesPerScreen: stride,
    lowOffset: 0,
    highOffset: half,
    base: 0,
  }
  const cam = vert ? { camX: 0, camY: camStrip * 16 } : { camX: camStrip * 16, camY: 16 }
  return { vram, grid, defs, meta, order: [1, 2, 3, 0], bg1sc: 0x23, ...cam, pipe: D.NO_PIPES }
}

/** The same map as the files its capture writes, keyed by file name. */
export function captureFiles(
  vertical = false,
  ids?: () => number,
  windows: number[] = [],
): Record<string, Buffer> {
  const f = fixture({ vertical, ids })
  const [cols, rows] = vertical ? [32, 48] : [48, 27]
  const j = (o: unknown) => Buffer.from(JSON.stringify(o))
  const reg = (byte: number) => ({ byte })
  const ppu = {
    BGMODE_2105: reg(0x09), BG1SC_2107: reg(0x23), BG2SC_2108: reg(0x33), BG3SC_2109: reg(0x53),
    BG12NBA_210B: reg(0), BG34NBA_210C: reg(4), OBSEL_2101: reg(3),
    BG2HOFS_210F: 0, BG2VOFS_2110: 0, BG3HOFS_2111: 0, BG3VOFS_2112: 0,
    camera: { layer1X: f.camX, layer1Y: f.camY, layer2X: 0, layer2Y: 0 },
    CGADSUB_2131: reg(0x20), COLDATA_2132: { fixedColorBgr555: 0x5d80 },
    CGWSEL_2130: { byte: null, wramColorAddition: 2 },
  } // prettier-ignore
  return {
    'capture_summary.json': j({ identityGate: 'pass', anchorFrame: 100, samples: [{ offset: 0 }, { offset: 8 }] }), // prettier-ignore
    'vram.bin': Buffer.from(f.vram),
    'frame_0000_cgram.bin': Buffer.alloc(512),
    'map16_grid.bin': Buffer.from(f.grid),
    'map16_defs.bin': Buffer.from(f.defs),
    'ppu.json': j(ppu),
    'map16_grid.json': j({
      lowOffset: 0,
      highOffset: f.meta.highOffset,
      tileId: '(high & 1) * 256 + low',
      inScreen: { vertical: '(col//16)*$100 + (row%16)*$10 + col%16' },
      layer1: { base: '$0', stride: '$' + f.meta.bytesPerScreen.toString(16), orientation: f.meta.orientation, screens: 3, cols, rows }, // prettier-ignore
    }),
    'map16_defs.json': j({ available: true, wordOrder: NAMES }),
    // No strip was built with a pipe set, so every pipe cell is a guess.
    'map16_pipe_writes.json': j({ entryPointers: 'Map16Pointers[$133..$13A] in order', defsWordOrder: NAMES, defs: {}, stripBuilds: [] }), // prettier-ignore
    // One scroll-pass window per camera strip: its BG1 picture's VRAM and registers.
    ...Object.fromEntries(windows.flatMap((cam, k) => {
      const w = fixture({ vertical, ids, cam })
      const dir = `windows/screen_${String(k).padStart(2, '0')}/`
      return [[dir + 'layer_bg1_vram.bin', Buffer.from(w.vram)], [dir + 'layer_bg1_data.json', j({ ...ppu, BG1HOFS_210D: w.camX, BG1VOFS_210E: w.camY, frame: 200, camera: { layer1X: w.camX, layer1Y: w.camY, layer2X: 0, layer2Y: 0 } })]]
    })), // prettier-ignore
  }
}
