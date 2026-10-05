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

// Load a specific level, waiting on GameMode rather than guessing a frame count,
// then read the game's own expanded Map16 grid back out of WRAM.
const LEVEL = 0x105;
factory({
  noInitialRun:true, arguments:[], preRun:[], postRun:[], canvas, callbacks:{}, parent:doc.body,
  print: m=>log.push('[out] '+m), printErr: m=>log.push('[err] '+m),
  wasmBinary: readFileSync(P+'snes9x_libretro.wasm'),
  getSavExt:()=>'.srm', getInputText:()=>'',
}).then(M => {
  const FS=M.FS; let c=''; for(const p of '/home/web_user/.config/retroarch'.split('/').filter(Boolean)){ c+='/'+p; try{FS.mkdir(c);}catch(e){} }
  FS.writeFile('/home/web_user/.config/retroarch/retroarch.cfg',
    'screenshot_directory = "/"\nvideo_gpu_screenshot = false\naudio_enable = false\nvideo_driver = "null"\n');
  const rom = new Uint8Array(readFileSync(ROM));
  FS.writeFile('/rom.sfc', rom);
  M.callMain(['/rom.sfc']); M.resumeMainLoop();
  pump(M,120);

  const H=()=>M.HEAPU8;
  // Locate the ROM by exact full-length compare (identity, per T8).
  let romOff=-1;
  const sig=rom.subarray(0,64);
  outer2: for(let i=0;i<H().length-rom.length;i++){ if(H()[i]!==sig[0]) continue;
    for(let j=1;j<64;j++) if(H()[i+j]!==sig[j]) continue outer2; romOff=i; break; }
  console.log('ROM at 0x'+romOff.toString(16));

  // Force-load LEVEL: encodeOverride per hackbench-validation capture/mesen/headless_capture.lua.
  const lo=LEVEL&0xFF, submap=LEVEL>=0x100?1:0;
  const ov = lo<0x25 ? lo : lo+0x24;
  H()[romOff+0x16CC]=ov; H()[romOff+0x16CE]=submap;
  console.log(`patched override=0x${ov.toString(16)} submap=${submap}`);

  // Plant the WRAM signature.
  const setCheat=M.cwrap('set_cheat','null',['number','number','string']);
  const MAGIC=[0xA5,0x5A,0xC3,0x3C,0xDE,0xAD,0xBE,0xEF];
  MAGIC.forEach((v,i)=>setCheat(i,1,(0x7E1000+i).toString(16).toUpperCase().padStart(6,'0')+v.toString(16).toUpperCase().padStart(2,'0')));
  pump(M,60);
  let base=-1;
  outer3: for(let i=0;i<H().length-8;i++){ if(H()[i]!==MAGIC[0]) continue;
    for(let j=1;j<8;j++) if(H()[i+j]!==MAGIC[j]) continue outer3; base=i-0x1000; break; }
  const rd=(a,n=1)=>Array.from({length:n},(_,k)=>H()[base+a+k]);
  console.log('WRAM base 0x'+base.toString(16));

  // POLL GameMode instead of guessing a frame number. This is the capability
  // whose absence produced five false negatives across five agents.
  const seen=[]; let gm=-1, frames=0;
  for(let i=0;i<600;i++){ pump(M,5); frames+=5; const g=rd(0x100)[0];
    if(g!==gm){ gm=g; seen.push(`f${frames}:gm=0x${g.toString(16)}`); }
    if(g===0x14) break; }
  console.log('GameMode transitions:', seen.join(' -> '));
  console.log('reached GameMode_Level(0x14):', gm===0x14, 'after', frames, 'frames');

  const p=rd(0x6B,3), ptr=(p[2]<<16)|(p[1]<<8)|p[0];
  console.log('Map16LowPtr = $'+ptr.toString(16).toUpperCase());
  if((ptr>>>16)===0x7e||(ptr>>>16)===0x7f){
    const off=(ptr&0xFFFF)+((ptr>>>16)===0x7f?0x10000:0);
    console.log('first 32 Map16 bytes:', Array.from({length:32},(_,k)=>H()[base+off+k].toString(16).padStart(2,'0')).join(' '));
  }
}).catch(e=>{ console.log('ERR:',String(e).slice(0,250)); console.log(log.slice(-6).join('\n')); });
