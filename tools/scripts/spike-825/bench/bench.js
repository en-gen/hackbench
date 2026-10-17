/* global CM, document, performance, Worker, URL, Blob, ImageData, window, location, requestAnimationFrame, atob, fetch, URLSearchParams */
// #825 SPIKE bench page, standalone (NOT the shipped widget). ?map=10a&arm=A|B|C. Result in window.__result.
// A = today's path: shipped base64 decode + plane putImageData + composeScreen (the widget's composite),
// B = indexed CPU compositor in a Worker -> ImageBitmap, C = indexed WebGL2 (atlas + palette texture).
const KEYS = ['l2Low', 'l1Low', 'l2High', 'l1High', 'l3Low', 'l3High']
const q = new URLSearchParams(location.search)
const arm = q.get('arm')
const raf = () => new Promise(r => requestAnimationFrame(r))
// decodeBase64Bytes exactly as shipped: theia/extension/src/browser/map16-pixels.ts:22-27 (a plain loop, ~1 ms a plane).
function bytes64(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
const decodeRgba = s => new Uint8ClampedArray(bytes64(s).buffer)
/** BGR555 colors to a little-endian RGBA Uint32 table; entry 0 of a row is never drawn. */
function pal32(b64) {
  const w = new Uint16Array(bytes64(b64).buffer)
  const out = new Uint32Array(w.length)
  const up = c => (c << 3) | (c >> 2)
  w.forEach((v, i) => { out[i] = (255 << 24) | (up((v >> 10) & 31) << 16) | (up((v >> 5) & 31) << 8) | up(v & 31) }) // prettier-ignore
  return out
}

// ---- the CPU indexed compositor; also stringified into arm B's Worker ----
function raster(pl, cells, tiles, pal, w, h) {
  const out = new Uint32Array(w * h)
  const stride = pl.pal ? 4 : 16
  for (let r = 0; r < pl.rows; r++)
    for (let c = 0; c < pl.cols; c++) {
      const wd = cells[r * pl.cols + c]
      if (!wd) continue
      const base = ((wd & 0x7ff) - 1) * 64
      const pr = ((wd >> 11) & 7) * stride
      const [fx, fy] = [wd & 0x4000 ? 7 : 0, wd & 0x8000 ? 7 : 0]
      for (let y = 0; y < 8; y++) {
        const dy = pl.oy + r * 8 + y
        if (dy < 0 || dy >= h) continue
        for (let x = 0; x < 8; x++) {
          const dx = pl.ox + c * 8 + x
          const v = tiles[base + ((y ^ fy) << 3) + (x ^ fx)]
          if (v && dx >= 0 && dx < w) out[dy * w + dx] = pal[pr + v]
        }
      }
    }
  return new Uint8ClampedArray(out.buffer)
}
const WORKER_SRC = `importScripts(location.origin + '/compose.js')
${raster}
${bytes64}
let tiles, pal, w, h
onmessage = ({ data: m }) => {
  const t0 = performance.now()
  if (m.init) { tiles = bytes64(m.tiles); pal = [m.pal0, m.pal1]; w = m.w; h = m.h; return postMessage({ ready: true }) }
  if (m.setPal0) { pal[0] = m.setPal0; return }
  const bitmaps = {}
  const rgbas = {}
  const bmp = (rgba) => {
    const oc = new OffscreenCanvas(w, h)
    oc.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0)
    return oc.transferToImageBitmap()
  }
  for (const [k, p] of Object.entries(m.planes)) {
    if (!p) continue
    rgbas[k] = raster(p, new Uint16Array(bytes64(p.cells).buffer), tiles, pal[p.pal], w, h)
    bitmaps[k] = bmp(rgbas[k])
  }
  // The widget's composite (ColorMath.composeScreen, bundled as compose.js) runs here on the planes' RGBA.
  bitmaps.comp = bmp(CM.composeScreen({ width: w, height: h, planes: rgbas, lists: m.lists, math: m.math, doors: null }))
  postMessage({ id: m.id, bitmaps, ms: performance.now() - t0 }, Object.values(bitmaps))
}`

// ---- arm C: WebGL2, one shared canvas, results copied to each plane's 2D canvas ----
const VS = `#version 300 es
layout(location = 0) in vec2 p; void main(){ gl_Position = vec4(p, 0, 1); }`
const FS = `#version 300 es
precision highp int; precision highp float; precision highp usampler2D;
uniform usampler2D map; uniform usampler2D atlas; uniform sampler2D pal;
uniform ivec2 size; uniform ivec2 origin; uniform ivec2 dims; uniform int palBase;
out vec4 o;
void main(){
  ivec2 q = ivec2(gl_FragCoord.x, float(size.y) - gl_FragCoord.y) - origin;
  if (q.x < 0 || q.y < 0) discard;
  ivec2 c = q >> 3; if (c.x >= dims.x || c.y >= dims.y) discard;
  uint wd = texelFetch(map, c, 0).r; if (wd == 0u) discard;
  int t = int(wd & 0x7ffu) - 1;
  ivec2 in8 = q & 7;
  if ((wd & 0x4000u) != 0u) in8.x = 7 - in8.x;
  if ((wd & 0x8000u) != 0u) in8.y = 7 - in8.y;
  int v = int(texelFetch(atlas, ivec2((t & 127) * 8 + in8.x, (t >> 7) * 8 + in8.y), 0).r);
  if (v == 0) discard;
  o = texelFetch(pal, ivec2(v, palBase + int((wd >> 11) & 7u)), 0);
}`
function initGl(fix, w, h) {
  const cv = document.createElement('canvas')
  ;[cv.width, cv.height] = [w, h]
  const gl = cv.getContext('webgl2', { alpha: true, premultipliedAlpha: true })
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x } // prettier-ignore
  const pg = gl.createProgram()
  gl.attachShader(pg, sh(gl.VERTEX_SHADER, VS))
  gl.attachShader(pg, sh(gl.FRAGMENT_SHADER, FS)) // prettier-ignore
  gl.linkProgram(pg)
  gl.useProgram(pg)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0) // prettier-ignore
  const tex = (unit, fmt, ifmt, type, tw, th, data) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture()) // prettier-ignore
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST) // prettier-ignore
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, tw, th, 0, fmt, type, data)
  }
  const tiles = bytes64(fix.I.tiles)
  const n = tiles.length / 64
  const atlas = new Uint8Array(1024 * Math.ceil(n / 128) * 8)
  for (let t = 0; t < n; t++)
    for (let y = 0; y < 8; y++) atlas.set(tiles.subarray(t * 64 + y * 8, t * 64 + y * 8 + 8), ((t >> 7) * 8 + y) * 1024 + (t & 127) * 8) // prettier-ignore
  tex(1, gl.RED_INTEGER, gl.R8UI, gl.UNSIGNED_BYTE, 1024, Math.ceil(n / 128) * 8, atlas)
  const palTable = new Uint32Array(16 * 32) // rows 0-15 the map's CGRAM, rows 16-23 layer 3's (idx 0-3)
  const [p0, p1] = [pal32(fix.I.pal0), pal32(fix.I.pal1)]
  palTable.set(p0.subarray(0, 256))
  for (let r = 0; r < 8; r++) for (let v = 0; v < 4; v++) palTable[(16 + r) * 16 + v] = p1[r * 4 + v] // prettier-ignore
  tex(2, gl.RGBA, gl.RGBA8, gl.UNSIGNED_BYTE, 16, 32, new Uint8Array(palTable.buffer))
  const mapTex = gl.createTexture()
  const u = n => gl.getUniformLocation(pg, n)
  gl.uniform1i(u('map'), 0)
  gl.uniform1i(u('atlas'), 1)
  gl.uniform1i(u('pal'), 2) // prettier-ignore
  gl.uniform2i(u('size'), w, h)
  return {
    cv,
    gl,
    texBytes: atlas.length + palTable.length * 4,
    setPal0(p) { gl.activeTexture(gl.TEXTURE2); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(p.buffer, 0, 1024)) }, // prettier-ignore
    draw(p, target) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, mapTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST) // prettier-ignore
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, p.cols, p.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(bytes64(p.cells).buffer)) // prettier-ignore
      gl.uniform2i(u('origin'), p.ox, p.oy)
      gl.uniform2i(u('dims'), p.cols, p.rows)
      gl.uniform1i(u('palBase'), p.pal ? 16 : 0)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      target.getContext('2d').drawImage(cv, 0, 0)
    },
  }
}

