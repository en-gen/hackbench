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

// Headless Node harness. No browser, no canvas, no VS Code, no port contention.
// WRAM is located by PLANTING a known pattern via set_cheat (which writes to SNES
// bus addresses) and finding it in the heap by exact search. That is identity,
// not the behavioural scanning that failed across ~1700 candidates earlier.
factory({
  noInitialRun:true, arguments:[], preRun:[], postRun:[], canvas, callbacks:{}, parent:doc.body,
  print: m=>log.push('[out] '+m), printErr: m=>log.push('[err] '+m),
  wasmBinary: readFileSync(P+'snes9x_libretro.wasm'),
  getSavExt:()=>'.srm', getInputText:()=>'',
}).then(M => {
  const FS=M.FS; let c=''; for(const p of '/home/web_user/.config/retroarch'.split('/').filter(Boolean)){ c+='/'+p; try{FS.mkdir(c);}catch(e){} }
  FS.writeFile('/home/web_user/.config/retroarch/retroarch.cfg',
    'screenshot_directory = "/"\nvideo_gpu_screenshot = false\naudio_enable = false\nvideo_driver = "null"\n');
  FS.writeFile('/rom.sfc', new Uint8Array(readFileSync(ROM)));
  M.callMain(['/rom.sfc']); M.resumeMainLoop();
  pump(M,400);

  const setCheat = M.cwrap('set_cheat','null',['number','number','string']);
  const MAGIC=[0xA5,0x5A,0xC3,0x3C,0xDE,0xAD,0xBE,0xEF];
  MAGIC.forEach((v,i)=>setCheat(i,1,(0x7E1000+i).toString(16).toUpperCase().padStart(6,'0')+v.toString(16).toUpperCase().padStart(2,'0')));
  pump(M,60);

  const H=()=>M.HEAPU8;
  let base=-1;
  outer: for(let i=0;i<H().length-8;i++){ if(H()[i]!==MAGIC[0]) continue;
    for(let j=1;j<8;j++) if(H()[i+j]!==MAGIC[j]) continue outer; base=i-0x1000; break; }
  if(base<0){ console.log('WRAM NOT FOUND'); return; }
  const rd=(a,n=1)=>Array.from({length:n},(_,k)=>H()[base+a+k]);
  console.log('WRAM base: 0x'+base.toString(16));

  // Validation 1: GameMode should be a documented value (rammap.asm:977-1010).
  console.log('GameMode $7E0100 =', rd(0x100)[0]);

  // Validation 2: TrueFrame ($7E0013, rammap.asm:48-53) is an 8-bit counter that
  // increments once per executed frame. Check it advances mod 256, which is the
  // check an earlier agent got wrong by comparing against raw elapsed frames.
  const t0=rd(0x13)[0], e0=rd(0x14)[0];
  pump(M,60);
  const t1=rd(0x13)[0], e1=rd(0x14)[0];
  console.log(`TrueFrame $7E0013: ${t0} -> ${t1}  delta(mod256)=${(t1-t0+256)%256} (expect ~60)`);
  console.log(`EffFrame  $7E0014: ${e0} -> ${e1}  delta(mod256)=${(e1-e0+256)%256}`);

  const p=rd(0x6B,3);
  console.log('Map16LowPtr $7E006B = $'+((p[2]<<16)|(p[1]<<8)|p[0]).toString(16).toUpperCase());
}).catch(e=>{ console.log('ERR:',String(e).slice(0,250)); console.log(log.slice(-6).join('\n')); });
