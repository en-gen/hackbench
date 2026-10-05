// Build the Map16 palette page from a rendered sheet.
//
// The template carries no ROM data, so it is committed. The sheet it embeds is
// ROM-derived output, so the generated page is written into spikes/libretro-view-engine/**/evidence/
// which is gitignored. Run map16render.cjs first to produce the sheet.
//
//   node spikes/libretro-view-engine/node/map16render.cjs spikes/libretro-view-engine/t15/evidence 105
//   node spikes/libretro-view-engine/node/buildpalette.cjs spikes/libretro-view-engine/t15/evidence
const { readFileSync, writeFileSync } = require('fs');
const dir = process.argv[2] || 'spikes/libretro-view-engine/t15/evidence';
const sheet = process.argv[3] || 'map16-cb0000.png';
const tpl = readFileSync('spikes/libretro-view-engine/map16-palette.tpl.html', 'utf8');
const b64 = readFileSync(dir + '/' + sheet).toString('base64');
writeFileSync(dir + '/map16-palette.html', tpl.replace('__B64__', b64));
console.log('wrote ' + dir + '/map16-palette.html');
