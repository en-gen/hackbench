// T14 Task B: the oracle. Compares the cart's own expanded Map16 grid (read
// from WRAM after the ROM's own level loader runs) against HackBench's
// ObjectExpander/MapBuilder output, for every real+reachable level.
//
// Buffer layout (measured in probe_layout.cjs, see spikes/libretro-view-engine/t14/REPORT.md):
//   Map16TilesLow  = SNES $7E:C800 (bank $7E, rammap.asm:2114) -- low byte of
//     each Map16 tile id, one array covering the WHOLE level (up to 32
//     horizontal screens * $1B0, or vertical screens * $200), screen-major.
//   Map16TilesHigh = SNES $7F:C800 (bank $7F, rammap.asm:2138) -- high byte
//     (bit 8) of the same tile id, same layout, same size (14336 bytes each).
//   Map16LowPtr/Map16HighPtr ($7E006B/$7E006E) are NOT the buffer base -- they
//     are per-object scratch pointers left at whatever page the LAST object
//     touched. Confirmed empirically: after loading $105, Map16LowPtr read
//     $7EFC50 = Map16TilesLow + $3450, the last entry of the $1B0-stride
//     page table (bank_00.asm DATA_00BAD8), not the start of the level.
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');
const P = 'vendor/cores/snes9x-wasm/';
const ROM = 'C:/Users/engenb/Super Mario World (USA).vanilla.sfc';
const DIST = process.env.T14_DIST; // compiled src/rom -> CommonJS (tsc), see spikes/libretro-view-engine/t14/README.

const { SmwRom } = require(path.join(DIST, 'SmwRom.js'));
const { RomFile } = require(path.join(DIST, 'RomFile.js'));
const { buildLevelCatalog } = require(path.join(DIST, 'LevelCatalog.js'));
const { parseLevelHeader, isLevelModeVertical, SCREEN_W, SCREEN_H, SCREEN_W_VERT, SCREEN_H_VERT } = require(path.join(DIST, 'LevelParser.js'));
const { buildMapWithGraph, TILE_EMPTY: _unused } = require(path.join(DIST, 'model/MapBuilder.js'));
const { TILE_EMPTY, readLayer3Setting } = require(path.join(DIST, 'ObjectExpander.js'));

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
function pump(M,n){ let a=0; while(a<n){ if(typeof global.__pending!=='function'){ M.resumeMainLoop();
  if(typeof global.__pending!=='function') break; } const cb=global.__pending; global.__pending=null;
  cb(performance.now()); a++; } return a; }

const romFile = new RomFile(ROM, readFileSync(ROM));
const rom = new SmwRom(romFile);
const cat = buildLevelCatalog(rom);
const inReachable = (i) => (i>=0x001 && i<=0x0DB) || (i>=0x101 && i<=0x1DB);
let targets = cat.entries.filter(e => e.isReal && e.parseable && inReachable(e.index)).map(e => e.index);
if (process.env.T14_LIMIT) targets = targets.slice(0, Number(process.env.T14_LIMIT));

const MAP16_LOW = 0x7EC800, MAP16_HIGH = 0x7FC800, BUF_SIZE = 14336;
const STRIDE_H = SCREEN_W * SCREEN_H;       // 0x1B0
const STRIDE_V = SCREEN_W_VERT * SCREEN_H_VERT; // 0x200