// ---- the page ----
const stats = a => { const s = [...a].sort((x, y) => x - y); const at = f => s[Math.min(s.length - 1, Math.floor(f * s.length))]; return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1] } } // prettier-ignore
async function main() {
  const fix = await (await fetch(`/fix/map-${q.get('map')}.json`)).json()
  const { w, h } = fix
  if (arm === 'A') delete fix.I
  else delete fix.A
  const view = document.getElementById('view')
  const res = {
    arm,
    map: q.get('map'),
    gl: null,
    decodeMs: [],
    workerMs: [],
    composeMs: [],
    e2eMs: [],
    texBytes: 0,
  }
  const N = fix.A ? fix.A.length : fix.I.screens.length
  const slots = []
  const mk = s => {
    // one div per screen with a canvas per plane, as the widget stacks them
    const d = document.createElement('div')
    d.style.cssText = `position:absolute;left:${s * w}px;top:0;width:${w}px;height:${h}px` // prettier-ignore
    const cs = {}
    for (const k of [...KEYS, 'comp']) { const c = document.createElement('canvas'); [c.width, c.height] = [w, h]; c.style.cssText = 'position:absolute;left:0;top:0'; d.append(c); cs[k] = c } // prettier-ignore
    view.append(d)
    return (slots[s] = cs)
  }
  view.style.width = `${N * w}px`
  let worker, glx, pending = new Map(), nid = 0 // prettier-ignore
  const t00 = performance.now()
  if (arm === 'B') {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC])))
    const ready = new Promise(
      r => (worker.onmessage = ({ data }) => (data.ready ? r() : pending.get(data.id)?.(data))),
    )
    worker.postMessage({
      init: true,
      tiles: fix.I.tiles,
      pal0: pal32(fix.I.pal0),
      pal1: pal32(fix.I.pal1),
      w,
      h,
    })
    await ready
  } else if (arm === 'C') {
    glx = initGl(fix, w, h)
    res.gl = glx.gl.getParameter(glx.gl.RENDERER)
    res.texBytes = glx.texBytes
  }
  const showScreen = async s => {
    const cs = slots[s] ?? mk(s)
    const t0 = performance.now()
    const done0 = () => res.e2eMs.push(performance.now() - t0)
    if (arm === 'A') {
      // The widget's path: plane ImageData (decodeRgba) -> plane canvases, then composeScreen -> composite canvas.
      const planes = {}
      for (const k of KEYS) {
        const b = fix.A[s][k]
        if (!b) continue
        const img = new ImageData(decodeRgba(b), w, h)
        planes[k] = img.data
        cs[k].getContext('2d').putImageData(img, 0, 0)
      }
      const t1 = performance.now()
      const out = CM.composeScreen({ width: w, height: h, planes, lists: fix.L[s].lists, math: fix.L[s].math, doors: null }) // prettier-ignore
      cs.comp.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0)
      res.composeMs.push(performance.now() - t1)
      res.decodeMs.push(performance.now() - t0)
      done0()
    } else if (arm === 'C') {
      for (const k of KEYS) if (fix.I.screens[s][k]) glx.draw(fix.I.screens[s][k], cs[k])
      res.decodeMs.push(performance.now() - t0)
      done0()
    } else {
      const id = nid++
      const done = new Promise(r => pending.set(id, r))
      worker.postMessage({
        id,
        planes: fix.I.screens[s],
        lists: fix.L[s].lists,
        math: fix.L[s].math,
      })
      const mPost = performance.now() - t0
      const m = await done
      const t1 = performance.now()
      for (const k in m.bitmaps) { cs[k].getContext('2d').drawImage(m.bitmaps[k], 0, 0); m.bitmaps[k].close() } // prettier-ignore
      res.workerMs.push(m.ms)
      res.decodeMs.push(mPost + performance.now() - t1) // main thread only: post + drawImage, not the wait
      done0() // end to end: post, worker (raster + compose + bitmaps), return, drawImage
    }
  }
  for (let s = 0; s < 4; s++) await showScreen(s)
  await raf()
  await raf()
  res.firstPaintMs = performance.now() - t00 // arm setup (worker / GL init + shader compile) through 4 screens painted
  if (arm !== 'A') {
    const edit = new Uint32Array(pal32(fix.I.pal0))
    edit.fill(0xff0000ff, 16 * 3 + 1, 16 * 3 + 16) // prettier-ignore
    const t0 = performance.now()
    if (arm === 'B') {
      worker.postMessage({ setPal0: edit })
      for (let s = 0; s < 4; s++) await showScreen(s)
    } else {
      glx.setPal0(edit)
      for (let s = 0; s < 4; s++) await showScreen(s)
    }
    await raf()
    res.paletteEditMs = performance.now() - t0 // repaint of the 4 visible screens after a palette row change
    res.decodeMs.length -= 4
    res.e2eMs.length -= 4
    res.workerMs.length = Math.max(0, res.workerMs.length - 4) // prettier-ignore
  }
  // Scripted scroll: 16 px a frame; a screen is built when it comes within one screen of the viewport.
  const sc = document.getElementById('scroll')
  const frames = []
  let last = performance.now()
  const inflight = new Set()
  while (sc.scrollLeft + sc.clientWidth < N * w && frames.length < 3000) {
    sc.scrollLeft += 16
    for (let s = 0; s < N; s++)
      if (!slots[s] && (s + 1) * w - sc.scrollLeft < sc.clientWidth + w) {
        inflight.add(showScreen(s))
      }
    await raf()
    const now = performance.now()
    frames.push(now - last)
    last = now // prettier-ignore
  }
  await Promise.all(inflight)
  await raf()
  Object.assign(res, { scroll: stats(frames), frames: frames.length })
  res.dec = stats(res.decodeMs)
  res.decodeSum = res.decodeMs.reduce((t, v) => t + v, 0)
  res.canvasBytes = slots.reduce(t => t + (KEYS.length + 1) * w * h * 4, 0) // upper bound: six plane canvases plus the composite per screen // prettier-ignore
  res.e2e = stats(res.e2eMs)
  window.__result = res
}
main().catch(e => (window.__result = { error: String(e.stack || e) }))
