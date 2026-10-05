// Render Map16 blocks using the EMULATOR's graphics, not our own decoder.
//
// The premise being tested: after a level loads, the core's VRAM holds the
// decompressed 8x8 characters and its CGRAM holds the live palette. If we can
// read both, we never implement LC_LZ2, never reimplement palette loading, and
// never have to scroll a camera to see the level. Map16 composition still
// comes from the ROM's own tables, which is a lookup we already trust.
//
// Locations are established by spikes/libretro-view-engine/node/ppuprobe.cjs:
//   WRAM   found by planting a signature through the cheat API
//   VRAM   wram_base + 0x20000, 64KB (density stops exactly at +64KB)
//   CGRAM  a separate allocation, found by content each run
//
// Output is a PNG of one Map16 page, which is the "objects palette" a user
// would drag tiles from.
const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const zlib = require('zlib');
const P = 'vendor/cores/snes9x-wasm/';
const ROM = 'C:/Users/engenb/Super Mario World (USA).vanilla.sfc';
const OUT = process.argv[2] || 'spikes/libretro-view-engine/t15/evidence';
const LEVEL = parseInt(process.argv[3] || '0x105', 16);

// ── browser shims, same as harness.cjs ───────────────────────────────────────
const glStub = () => new Proxy({}, { get: (t,k) =>
  (typeof k === 'string' && /^[A-Z][A-Z_0-9]*$/.test(k)) ? 1 : (() => 1) });
const canvas = { width:256, height:224, style:{}, addEventListener(){}, removeEventListener(){},
  getContext(){ return glStub(); },
  getBoundingClientRect(){ return {left:0,top:0,width:256,height:224}; } };
const evt = { addEventListener(){}, removeEventListener(){}, dispatchEvent(){return true;}, style:{} };
const doc = { body:evt, currentScript:{src:''}, getElementById:()=>canvas, createElement:()=>canvas,
  addEventListener(){}, removeEventListener(){}, querySelector:()=>canvas };
global.document = doc;
global.addEventListener = ()=>{}; global.removeEventListener = ()=>{}; global.dispatchEvent = ()=>true;
global.window = global;
global.performance = global.performance || { now: () => Date.now() };
global.requestAnimationFrame = cb => { global.__pending = cb; return 1; };
global.cancelAnimationFrame = () => {};
global.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
global.MutationObserver = global.MutationObserver || class { observe(){} disconnect(){} };
global.WebGLRenderingContext = class {}; global.WebGL2RenderingContext = class {};
global.navigator = global.navigator || { userAgent:'node', language:'en-US' };
global.location = global.location || { href:'http://localhost/', origin:'http://localhost' };

const factory = new Function(`${readFileSync(P+'snes9x_libretro.js','utf8')}; return EJS_Runtime;`)();
const log = [];
function pump(M,n){ let a=0; while(a<n){ if(typeof global.__pending!=='function'){ M.resumeMainLoop();
  if(typeof global.__pending!=='function') break; } const cb=global.__pending; global.__pending=null;
  cb(performance.now()); a++; } return a; }

function findAll(H, pat, limit) {
  const hits = [];
  outer: for (let i = 0; i <= H.length - pat.length; i++) {
    if (H[i] !== pat[0]) continue;
    for (let j = 1; j < pat.length; j++) if (H[i+j] !== pat[j]) continue outer;
    hits.push(i);
    if (hits.length >= limit) break;
  }
  return hits;
}

