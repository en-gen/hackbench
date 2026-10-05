// Sanity check for oracle_sweep.cjs's big mismatches: does the OverworldOverride
// mechanism actually load level $ID's data, or does it load something else via
// translevel indirection? Compares WRAM Layer1DataPtr ($7E0065, rammap.asm:533,
// "pointer to Layer 1 level data") against ROM's Layer1Ptrs[id] (bank_05.asm:7680,
// SNES $05E000 + id*3) after the override-driven load.
const { readFileSync } = require('fs');
const P = 'vendor/cores/snes9x-wasm/';
const ROM = 'C:/Users/engenb/Super Mario World (USA).vanilla.sfc';
const rom = new Uint8Array(readFileSync(ROM));

const glStub = () => new Proxy({}, { get: (t,k) => (typeof k==='string' && /^[A-Z][A-Z_0-9]*$/.test(k)) ? 1 : (() => 1) });
const canvas = { width:256, height:224, style:{}, addEventListener(){}, removeEventListener(){}, getContext(){ return glStub(); }, getBoundingClientRect(){ return {left:0,top:0,width:256,height:224}; } };
const evt = { addEventListener(){}, removeEventListener(){}, dispatchEvent(){return true;}, style:{} };
const doc = { body:evt, currentScript:{src:''}, getElementById:()=>canvas, createElement:()=>canvas, addEventListener(){}, removeEventListener(){}, querySelector:()=>canvas };
global.document = doc; global.addEventListener=()=>{}; global.removeEventListener=()=>{}; global.dispatchEvent=()=>true;
global.window = global; global.performance = global.performance || { now:()=>Date.now() };
global.requestAnimationFrame = cb => { global.__pending = cb; return 1; }; global.cancelAnimationFrame = () => {};
global.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
global.MutationObserver = global.MutationObserver || class { observe(){} disconnect(){} };
global.WebGLRenderingContext = class {}; global.WebGL2RenderingContext = class {};
global.navigator = global.navigator || { userAgent:'node', language:'en-US' };
global.location = global.location || { href:'http://localhost/', origin:'http://localhost' };

const factory = new Function(`${readFileSync(P+'snes9x_libretro.js','utf8')}; return EJS_Runtime;`)();
function pump(M,n){ let a=0; while(a<n){ if(typeof global.__pending!=='function'){ M.resumeMainLoop();
  if(typeof global.__pending!=='function') break; } const cb=global.__pending; global.__pending=null;
  cb(performance.now()); a++; } return a; }

// LoROM SNES -> file offset (addressing.ts loromToOffset semantics: bank&0x7F, *0x8000 + (addr&0x7FFF), minus 0 header on our headerless vanilla ROM)
const snesToFile = (snes) => (((snes>>>16)&0x7F) * 0x8000) + (snes & 0x7FFF);
const LAYER1_PTRS_SNES = 0x05E000;

factory({
  noInitialRun:true, arguments:[], preRun:[], postRun:[], canvas, callbacks:{}, parent:doc.body,
  print(){}, printErr(){}, wasmBinary: readFileSync(P+'snes9x_libretro.wasm'), getSavExt:()=>'.srm', getInputText:()=>'',
}).then(M => {
  const FS=M.FS; let c=''; for(const p of '/home/web_user/.config/retroarch'.split('/').filter(Boolean)){ c+='/'+p; try{FS.mkdir(c);}catch(e){} }
  FS.writeFile('/home/web_user/.config/retroarch/retroarch.cfg', 'screenshot_directory = "/"\nvideo_gpu_screenshot = false\naudio_enable = false\nvideo_driver = "null"\n');
  FS.writeFile('/rom.sfc', rom); M.callMain(['/rom.sfc']); M.resumeMainLoop();

  const H=()=>M.HEAPU8;
  const setCheat=M.cwrap('set_cheat','null',['number','number','string']);
  const MAGIC=[0xA5,0x5A,0xC3,0x3C,0xDE,0xAD,0xBE,0xEF];
  MAGIC.forEach((v,i)=>setCheat(i,1,(0x7E1000+i).toString(16).toUpperCase().padStart(6,'0')+v.toString(16).toUpperCase().padStart(2,'0')));
  pump(M,120);
  let base=-1;
  outer: for(let i=0;i<H().length-8;i++){ if(H()[i]!==MAGIC[0]) continue;
    for(let j=1;j<8;j++) if(H()[i+j]!==MAGIC[j]) continue outer; base=i-0x1000; break; }
  MAGIC.forEach((_,i)=>setCheat(i,0,'7E100000'));
  const gm=()=>H()[base+0x100];
  let f=0; while(gm()!==0x07 && f<3000){ pump(M,5); f+=5; }

  const loadLevel = (level) => {
    const lo=level&0xFF; H()[base+0x0109]= lo<0x25?lo:lo+0x24;
    H()[base+0x1F11]=level>=0x100?1:0; H()[base+0x0100]=0x11;
    let n=0; while(n<600){ pump(M,5); n+=5; if(gm()===0x14) break; }
    return { ok: gm()===0x14, frames:n };
  };

  const IDS = [0x105, 0x1, 0x4, 0x7, 0xb, 0xe, 0x13];
  for (const id of IDS) {
    const r = loadLevel(id);
    // Layer1DataPtr $7E0065, 3 bytes, bank/hi/lo? read as written: lo,hi,bank (STA Layer1DataPtr; STA+1; STA+2 in bank_05.asm:7235-7239 order low,mid,bank)
    const p0=H()[base+0x65], p1=H()[base+0x66], p2=H()[base+0x67];
    const gameSnes = ((p2<<16)|(p1<<8)|p0)>>>0;

    const romPtrOff = snesToFile(LAYER1_PTRS_SNES) + id*3;
    const e0=rom[romPtrOff], e1=rom[romPtrOff+1], e2=rom[romPtrOff+2];
    const expectSnes = ((e2<<16)|(e1<<8)|e0)>>>0;

    // STABLE post-load header fields (not moving cursors): LevelModeSetting
    // $0018D9 (mirrored bank-00 fast RAM -> heap base+0x18D9) and LevelScrLength
    // $7E005D. Compare against the ROM's own 5-byte L1 header for `id`.
    const wramMode = H()[base+0x18D9];
    const wramScr  = H()[base+0x5D];
    const hdrOff = expectSnes >= 0 ? snesToFile(expectSnes) : -1; // header lives at Layer1Ptrs[id] target
    // header byte0: bits0-4=screens-1, byte1 bits5-6=ScreenMode(has mode's vertical bits)... use ROM's OWN table for id instead:
    const idHdrOff = snesToFile((rom[romPtrOff+2]<<16)|(rom[romPtrOff+1]<<8)|rom[romPtrOff]);
    const hdrByte0 = rom[idHdrOff], hdrByte1 = rom[idHdrOff+1];
    const romScreens = (hdrByte0 & 0x1F) + 1;
    const romMode = hdrByte1 & 0x1F;

    console.log(`$${id.toString(16)} load.ok=${r.ok} frames=${r.frames}  ` +
      `Layer1DataPtr(WRAM)=$${gameSnes.toString(16).toUpperCase()}  Layer1Ptrs[id](ROM)=$${expectSnes.toString(16).toUpperCase()}  ` +
      `ptrMATCH=${gameSnes===expectSnes}  ` +
      `mode WRAM=${wramMode} ROM=${romMode} MATCH=${wramMode===romMode}  ` +
      `screens WRAM=${wramScr} ROM=${romScreens} MATCH=${wramScr===romScreens}`);
  }
}).catch(e=>{ console.log('ERR:', e && e.stack || e); });
