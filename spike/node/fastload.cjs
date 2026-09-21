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

// Once the WRAM base is known, WRAM is directly writable through the heap.
// Cheats were only ever needed to locate it. So we can drive SMW's own game-mode
// state machine and skip the attract-mode demo entirely.
const LEVEL = 0x105;
const t0 = Date.now();
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

  const H=()=>M.HEAPU8;
  const setCheat=M.cwrap('set_cheat','null',['number','number','string']);
  const MAGIC=[0xA5,0x5A,0xC3,0x3C,0xDE,0xAD,0xBE,0xEF];
  MAGIC.forEach((v,i)=>setCheat(i,1,(0x7E1000+i).toString(16).toUpperCase().padStart(6,'0')+v.toString(16).toUpperCase().padStart(2,'0')));
  pump(M,120);
  let base=-1;
  o1: for(let i=0;i<H().length-8;i++){ if(H()[i]!==MAGIC[0]) continue;
    for(let j=1;j<8;j++) if(H()[i+j]!==MAGIC[j]) continue o1; base=i-0x1000; break; }
  MAGIC.forEach((_,i)=>setCheat(i,0,'7E100000'));   // disable; they re-apply every frame
  const gm=()=>H()[base+0x100];
  console.log('WRAM base 0x'+base.toString(16), 'boot ms', Date.now()-t0);

  // Wait for the title screen, which is where the ROM's own code is known to be
  // ready to force-load a level (bank_00.asm:2613-2632).
  let f=0; while(gm()!==0x07 && f<3000){ pump(M,5); f+=5; }
  console.log('GameMode 0x07 at frame', f);

  // Drive the state machine directly. OverworldOverride $7E0109 (rammap.asm:1033),
  // OWPlayerSubmap $7E1F11 (SMW_U.sym:10966), GameMode $7E0100 (rammap.asm:977).
  const t1 = Date.now();
  const lo=LEVEL&0xFF, ov = lo<0x25 ? lo : lo+0x24;
  H()[base+0x0109]=ov;
  H()[base+0x1F11]=LEVEL>=0x100?1:0;
  H()[base+0x0100]=0x11;                 // !GameMode_LoadLevel
  let f2=0; const seen=[]; let last=-1;
  while(f2<1200){ pump(M,5); f2+=5; const g=gm();
    if(g!==last){ last=g; seen.push(`f${f2}:0x${g.toString(16)}`); }
    if(g===0x14) break; }
  console.log('transitions:', seen.join(' -> '));
  console.log('reached Level(0x14):', gm()===0x14, 'in', f2, 'frames,', Date.now()-t1, 'ms');
  const p=[0,1,2].map(k=>H()[base+0x6B+k]);
  console.log('Map16LowPtr = $'+(((p[2]<<16)|(p[1]<<8)|p[0])>>>0).toString(16).toUpperCase());
}).catch(e=>{ console.log('ERR:',String(e).slice(0,250)); console.log(log.slice(-6).join('\n')); });