// ── minimal PNG writer (no image dependency in this repo) ────────────────────
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(path, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ── SNES decoding ────────────────────────────────────────────────────────────
/** One 8x8 4bpp character from VRAM, as 64 palette indices 0-15. */
function charPixels(vram, charNum, charBaseBytes) {
  const out = new Uint8Array(64);
  // SNES addresses VRAM in WORDS and charNum is relative to the layer's
  // character base ($2107/$210B), not to VRAM byte 0. Assuming base 0 is what
  // made the first render a jumble of real-but-misplaced tiles.
  const base = (charBaseBytes | 0) + charNum * 32;
  if (base + 32 > vram.length) return out;
  for (let y = 0; y < 8; y++) {
    // Planes 0/1 interleaved in the first 16 bytes, planes 2/3 in the next 16.
    const p0 = vram[base + y * 2], p1 = vram[base + y * 2 + 1];
    const p2 = vram[base + 16 + y * 2], p3 = vram[base + 16 + y * 2 + 1];
    for (let x = 0; x < 8; x++) {
      const b = 7 - x;
      out[y * 8 + x] = ((p0 >> b) & 1) | (((p1 >> b) & 1) << 1)
                     | (((p2 >> b) & 1) << 2) | (((p3 >> b) & 1) << 3);
    }
  }
  return out;
}

/** CGRAM is 256 BGR555 words. Index 0 of each row is transparent. */
function cgramRgba(cgram, index) {
  const v = cgram[index * 2] | (cgram[index * 2 + 1] << 8);
  return [(v & 0x1f) << 3, ((v >> 5) & 0x1f) << 3, ((v >> 10) & 0x1f) << 3, 255];
}

/** Draw one 8x8 character into an RGBA buffer. */
function blit(rgba, w, px, py, pix, cgram, palRow, flipX, flipY) {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const idx = pix[(flipY ? 7 - y : y) * 8 + (flipX ? 7 - x : x)];
      if (idx === 0) continue;                    // colour 0 is transparent
      const [r, g, b] = cgramRgba(cgram, palRow * 16 + idx);
      const o = ((py + y) * w + (px + x)) * 4;
      rgba[o] = r; rgba[o+1] = g; rgba[o+2] = b; rgba[o+3] = 255;
    }
  }
}

