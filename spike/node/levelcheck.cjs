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

// Does restoring a title savestate before driving GameMode change WHICH level
// loads? Layer1DataPtr ($65-$67, SMW_U.sym:9558) is what CODE_05D8B7 copies the
// resolved Layer1Ptrs entry into, so it names the level actually loaded.
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
  const gm=()=>H()[base+0x100];
  const l1ptr=()=>[0,1,2].map(k=>H()[base+0x65+k].toString(16).padStart(2,'0')).join(' ');

  // Expected pointers straight from the ROM, so we can name what loaded.
  const ptrOf=(lvl)=>{ const off=0x2E000+lvl*3; return [0,1,2].map(k=>rom[off+k].toString(16).padStart(2,'0')).join(' '); };
  console.log(`Layer1Ptrs[$105] = ${ptrOf(0x105)}   Layer1Ptrs[$005] = ${ptrOf(0x005)}`);

  let f=0; while(gm()!==0x07 && f<4000){ pump(M,5); f+=5; }
  const drive=(label)=>{
    const lo=LEVEL&0xFF;
    H()[base+0x0109]= lo<0x25?lo:lo+0x24;
    H()[base+0x1F11]=LEVEL>=0x100?1:0;
    H()[base+0x0100]=0x11;
    let n=0; while(n<900){ pump(M,5); n+=5; if(gm()===0x14) break; }
    console.log(`${label}: gm=0x${gm().toString(16)} Layer1DataPtr=${l1ptr()} submap=${H()[base+0x1F11]}`);
  };

  drive('NO state restore  ');

  // Capture a title state, restore it, and drive again -- the webview path.
  const info = M.cwrap('save_state_info','string',[])();
  const [size, ptr] = info.split('|').map(Number);
  console.log('save_state_info =>', JSON.stringify(info));
  const state = H().slice(ptr, ptr+size);
  FS.writeFile('/t.state', state);
  M.cwrap('load_state','number',['string','number'])('t.state', 0);
  pump(M,10);
  console.log(`after restore     : gm=0x${gm().toString(16)}`);
  drive('AFTER state restore');
}).catch(e=>{ console.log('ERR:',String(e).slice(0,250)); console.log(log.slice(-6).join('\n')); });
