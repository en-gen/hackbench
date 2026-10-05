// Can we reach the core's PPU memory (CGRAM / VRAM), the way we reached WRAM?
//
// READ_CORE_MEMORY answers "-1 no memory map defined" (spikes/libretro-view-engine/FINDINGS.md:685),
// so the only route is the heap. WRAM was found by PLANTING a pattern through
// the cheat API and searching for it by exact identity. CGRAM can be planted
// the same way, but through the GAME rather than the cheat API: SMW keeps its
// palette in WRAM at MainPalette $7E0703 (SMW_U.sym:9747) and DMAs it to CGRAM.
// Write a distinctive pattern there, let a frame run, and any copy of it
// OUTSIDE WRAM is the emulator's CGRAM.
const { readFileSync } = require('fs');
const P = 'vendor/cores/snes9x-wasm/';
const ROM = 'C:/Users/engenb/Super Mario World (USA).vanilla.sfc';

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

/** Every offset where `pat` occurs in the heap. */
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

factory({
  noInitialRun:true, arguments:[], preRun:[], postRun:[], canvas, callbacks:{}, parent:doc.body,
  print: m=>log.push('[out] '+m), printErr: m=>log.push('[err] '+m),
  wasmBinary: readFileSync(P+'snes9x_libretro.wasm'),
  getSavExt:()=>'.srm', getInputText:()=>'',
}).then(M => {
  const FS=M.FS; let c='';
  for(const p of '/home/web_user/.config/retroarch'.split('/').filter(Boolean)){ c+='/'+p; try{FS.mkdir(c);}catch(e){} }
  FS.writeFile('/home/web_user/.config/retroarch/retroarch.cfg',
    'screenshot_directory = "/"\nvideo_gpu_screenshot = false\naudio_enable = false\nvideo_driver = "null"\n');
  FS.writeFile('/rom.sfc', new Uint8Array(readFileSync(ROM)));
  M.callMain(['/rom.sfc']); M.resumeMainLoop();
  pump(M,400);

  // 1. WRAM, by the proven plant-and-find route.
  const setCheat = M.cwrap('set_cheat','null',['number','number','string']);
  const MAGIC=[0xA5,0x5A,0xC3,0x3C,0xDE,0xAD,0xBE,0xEF];
  MAGIC.forEach((v,i)=>setCheat(i,1,(0x7E1000+i).toString(16).toUpperCase().padStart(6,'0')+v.toString(16).toUpperCase().padStart(2,'0')));
  pump(M,60);
  MAGIC.forEach((_,i)=>setCheat(i,0,'000000'+'00'));

  const H0 = M.HEAPU8;
  const wramHits = findAll(H0, MAGIC, 4);
  if (!wramHits.length) { console.log('RESULT wram=NOT_FOUND'); return; }
  const base = wramHits[0] - 0x1000;
  console.log('RESULT wram_base=0x'+base.toString(16), 'heap='+(H0.length/1048576).toFixed(0)+'MB', 'wram_hits='+wramHits.length);

  // 2. Helpers for driving the game mode.
  const GAME_MODE=0x100, OW_OVERRIDE=0x109, OW_SUBMAP=0x1f11, KEEP_MODE=0xdb1;
  const gm = () => M.HEAPU8[base+GAME_MODE];
  function loadLevel(id) {
    const lo = id & 0xff;
    M.HEAPU8[base+OW_OVERRIDE] = lo < 0x25 ? lo : lo + 0x24;
    M.HEAPU8[base+OW_SUBMAP] = id >= 0x100 ? 1 : 0;
    M.HEAPU8[base+KEEP_MODE] = 0x02;
    M.HEAPU8[base+GAME_MODE] = 0x0f;
    let n = 0;
    while (gm() !== 0x14 && n < 1500) { pump(M,10); n += 10; }
    pump(M,40);
    return gm() === 0x14;
  }
  const palOf = () => Array.from(M.HEAPU8.slice(base+0x703, base+0x703+0x100));

  let spun = 0;
  while (gm() !== 0x07 && spun < 3000) { pump(M,10); spun += 10; }
  console.log('RESULT reached_title=' + (gm()===0x07));

  const A = 0x105, B = 0x00b;  // grass level vs a castle: palettes must differ
  console.log('RESULT loadA=' + loadLevel(A));
  const palA = palOf();
  const heapA = Buffer.from(M.HEAPU8);

  console.log('RESULT loadB=' + loadLevel(B));
  const palB = palOf();

  // 3. Find a window of MainPalette that ACTUALLY differs, so the search has a
  //    real discriminator rather than bytes shared by every level.
  let win = -1;
  for (let o = 0; o + 32 <= 0x100; o += 2) {
    let d = 0;
    for (let i = 0; i < 32; i++) if (palA[o+i] !== palB[o+i]) d++;
    if (d >= 8) { win = o; break; }
  }
  console.log('RESULT differing_palette_window=' + (win < 0 ? 'NONE' : '0x'+win.toString(16)));
  if (win < 0) { console.log('RESULT cgram=INCONCLUSIVE (palette did not change between levels)'); return; }

  const needle = palB.slice(win, win+32);
  const H = M.HEAPU8;
  const hits = findAll(H, needle, 16).filter(h => h < base || h >= base + 0x20000);
  console.log('RESULT cgram_hits_outside_wram=' + hits.length);
  for (const h of hits.slice(0,6)) console.log('  0x'+h.toString(16)+' delta_from_wram=' + (h-base));

  // 4. VRAM: long contiguous runs miss it, because two levels share many tiles
  //    (status bar, Mario, common blocks), so changes are scattered. Bucket the
  //    heap and rank by CHANGE DENSITY instead. VRAM should appear as a cluster
  //    of dense blocks about 64KB wide.
  const heapB = M.HEAPU8;
  const BLK = 4096;
  const blocks = [];
  for (let b = 0; b * BLK < heapA.length; b++) {
    const off = b * BLK;
    const end = Math.min(off + BLK, heapA.length);
    let changed = 0;
    for (let i = off; i < end; i++) if (heapA[i] !== heapB[i]) changed++;
    if (changed > 0) blocks.push([off, changed]);
  }
  blocks.sort((a,b)=>b[1]-a[1]);
  console.log('RESULT nonzero_blocks=' + blocks.length);
  for (const [off,n] of blocks.slice(0,14)) {
    const inWram = off >= base && off < base+0x20000;
    console.log('  0x'+off.toString(16)+' changed=' + n + '/4096'
      + ' delta_from_wram=' + (off-base) + (inWram ? ' [WRAM]' : ''));
  }

  // 5. Extent check. WRAM is 128KB, so if VRAM (64KB) sits immediately after
  //    it the change density should be non-zero from wram_base+0x20000 for
  //    0x10000 bytes and then stop. Print the shape rather than assume it.
  const vbase = base + 0x20000;
  console.log('RESULT hypothesised_vram_base=0x'+vbase.toString(16));
  let line = '';
  for (let b = -2; b < 20; b++) {
    const off = vbase + b * BLK;
    if (off < 0 || off >= heapA.length) continue;
    let changed = 0;
    for (let i = off; i < Math.min(off+BLK, heapA.length); i++) if (heapA[i] !== heapB[i]) changed++;
    line += (b === 0 ? ' |' : ' ') + String(changed).padStart(4);
    if (b === 15) line += ' |';
  }
  console.log('RESULT density_per_4k_from_vram_base-2 (| marks base and +64KB):' + line);
}).catch(e=>{ console.log('ERR:',String(e).slice(0,300)); console.log(log.slice(-6).join(String.fromCharCode(10))); });