factory({
  noInitialRun:true, arguments:[], preRun:[], postRun:[], canvas, callbacks:{}, parent:doc.body,
  print(){}, printErr(){},
  wasmBinary: readFileSync(P+'snes9x_libretro.wasm'),
  getSavExt:()=>'.srm', getInputText:()=>'',
}).then(M => {
  const FS=M.FS; let c=''; for(const p of '/home/web_user/.config/retroarch'.split('/').filter(Boolean)){ c+='/'+p; try{FS.mkdir(c);}catch(e){} }
  FS.writeFile('/home/web_user/.config/retroarch/retroarch.cfg',
    'screenshot_directory = "/"\nvideo_gpu_screenshot = false\naudio_enable = false\nvideo_driver = "null"\n');
  FS.writeFile('/rom.sfc', new Uint8Array(readFileSync(ROM)));
  M.callMain(['/rom.sfc']); M.resumeMainLoop();

  const H=()=>M.HEAPU8;
  const setCheat=M.cwrap('set_cheat','null',['number','number','string']);
  const MAGIC=[0xA5,0x5A,0xC3,0x3C,0xDE,0xAD,0xBE,0xEF];
  MAGIC.forEach((v,i)=>setCheat(i,1,(0x7E1000+i).toString(16).toUpperCase().padStart(6,'0')+v.toString(16).toUpperCase().padStart(2,'0')));
  pump(M,120);
  let base=-1;
  outer: for(let i=0;i<H().length-8;i++){ if(H()[i]!==MAGIC[0]) continue;
    for(let j=1;j<8;j++) if(H()[i+j]!==MAGIC[j]) continue outer; base=i-0x1000; break; }
  MAGIC.forEach((_,i)=>setCheat(i,0,'7E100000'));
  if (base<0) { console.log('WRAM NOT FOUND'); return; }
  const gm=()=>H()[base+0x100];
  let f=0; while(gm()!==0x07 && f<3000){ pump(M,5); f+=5; }
  console.log('WRAM base 0x'+base.toString(16), 'title screen at frame', f);

  const loadLevel = (level) => {
    const lo=level&0xFF; H()[base+0x0109]= lo<0x25?lo:lo+0x24;
    H()[base+0x1F11]=level>=0x100?1:0; H()[base+0x0100]=0x11;
    let n=0; while(n<600){ pump(M,5); n+=5; if(gm()===0x14) break; }
    return { ok: gm()===0x14, frames:n };
  };
  // Identity gate: OverworldOverride force-load is NOT verified to reach every
  // id (see spikes/libretro-view-engine/t14/verify_identity.cjs) -- 5/7 spot-checked ids loaded a
  // 1-screen mode-0 level instead of their real header. Confirm via two STABLE
  // post-load fields (not moving cursors): LevelModeSetting $0018D9 and
  // LevelScrLength $7E005D, against the ROM's own 5-byte L1 header for `id`.
  const verifyIdentity = (id, rh) => {
    const wramMode = H()[base+0x18D9], wramScr = H()[base+0x5D];
    return wramMode === rh.levelMode && wramScr === rh.levelLength;
  };
  const dump = (snesAddr, n) => {
    const bank = snesAddr>>>16, off = base + (snesAddr&0xFFFF) + (bank===0x7f?0x10000:0);
    const a = new Array(n);
    for (let k=0;k<n;k++) a[k]=H()[off+k];
    return a;
  };

  const results = [];
  for (const id of targets) {
    const raw = rom.getLevelRawData(id);
    const rh = parseLevelHeader(raw);
    const isVert = isLevelModeVertical(rh.levelMode);
    const isBoss = rh.levelMode === 9 || rh.levelMode === 11;
    const screens = isBoss ? 2 : rh.levelLength;
    const stride = isVert ? STRIDE_V : STRIDE_H;
    const needed = screens * stride;

    const r = loadLevel(id);
    if (!r.ok) { results.push({ id, error: 'load-timeout', frames: r.frames }); continue; }
    if (needed > BUF_SIZE) { results.push({ id, error: 'needed-exceeds-buffer', needed }); continue; }
    if (!verifyIdentity(id, rh)) { results.push({ id, error: 'wrong-level-loaded', mode: rh.levelMode, screens: rh.levelLength }); process.stdout.write('?'); continue; }

    const low = dump(MAP16_LOW, needed), high = dump(MAP16_HIGH, needed);

    const { map } = buildMapWithGraph(rom, id);
    const l3 = readLayer3Setting(rom.rom, id);

    let diffs = 0, examples = [];
    for (let s = 0; s < screens; s++) {
      const rows = isVert ? SCREEN_H_VERT : SCREEN_H;
      const cols = isVert ? SCREEN_W_VERT : SCREEN_W;
      for (let r2 = 0; r2 < rows; r2++) {
        for (let c2 = 0; c2 < cols; c2++) {
          const off = s*stride + r2*cols + c2;
          const cartId = low[off] | (high[off] << 8);
          const gridRow = isVert ? s*SCREEN_H_VERT + r2 : r2;
          const gridCol = isVert ? c2 : s*SCREEN_W + c2;
          const hbCell = map.l1[gridRow] ? map.l1[gridRow][gridCol] : undefined;
          const hbId = (hbCell === null || hbCell === undefined) ? TILE_EMPTY : hbCell;
          if (cartId !== hbId) {
            diffs++;
            if (examples.length < 5) examples.push({ screen: s, row: r2, col: c2, cart: cartId.toString(16), hb: hbId.toString(16) });
          }
        }
      }
    }
    results.push({ id, mode: rh.levelMode, vert: isVert, screens, layer3Setting: l3, total: needed, diffs, examples });
    process.stdout.write(diffs === 0 ? '.' : 'X');
  }
  console.log('');

  const ok = results.filter(r => !r.error && r.diffs === 0);
  const bad = results.filter(r => !r.error && r.diffs > 0);
  const wrongLevel = results.filter(r => r.error === 'wrong-level-loaded');
  const otherErr = results.filter(r => r.error && r.error !== 'wrong-level-loaded');
  console.log(`\nSwept ${results.length} levels: ${ok.length} identical, ${bad.length} differ, ` +
    `${wrongLevel.length} excluded (override loaded the wrong level -- see verify_identity.cjs), ${otherErr.length} other errors.`);
  console.log('Other errors:', JSON.stringify(otherErr));
  console.log('Wrong-level-loaded ids:', wrongLevel.map(r=>'$'+r.id.toString(16)).join(' '));
  console.log('Mismatches (first 20):');
  for (const r of bad.slice(0,20)) {
    console.log(`  $${r.id.toString(16)} mode=${r.mode} vert=${r.vert} l3=${r.layer3Setting} diffs=${r.diffs}/${r.total}`, JSON.stringify(r.examples));
  }
  writeFileSync(path.join(__dirname, 'sweep_results.json'), JSON.stringify(results, null, 1));
  console.log('\nWrote spikes/libretro-view-engine/t14/sweep_results.json');
}).catch(e=>{ console.log('ERR:', e && e.stack || e); });
