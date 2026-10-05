// Which CGRAM entries does the running game animate, and how fast?
//
// Palette animation is usually reconstructed from ROM tables. Reading CGRAM
// out of the running core measures it instead, which also means it holds for
// a romhack that animates something else. Sampling every frame for a few
// seconds shows which of the 256 entries move and on what period.
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

  // 4. Sample CGRAM every frame and see what moves.
  const FRAMES = 240;
  const cgOff = cgHits[0];
  const samples = [];
  for(let f = 0; f < FRAMES; f++){
    samples.push(Buffer.from(M.HEAPU8.slice(cgOff, cgOff + 512)));
    pump(M, 1);
  }

  const changedAt = new Map();      // colour index -> frames on which it changed
  for(let f = 1; f < FRAMES; f++){
    for(let i = 0; i < 256; i++){
      const a = samples[f-1].readUInt16LE(i*2), b = samples[f].readUInt16LE(i*2);
      if(a !== b){
        if(!changedAt.has(i)) changedAt.set(i, []);
        changedAt.get(i).push(f);
      }
    }
  }

  console.log('animated colour entries: ' + changedAt.size + ' of 256');
  for(const [i, frames] of [...changedAt.entries()].sort((a,b)=>a[0]-b[0])){
    const gaps = frames.slice(1).map((f,k) => f - frames[k]);
    const period = gaps.length ? [...new Set(gaps)].sort((a,b)=>a-b).join('/') : 'once';
    const row = i >> 4, col = i & 15;
    const values = [...new Set(frames.map(f => samples[f].readUInt16LE(i*2)))];
    console.log('  index ' + i + ' ($' + i.toString(16).padStart(2,'0') + ')'
      + '  row ' + row + ' col ' + col
      + '  changes=' + frames.length + '  period=' + period + ' frames'
      + '  distinct_values=' + values.length);
  }
  if(changedAt.size === 0) console.log('  none: this level animates no palette entries');
}).catch(e=>{ console.log('ERR:',String(e).slice(0,300)); console.log(log.slice(-6).join(String.fromCharCode(10))); });
