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

// THE EDIT LOOP. Patch ROM level data, re-trigger SMW's own level loader by
// writing GameMode, and read the game's own re-expanded Map16 grid back out.
// No pixels involved: this compares the data HackBench would render.
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
  FS.writeFile('/rom.sfc', rom); M.callMain(['/rom.sfc']); M.resumeMainLoop();

  const H=()=>M.HEAPU8;
  const setCheat=M.cwrap('set_cheat','null',['number','number','string']);
  const MAGIC=[0xA5,0x5A,0xC3,0x3C,0xDE,0xAD,0xBE,0xEF];
  MAGIC.forEach((v,i)=>setCheat(i,1,(0x7E1000+i).toString(16).toUpperCase().padStart(6,'0')+v.toString(16).toUpperCase().padStart(2,'0')));
  pump(M,120);
  let base=-1;
  o1: for(let i=0;i<H().length-8;i++){ if(H()[i]!==MAGIC[0]) continue;
    for(let j=1;j<8;j++) if(H()[i+j]!==MAGIC[j]) continue o1; base=i-0x1000; break; }
  MAGIC.forEach((_,i)=>setCheat(i,0,'7E100000'));
  let romOff=-1; const sig=rom.subarray(0,64);
  o2: for(let i=0;i<H().length-rom.length;i++){ if(H()[i]!==sig[0]) continue;
    for(let j=1;j<64;j++) if(H()[i+j]!==sig[j]) continue o2; romOff=i; break; }
  const gm=()=>H()[base+0x100];
  let f=0; while(gm()!==0x07 && f<3000){ pump(M,5); f+=5; }

  const loadLevel = () => {
    const t=Date.now();
    const lo=LEVEL&0xFF; H()[base+0x0109]= lo<0x25?lo:lo+0x24;
    H()[base+0x1F11]=LEVEL>=0x100?1:0; H()[base+0x0100]=0x11;
    let n=0; while(n<600){ pump(M,5); n+=5; if(gm()===0x14) break; }
    return { ok: gm()===0x14, frames:n, ms:Date.now()-t };
  };
  const readMap16 = (n=256) => {
    const p=[0,1,2].map(k=>H()[base+0x6B+k]);
    const ptr=((p[2]<<16)|(p[1]<<8)|p[0])>>>0, bank=ptr>>>16;
    const off=(ptr&0xFFFF)+(bank===0x7f?0x10000:0);
    return { ptr, bytes: Array.from({length:n},(_,k)=>H()[base+off+k]) };
  };

  const r1=loadLevel(); const m1=readMap16();
  console.log('load #1', JSON.stringify(r1), 'Map16LowPtr=$'+m1.ptr.toString(16).toUpperCase());

  // Patch: truncate the Layer-1 object stream. Layer1Ptrs[$105] at file 0x2E30F
  // -> SNES $0688DD -> file 0x308DD; header is 5 bytes (LevelParser.ts:132).
  const before = H()[romOff+0x308E2];
  H()[romOff+0x308E2] = 0xFF;
  console.log(`patched ROM 0x308E2: 0x${before.toString(16)} -> 0xFF`);

  const r2=loadLevel(); const m2=readMap16();
  console.log('load #2', JSON.stringify(r2), 'Map16LowPtr=$'+m2.ptr.toString(16).toUpperCase());

  let diff=0; for(let i=0;i<m1.bytes.length;i++) if(m1.bytes[i]!==m2.bytes[i]) diff++;
  console.log(`Map16 bytes differing: ${diff}/${m1.bytes.length}`);
  console.log('before:', m1.bytes.slice(0,24).map(b=>b.toString(16).padStart(2,'0')).join(' '));
  console.log('after :', m2.bytes.slice(0,24).map(b=>b.toString(16).padStart(2,'0')).join(' '));
}).catch(e=>{ console.log('ERR:',String(e).slice(0,250)); console.log(log.slice(-6).join('\n')); });
