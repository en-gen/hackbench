// T14 Task A: measure the Map16 buffer layout empirically.
// Extends spike/node/fastload.cjs (GameMode polling, WRAM-by-identity) with:
//  - a fixed-address read of Map16TilesLow ($7E:C800) / Map16TilesHigh ($7F:C800),
//    the ASM-labelled buffer bases (rammap.asm:2114,2138), traced via
//    CODE_058074's fill loop -> CODE_0582C8/CODE_05833A (bank_05.asm:355-424).
//  - a read of the Map16LowPtr/Map16HighPtr POINTER VARIABLES ($7E006B/$7E006E)
//    for comparison, since FINDINGS.md observed these moving between loads.
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
  const gm=()=>H()[base+0x100];
  console.log('WRAM base 0x'+base.toString(16));

  let f=0; while(gm()!==0x07 && f<3000){ pump(M,5); f+=5; }

  const loadLevel = (level) => {
    const lo=level&0xFF; H()[base+0x0109]= lo<0x25?lo:lo+0x24;
    H()[base+0x1F11]=level>=0x100?1:0; H()[base+0x0100]=0x11;
    let n=0; while(n<600){ pump(M,5); n+=5; if(gm()===0x14) break; }
    return { ok: gm()===0x14, frames:n };
  };

  const r = loadLevel(LEVEL);
  console.log('load $'+LEVEL.toString(16), JSON.stringify(r));

  // Pointer variables (rammap.asm:553,558): 3-byte LoROM-style addr, bank/hi/lo order low->high.
  const readPtr = (addr) => {
    const p=[0,1,2].map(k=>H()[base+addr+k]);
    return ((p[2]<<16)|(p[1]<<8)|p[0])>>>0;
  };
  const lowPtr = readPtr(0x6B), highPtr = readPtr(0x6E);
  console.log('Map16LowPtr  = $'+lowPtr.toString(16).toUpperCase());
  console.log('Map16HighPtr = $'+highPtr.toString(16).toUpperCase());

  // WRAM-address -> heap-offset. Bank $7E -> base+addr&0xFFFF; bank $7F -> +0x10000.
  const toHeap = (snesAddr) => {
    const bank = snesAddr >>> 16;
    return base + (snesAddr & 0xFFFF) + (bank === 0x7f ? 0x10000 : 0);
  };
  const dump = (snesAddr, n) => Array.from({length:n},(_,k)=>H()[toHeap(snesAddr)+k]);

  // Candidate A: the ASM-labelled fixed base, traced via rammap.asm + CODE_0582C8/33A.
  const FIXED_LOW = 0x7EC800, FIXED_HIGH = 0x7FC800;
  console.log('\n-- Fixed Map16TilesLow  $7EC800, first 64 bytes --');
  console.log(dump(FIXED_LOW, 64).map(b=>b.toString(16).padStart(2,'0')).join(' '));
  console.log('-- Fixed Map16TilesHigh $7FC800, first 64 bytes --');
  console.log(dump(FIXED_HIGH, 64).map(b=>b.toString(16).padStart(2,'0')).join(' '));

  // Candidate B: whatever the pointer variables hold right now.
  console.log('\n-- [Map16LowPtr] first 64 bytes --');
  console.log(dump(lowPtr, 64).map(b=>b.toString(16).padStart(2,'0')).join(' '));
  console.log('-- [Map16HighPtr] first 64 bytes --');
  console.log(dump(highPtr, 64).map(b=>b.toString(16).padStart(2,'0')).join(' '));

  // Scan for the fill tile ($25 low / $00 high) boundary in the fixed region,
  // to see how far real (non-fill, non-zero) content extends -- i.e. does the
  // buffer span the WHOLE level, or a small window?
  const LOW_SPAN = dump(FIXED_LOW, 14336);
  let lastNonFill = -1;
  for (let i=0;i<LOW_SPAN.length;i++) if (LOW_SPAN[i] !== 0x25) lastNonFill = i;
  console.log('\nFixed-low span: 14336 bytes scanned, last non-$25 byte at offset', lastNonFill,
    lastNonFill>=0 ? '(screen '+Math.floor(lastNonFill/0x1B0)+')' : '(all fill)');
  let firstNonFill = LOW_SPAN.findIndex(b=>b!==0x25);
  console.log('first non-$25 byte at offset', firstNonFill);
}).catch(e=>{ console.log('ERR:',String(e).slice(0,500)); console.log(log.slice(-10).join('\n')); });