factory({
  noInitialRun:true, arguments:[], preRun:[], postRun:[], canvas, callbacks:{}, parent:doc.body,
  print: m=>log.push('[out] '+m), printErr: m=>log.push('[err] '+m),
  wasmBinary: readFileSync(P+'snes9x_libretro.wasm'),
  getSavExt:()=>'.srm', getInputText:()=>'',
}).then(async M => {
  const FS=M.FS; let c='';
  for(const p of '/home/web_user/.config/retroarch'.split('/').filter(Boolean)){ c+='/'+p; try{FS.mkdir(c);}catch(e){} }
  FS.writeFile('/home/web_user/.config/retroarch/retroarch.cfg',
    'screenshot_directory = "/"\nvideo_gpu_screenshot = false\naudio_enable = false\nvideo_driver = "null"\n');
  FS.writeFile('/rom.sfc', new Uint8Array(readFileSync(ROM)));
  M.callMain(['/rom.sfc']); M.resumeMainLoop();
  pump(M,400);

  // 1. WRAM
  const setCheat = M.cwrap('set_cheat','null',['number','number','string']);
  const MAGIC=[0xA5,0x5A,0xC3,0x3C,0xDE,0xAD,0xBE,0xEF];
  MAGIC.forEach((v,i)=>setCheat(i,1,(0x7E1000+i).toString(16).toUpperCase().padStart(6,'0')+v.toString(16).toUpperCase().padStart(2,'0')));
  pump(M,60);
  MAGIC.forEach((_,i)=>setCheat(i,0,'00000000'));
  const wramHits = findAll(M.HEAPU8, MAGIC, 2);
  if (!wramHits.length) { console.log('FAIL wram not found'); return; }
  const base = wramHits[0] - 0x1000;

  // 2. Level
  const GAME_MODE=0x100, OW_OVERRIDE=0x109, OW_SUBMAP=0x1f11, KEEP_MODE=0xdb1;
  const gm = () => M.HEAPU8[base+GAME_MODE];
  let n=0; while (gm() !== 0x07 && n < 3000) { pump(M,10); n+=10; }
  const lo = LEVEL & 0xff;
  M.HEAPU8[base+OW_OVERRIDE] = lo < 0x25 ? lo : lo + 0x24;
  M.HEAPU8[base+OW_SUBMAP] = LEVEL >= 0x100 ? 1 : 0;
  M.HEAPU8[base+KEEP_MODE] = 0x02;
  M.HEAPU8[base+GAME_MODE] = 0x0f;
  n=0; while (gm() !== 0x14 && n < 1500) { pump(M,10); n+=10; }
  if (gm() !== 0x14) { console.log('FAIL level did not load'); return; }
  pump(M,60);
  console.log('level $'+LEVEL.toString(16)+' loaded');

  // 3. VRAM and CGRAM out of the heap
  // VRAM base, established by identity rather than by the density estimate.
  // Decompressed GFX tiles land at wram_base+0x20024, +0x2D024 and +0x2F084,
  // which are VRAM offsets 0x0000, 0xD000 and 0xF060 from this base: all three
  // inside one 64KB window and all 32-byte aligned, which they would not be if
  // the base were wrong. The density sweep said 0x20000, and being 36 bytes
  // short is what produced real tiles in the wrong places.
  const VRAM_OFF = 0x20024;
  const vram = M.HEAPU8.slice(base + VRAM_OFF, base + VRAM_OFF + 0x10000);
  const pal = Array.from(M.HEAPU8.slice(base+0x703, base+0x703+64));
  const cgHits = findAll(M.HEAPU8, pal, 8).filter(h => h < base || h >= base + 0x20000);
  if (!cgHits.length) { console.log('FAIL cgram not found by content'); return; }
  const cgram = M.HEAPU8.slice(cgHits[0], cgHits[0] + 512);
  console.log('vram 0x'+(base+0x20000).toString(16)+'  cgram 0x'+cgHits[0].toString(16));
  const nonZeroVram = vram.reduce((a,b)=>a+(b?1:0),0);
  console.log('vram non-zero bytes: '+nonZeroVram+'/65536');

  // 4. Map16 definitions, read from the ROM's own tables via the shipped reader.
  // The Map16 reader is TypeScript; ROMCJS points at a CommonJS emit of it, so
  // the ROM tables are read by the SHIPPED code rather than reimplemented here.
  const CJS = process.env.ROMCJS;
  if (!CJS) { console.log('FAIL set ROMCJS to a commonjs emit of src/rom'); return; }
  const { RomFile } = require(CJS + '/RomFile.js');
  const { loadMap16WithPipeVariants } = require(CJS + '/Map16.js');
  const { SmwRom } = require(CJS + '/SmwRom.js');
  const { parseLevelObjects } = require(CJS + '/LevelParser.js');
  const rom = RomFile.fromBytes(ROM, readFileSync(ROM));
  // The TILESET matters: Map16 page 0 is tileset-specific, so composing this
  // level's graphics with tileset 0's definitions produces real tiles in the
  // wrong places. Read the level's own header rather than assuming.
  const smw = new SmwRom(rom);
  const hdr = parseLevelObjects(smw.getLevelRawData(LEVEL)).header;
  console.log('level tileset: objectTileset=' + hdr.objectTileset + ' gfxTilesetId=' + smw.getGfxTilesetId(LEVEL));
  const { tiles } = loadMap16WithPipeVariants(rom, hdr.objectTileset);
  console.log('map16 tiles available: ' + tiles.length);

  // 4a. WHERE IS VRAM, REALLY?
  //
  //     The density test put it at wram_base+0x20000, but decoding tile $182
  //     there does not give the tile Mesen reports at that index, so settle it
  //     by identity instead of position.
  //
  //     SMW's level GFX files are 3BPP: 24 bytes per 8x8 tile, being planes 0
  //     and 1 interleaved (16 bytes) then plane 2 (8 bytes). VRAM holds them
  //     expanded to 4bpp, 32 bytes per tile, with plane 3 zeroed. So the whole
  //     file never appears verbatim, which is why a 64-byte search found
  //     nothing. What DOES survive unchanged is the first 16 bytes of each
  //     tile. Search for those, then require the NEXT tile's 16 bytes to sit
  //     exactly 32 bytes further on, which is the 4bpp stride. A coincidental
  //     16-byte match will not also satisfy the stride.
  {
    const { loadGfxRaw } = require(CJS + '/GfxLoader.js');
    for (const fileIndex of [0x00, 0x01, 0x0e, 0x14, 0x1c, 0x20]) {
      let raw;
      try { raw = loadGfxRaw(rom, fileIndex); } catch (e) { continue; }
      if (!raw || raw.length < 24 * 4) continue;
      // Pick a tile with plenty of non-zero bytes in planes 0/1.
      let tile = -1;
      for (let t = 0; t * 24 + 48 <= raw.length; t++) {
        let nz = 0; for (let k = 0; k < 16; k++) if (raw[t*24+k]) nz++;
        if (nz >= 12) { tile = t; break; }
      }
      if (tile < 0) { console.log('GFX $'+fileIndex.toString(16)+' no dense tile'); continue; }

      const needle = Array.from(raw.slice(tile*24, tile*24+16));
      const next   = Array.from(raw.slice((tile+1)*24, (tile+1)*24+16));
      const hits = findAll(M.HEAPU8, needle, 200);
      const confirmed = hits.filter(h => {
        for (let k = 0; k < 16; k++) if (M.HEAPU8[h + 32 + k] !== next[k]) return false;
        return true;
      });
      console.log('GFX $' + fileIndex.toString(16).padStart(2,'0')
        + ' tile#' + tile + ' raw_hits=' + hits.length + ' stride_confirmed=' + confirmed.length
        + (confirmed.length ? ' at ' + confirmed.slice(0,4).map(h =>
            '0x'+h.toString(16) + '(delta_wram=' + (h - base) + ')').join(' ') : ''));
    }
  }

  // 4b. Dump VRAM AS TILES, independent of Map16. Mesen's tile viewer shows the
  //     same thing, so this is directly comparable and isolates the question:
  //     if this sheet matches Mesen, VRAM and the 4bpp decode are correct and
  //     any remaining fault is in the Map16 definitions.
  //
  //     Mesen reports tile index $182 at tile address $1820.w. Word address
  //     times two is $3040, and $182 * 32 is also $3040, which confirms
  //     charNum * 32 from VRAM byte 0.
  {
    const TILES = 1024, TCOLS = 32, PAL = 2, S = 2;
    const w = TCOLS * 8, h = Math.ceil(TILES / TCOLS) * 8;
    const buf = Buffer.alloc(w * h * 4);
    for (let t = 0; t < TILES; t++) {
      blit(buf, w, (t % TCOLS) * 8, Math.floor(t / TCOLS) * 8,
           charPixels(vram, t, 0), cgram, PAL, false, false);
    }
    const W = w * S, H = h * S;
    const big = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const so = (Math.floor(y/S) * w + Math.floor(x/S)) * 4, d = (y * W + x) * 4;
      big[d]=buf[so]; big[d+1]=buf[so+1]; big[d+2]=buf[so+2]; big[d+3]=buf[so+3];
    }
    mkdirSync(OUT, { recursive: true });
    writePng(OUT + '/vram-tiles.png', W, H, big);
    console.log('wrote ' + OUT + '/vram-tiles.png  (1024 tiles, palette row ' + PAL + ')');

    // The specific tile Mesen identified, blown up, so it can be eyeballed.
    const one = Buffer.alloc(8 * 8 * 4);
    blit(one, 8, 0, 0, charPixels(vram, 0x182, 0), cgram, 2, false, false);
    const Z = 16, ow = 8 * Z;
    const zoom = Buffer.alloc(ow * ow * 4);
    for (let y = 0; y < ow; y++) for (let x = 0; x < ow; x++) {
      const so = (Math.floor(y/Z) * 8 + Math.floor(x/Z)) * 4, d = (y * ow + x) * 4;
      zoom[d]=one[so]; zoom[d+1]=one[so+1]; zoom[d+2]=one[so+2]; zoom[d+3]=one[so+3];
    }
    writePng(OUT + '/vram-tile-182.png', ow, ow, zoom);
    console.log('wrote ' + OUT + '/vram-tile-182.png  (should be the green ground top Mesen showed)');
  }

  // 5. Sweep candidate character bases. SNES BG char base is a 3-bit field
  //    selecting an 8KB step, so the plausible byte offsets are multiples of
  //    0x2000. Render the same Map16 page at each and let the eye pick.
  const COLS = 16, COUNT = Math.min(512, tiles.length), SCALE = 1;
  const ROWS = Math.ceil(COUNT / COLS);
  const smallW = COLS * 16, smallH = ROWS * 16;
  mkdirSync(OUT, { recursive: true });

  for (const cb of [0x0000]) {
    const small = Buffer.alloc(smallW * smallH * 4);
    for (let i = 0; i < COUNT; i++) {
      const t = tiles[i];
      if (!t) continue;
      const bx = (i % COLS) * 16, by = Math.floor(i / COLS) * 16;
      for (const [st, dx, dy] of [[t.tl,0,0],[t.tr,8,0],[t.bl,0,8],[t.br,8,8]]) {
        blit(small, smallW, bx+dx, by+dy, charPixels(vram, st.charNum, cb), cgram, st.palette, st.flipX, st.flipY);
      }
    }
    const W = smallW * SCALE, H = smallH * SCALE;
    const big = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const so = (Math.floor(y/SCALE) * smallW + Math.floor(x/SCALE)) * 4;
      const d = (y * W + x) * 4;
      big[d]=small[so]; big[d+1]=small[so+1]; big[d+2]=small[so+2]; big[d+3]=small[so+3];
    }
    let opaque = 0; for (let i = 3; i < big.length; i += 4) if (big[i]) opaque++;
    const out = OUT + '/map16-cb' + cb.toString(16).padStart(4,'0') + '.png';
    writePng(out, W, H, big);
    console.log('charBase 0x'+cb.toString(16).padStart(4,'0')+'  opaque='+opaque+'  '+out);
  }
}).catch(e=>{ console.log('ERR:',String(e).slice(0,400)); console.log(log.slice(-8).join(String.fromCharCode(10))); });
