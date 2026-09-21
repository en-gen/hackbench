// T0 capability probe harness. Disposable. Calling convention (config keys,
// callMain/resumeMainLoop sequence, cmd_take_screenshot -> /screenshot.png)
// reverse-derived from EmulatorJS data/src/{emulator,GameManager}.js
// (GameManager.js:41 writes the retroarch.cfg below; :226 is the screenshot
// poll loop we mirror). GameMode address ($7E0100) is rammap.asm:980.

const T0 = (window.T0 = { log: [], Module: null });

// Push evidence bytes to serve.py's /save route instead of round-tripping
// base64 through chat (that silently truncated a blob once already).
T0.save = async (name, bytes) => {
  const r = await fetch("/save?name=" + encodeURIComponent(name), { method: "POST", body: bytes });
  return { ok: r.ok, status: r.status };
};

// The Browser pane's tab is not actually composited (occluded/backgrounded),
// so real requestAnimationFrame gets throttled to near-zero after an initial
// handful of calls, and so does setTimeout-based pacing -- confirmed by
// direct experiment (native rAF: 7 calls then permanently stalled, no matter
// how long we waited). Fix: replace window.requestAnimationFrame with a
// capture-only stub, then manually invoke the captured callback in a tight
// synchronous loop. Emscripten's MainLoop scheduler (mode 1, rAF-driven --
// see MainLoop_scheduler_rAF in the vendored glue) re-arms itself by calling
// requestAnimationFrame(MainLoop.runner) at the end of every iteration, so
// each manual invocation steps exactly one emulated frame. The RetroArch/
// EmulatorJS loop also spontaneously drops its own scheduling (observed:
// stops re-arming after a handful of iterations, unrelated to visibility --
// same behavior appeared before AND after the rAF patch), so pumpFrames()
// force-rearms via resumeMainLoop() whenever the pending slot goes empty.
window.requestAnimationFrame = (cb) => { window.__t0pending = cb; };

T0.pumpFrames = (n) => {
  let advanced = 0, rearms = 0;
  while (advanced < n) {
    if (typeof window.__t0pending !== "function") {
      T0.Module.resumeMainLoop();
      rearms++;
      if (typeof window.__t0pending !== "function") break; // truly stuck
    }
    const cb = window.__t0pending;
    window.__t0pending = null;
    cb(performance.now());
    advanced++;
  }
  return { advanced, rearms };
};

function mkdirp(FS, path) {
  let cur = "";
  for (const p of path.split("/").filter(Boolean)) {
    cur += "/" + p;
    try { FS.mkdir(cur); } catch (e) {}
  }
}

const RA_CFG = 'screenshot_directory = "/"\nvideo_gpu_screenshot = false\naudio_enable = false\n';

T0.boot = async function (romUrl) {
  const canvas = document.getElementById("canvas");
  const Module = await window.EJS_Runtime({
    noInitialRun: true,
    arguments: [],
    preRun: [],
    postRun: [],
    canvas,
    callbacks: {},
    parent: document.body,
    print: (m) => { T0.log.push("[out] " + m); if (T0.log.length > 2000) T0.log.shift(); },
    printErr: (m) => { T0.log.push("[err] " + m); if (T0.log.length > 2000) T0.log.shift(); },
    locateFile: (fn) => (fn.endsWith(".wasm") ? "/core/snes9x_libretro.wasm" : fn),
    getSavExt: () => ".srm",
    getInputText: () => "",
  });
  T0.Module = Module;
  const FS = Module.FS;
  mkdirp(FS, "/home/web_user/.config/retroarch");
  FS.writeFile("/home/web_user/.config/retroarch/retroarch.cfg", RA_CFG);

  const romBuf = await fetch(romUrl).then((r) => r.arrayBuffer());
  T0.romBytes = new Uint8Array(romBuf);
  FS.writeFile("/rom.sfc", T0.romBytes);

  Module.callMain(["/rom.sfc"]);
  Module.resumeMainLoop();

  return { heapLen: Module.HEAPU8.length, romLen: T0.romBytes.length };
};

T0.getVideoDims = () => {
  const f = T0.Module.cwrap("get_video_dimensions", "number", ["string"]);
  return { width: f("width"), height: f("height"), aspect: f("aspect") };
};

// cmd_take_screenshot() enqueues a command RetroArch only services on a
// later core iteration (GL readback isn't safe outside the run loop), so
// polling needs pumpFrames() between checks, not setTimeout -- timers don't
// fire reliably in this occluded pane (see pumpFrames comment). Returns
// raw PNG bytes (Uint8Array) -- pass straight to T0.save().
T0.screenshot = () => {
  const FS = T0.Module.FS;
  try { FS.unlink("/screenshot.png"); } catch (e) {}
  T0.Module.cwrap("cmd_take_screenshot", "", [])();
  let found = false;
  for (let i = 0; i < 60; i++) {
    T0.pumpFrames(1);
    try { FS.stat("/screenshot.png"); found = true; break; } catch (e) {}
  }
  if (!found) throw new Error("screenshot.png never appeared after 60 pumped frames");
  return FS.readFile("/screenshot.png");
};

// --- Q2: WRAM location -------------------------------------------------
// Heuristic: GameMode ($7E0100) walks 0->1->...->7 once at boot then holds
// at 7 (TitleScreen, no input simulated). snapA/snapB bracket that walk;
// candidates are bytes that were small early and are exactly 7 later.
// narrowCandidates() re-checks liveness to kill anything that was a
// coincidental counter rather than a value that latches at 7.
T0.takeSnapshot = () => new Uint8Array(T0.Module.HEAPU8); // real copy

T0.findWramCandidates = (snapA, snapB) => {
  const L = Math.min(snapA.length, snapB.length);
  const out = [];
  for (let i = 0; i < L; i++) if (snapA[i] <= 2 && snapB[i] === 7) out.push(i);
  return out;
};

T0.narrowCandidates = (candidates) => {
  const heap = T0.Module.HEAPU8;
  return candidates.filter((i) => heap[i] === 7);
};

T0.readAt = (offsets) => {
  const heap = T0.Module.HEAPU8;
  return offsets.map((o) => heap[o]);
};

// One sample per emulated frame, synchronous end to end (see pumpFrames).
T0.traceGameMode = (offset, maxFrames) => {
  const trace = [];
  for (let n = 0; n < maxFrames; n++) {
    const r = T0.pumpFrames(1);
    trace.push(T0.Module.HEAPU8[offset]);
    if (r.advanced === 0) break; // core wedged; stop rather than spin
  }
  return trace;
};

// --- Q3: ROM location ---------------------------------------------------
T0.findRom = (romBytes) => {
  const heap = T0.Module.HEAPU8;
  const needle = romBytes.subarray(0, 64);
  const H = heap.length, N = needle.length;
  outer: for (let i = 0; i + romBytes.length <= H; i++) {
    for (let j = 0; j < N; j++) if (heap[i + j] !== needle[j]) continue outer;
    for (let k = 64; k < romBytes.length; k++) {
      if (heap[i + k] !== romBytes[k]) continue outer;
    }
    return i;
  }
  return -1;
};

T0.testRomWrite = (offset, romLen) => {
  const heap = T0.Module.HEAPU8;
  const idx = offset + romLen - 1;
  const orig = heap[idx];
  const marker = orig ^ 0xff;
  heap[idx] = marker;
  const readback = T0.Module.HEAPU8[idx];
  T0.Module.HEAPU8[idx] = orig; // restore before any more frames run
  return { idx, orig, marker, readback, stuck: readback === marker };
};

T0.verifyRomStable = (offset, romBytes) => {
  const heap = T0.Module.HEAPU8;
  if (offset + romBytes.length > heap.length) {
    return { ok: false, reason: "offset beyond current heap bounds", heapLen: heap.length };
  }
  for (let k = 0; k < romBytes.length; k++) {
    if (heap[offset + k] !== romBytes[k]) return { ok: false, mismatchAt: k, heapLen: heap.length };
  }
  return { ok: true, heapLen: heap.length };
};

T0.status = () => ({
  frameNum: T0.Module ? T0.Module.cwrap("get_current_frame_count", "number", [])() : null,
  heapLen: T0.Module ? T0.Module.HEAPU8.length : null,
  logTail: T0.log.slice(-15),
});

// === T4: route around the WRAM blocker (see spike/t1/evidence/wram-base-
// investigation.txt) by patching the ROM's own title-screen force-load
// mechanism instead of writing live WRAM. Spec: TRACED MECHANISM block in
// tools/mesen/headless_capture.lua, tracing bank_05.asm:7216-7227.
// Independently transcribed, not copy-pasted, from spike/qa/contract.ts's
// decodeOverride so a slip here can't coincidentally agree with a slip
// there; findViolations()-equivalent round-trip is exercised at call time
// via T0.verifyEncodeRoundTrip below rather than re-running the vitest file
// (no test runner in this browser harness).
T0.encodeOverride = (levelId) => {
  if (!Number.isInteger(levelId) || levelId < 0 || levelId > 0x1ff) return null;
  const submapFlag = levelId >= 0x100 ? 1 : 0;
  const lowByte = levelId & 0xff;
  if (lowByte === 0 || lowByte > 0xdb) return null; // bank_05.asm:7167-7168 (0=passthrough), 7216-7227 (max _E)
  const overrideByte = lowByte < 0x25 ? lowByte : lowByte + 0x24;
  return { overrideByte, submapFlag };
};

T0.verifyEncodeRoundTrip = (levelId) => {
  const enc = T0.encodeOverride(levelId);
  if (!enc) return { levelId, enc: null };
  const E = enc.overrideByte >= 0x25 ? enc.overrideByte - 0x24 : enc.overrideByte;
  const decoded = E | (enc.submapFlag << 8);
  return { levelId, enc, decoded, ok: decoded === levelId };
};

// bank_00.asm:2626-2632. File offset 0x16CB verified against the on-disk
// ROM by the operator (sole hit of `A9 EB A0 00`, checked again below at
// call time against the live heap copy, not trusted blind).
const T4_PATCH = { ldaImm: 0x16cc, ldyImm: 0x16ce, checkFrom: 0x16cb };

// findRom() matches the FULL 524288-byte ROM against the pristine on-disk
// copy, so it can only ever find the ROM before it has been patched -- once
// any byte has been overwritten, the exact-match search fails and returns
// -1. Locate once right after boot and cache; every T4 patch/read helper
// below uses this cached offset instead of re-deriving it after mutation.
T0.romOffset = () => {
  if (T0._romOffsetCache == null) T0._romOffsetCache = T0.findRom(T0.romBytes);
  if (T0._romOffsetCache < 0) throw new Error("ROM not found in heap (call before any patch, right after boot)");
  return T0._romOffsetCache;
};

T0.verifyLevelLoadPatchSite = () => {
  const romOffset = T0.romOffset();
  const heap = T0.Module.HEAPU8;
  const b = heap.subarray(romOffset + T4_PATCH.checkFrom, romOffset + T4_PATCH.checkFrom + 7);
  const ok = b[0] === 0xa9 && b[1] === 0xeb && b[2] === 0xa0 && b[3] === 0x00 && b[4] === 0x8d && b[5] === 0x09 && b[6] === 0x01;
  return { ok, romOffset, bytes: Array.from(b) };
};

// Must run before the FIRST pumped frame: GM03LoadTitleScreen executes
// within the earliest frames of boot and reads this immediate once. boot()
// leaves the rAF stub armed but uninvoked (0 frames run), so calling this
// right after boot() resolves is early enough.
T0.patchLevelLoad = (levelId) => {
  const enc = T0.encodeOverride(levelId);
  if (!enc) throw new Error(`level $${levelId.toString(16)} unreachable via OverworldOverride`);
  const site = T0.verifyLevelLoadPatchSite();
  if (!site.ok) throw new Error("level-load patch site does not match expected bytes; refusing to patch: " + JSON.stringify(site));
  const heap = T0.Module.HEAPU8;
  const before = { lda: heap[site.romOffset + T4_PATCH.ldaImm], ldy: heap[site.romOffset + T4_PATCH.ldyImm] };
  heap[site.romOffset + T4_PATCH.ldaImm] = enc.overrideByte;
  heap[site.romOffset + T4_PATCH.ldyImm] = enc.submapFlag;
  return { romOffset: site.romOffset, levelId, enc, before };
};

// Generic single-byte ROM patch, used for Task B's DATA_05F000[$105]
// (bank_05.asm:7268-7277, file offset 0x02F105). Returns before/after so a
// write that didn't stick is visible immediately, not inferred later from a
// missing visual change.
T0.patchRomByte = (fileOffset, value) => {
  const idx = T0.romOffset() + fileOffset;
  const heap = T0.Module.HEAPU8;
  const before = heap[idx];
  heap[idx] = value;
  return { romOffset: T0._romOffsetCache, idx, before, after: heap[idx] };
};

T0.readRomByte = (fileOffset) => T0.Module.HEAPU8[T0.romOffset() + fileOffset];

// --- Pixel evidence: decode two PNG screenshots and measure what changed,
// rather than asserting "it looks lower". Decoded via createImageBitmap on
// the saved PNG bytes, never via the live WebGL context cmd_take_screenshot
// itself reads from.
T0.decodePng = async (bytes) => {
  const blob = new Blob([bytes], { type: "image/png" });
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
};

// Per-row histogram of pixels differing by more than `tol` in any channel,
// plus the overall bounding box -- lets a caller state WHERE vertically a
// change landed, not just that one exists.
T0.diffImages = (a, b, tol) => {
  tol = tol || 8;
  if (a.width !== b.width || a.height !== b.height) throw new Error("size mismatch");
  const w = a.width, h = a.height;
  let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
  const rowCounts = new Array(h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dr = Math.abs(a.data[i] - b.data[i]), dg = Math.abs(a.data[i + 1] - b.data[i + 1]), db = Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (dr > tol || dg > tol || db > tol) {
        count++;
        rowCounts[y]++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { count, bbox: count ? { minX, minY, maxX, maxY } : null, rowCounts };
};

// --- Task C: find WRAM by planting a signature via the cheat API, not by
// scanning for behavior (that dead end is exhausted, see
// spike/t1/evidence/wram-base-investigation.txt item 5). Pro Action Replay
// SNES code format: 6 hex digits of bus address + 2 hex digits of value.
// Scans the FULL heap for the planted pattern by exact identity -- same
// technique findRom() already uses successfully -- not a statistical or
// behavioral candidate search.
T0.plantWramSignature = (busAddr, sig) => {
  const setCheat = T0.Module.cwrap("set_cheat", null, ["number", "number", "string"]);
  const resetCheat = T0.Module.cwrap("reset_cheat", null, []);
  const before = T0.takeSnapshot();
  sig.forEach((val, i) => {
    const addr = (busAddr + i).toString(16).padStart(6, "0");
    const code = addr + val.toString(16).padStart(2, "0");
    setCheat(i, 1, code);
  });
  resetCheat();
  T0.pumpFrames(1);
  const heap = T0.Module.HEAPU8;
  const H = heap.length, N = sig.length;
  const hits = [];
  outer: for (let i = 0; i + N <= H; i++) {
    for (let j = 0; j < N; j++) if (heap[i + j] !== sig[j]) continue outer;
    if (before[i] === sig[0]) continue; // already matched pre-cheat; not our write
    hits.push(i);
  }
  return { hits, busAddr, sig };
};

// === T5: retest the X-edit hypothesis under a frozen demo (T4's result was
// confounded -- see task brief). Two independent additions: freeze the
// title-screen attract input, and edit the X-table INDEX (not the byte
// wholesale, since bits 3-7 are LevelEntranceType/Layer3Setting per
// spike/t2-mario-start-writeback.md ss4).

// bank_00.asm:3323 TitleScreenInputSeq, NTSC/US table. 34 (input,duration)
// pairs then $FF terminator. Verify the byte layout before trusting it --
// this call is the check, not an assumption from the brief.
const T5_INPUT_TABLE = { start: 0x1c1f, count: 34, stride: 2, terminator: 0x1c63 };

T0.verifyInputFreezeSite = () => {
  const romOffset = T0.romOffset();
  const heap = T0.Module.HEAPU8;
  const b = heap.subarray(romOffset + T5_INPUT_TABLE.start, romOffset + T5_INPUT_TABLE.start + 8);
  const sig = [0x41, 0x0f, 0xc1, 0x30, 0x00, 0x10, 0x42, 0x20];
  const sigOk = sig.every((v, i) => b[i] === v);
  const terminator = heap[romOffset + T5_INPUT_TABLE.terminator];
  return { sigOk, terminatorOk: terminator === 0xff, bytes: Array.from(b), terminator };
};

// Zeroes only the even-offset input bytes (WriteControllerInput reads these
// into byetudlrHold/byetudlrFrame, bank_00.asm:3352-3377); durations and the
// $FF sentinel are left untouched. An $FF input byte is the end-of-data
// marker, not "no input", and falls into FadeOutBackToTitle -- writing it
// would exit the level rather than freeze Mario in it.
T0.freezeDemoInput = () => {
  const site = T0.verifyInputFreezeSite();
  if (!site.sigOk || !site.terminatorOk) {
    throw new Error("input table site mismatch, refusing to patch: " + JSON.stringify(site));
  }
  const romOffset = T0.romOffset();
  const heap = T0.Module.HEAPU8;
  const before = [];
  for (let i = 0; i < T5_INPUT_TABLE.count; i++) {
    const off = T5_INPUT_TABLE.start + i * T5_INPUT_TABLE.stride;
    before.push(heap[romOffset + off]);
    heap[romOffset + off] = 0x00;
  }
  return { count: T5_INPUT_TABLE.count, before };
};

// Generic low-3-bits writer for DATA_05F200-shaped bytes: bits 0-2 are the
// field being edited (X-table index here), bits 3-7 belong to unrelated
// fields (LevelEntranceType, Layer3Setting -- t2-mario-start-writeback.md
// ss4) and MUST survive. Reads back after writing so a patch that silently
// clobbered the upper bits is visible immediately, not inferred from a
// broken rendering later.
T0.patchIndexBits = (fileOffset, newIndex) => {
  const idx = T0.romOffset() + fileOffset;
  const heap = T0.Module.HEAPU8;
  const before = heap[idx];
  heap[idx] = (before & 0xf8) | (newIndex & 0x07);
  const readback = heap[idx];
  return {
    idx, before, readback,
    upperBitsPreserved: (readback & 0xf8) === (before & 0xf8),
    lowBitsWritten: (readback & 0x07) === (newIndex & 0x07),
  };
};

// --- Pixel evidence, column-wise: diffImages() gives one fused bbox over
// ALL differing pixels, which conflates the vacated and occupied Mario
// positions into a single box. Splitting by contiguous X-runs separates
// them (and separates either from an unrelated HUD-row run, distinguishable
// by its Y range) without hardcoding where Mario or the HUD are.
T0.diffColumnRuns = (a, b, tol) => {
  tol = tol || 8;
  if (a.width !== b.width || a.height !== b.height) throw new Error("size mismatch");
  const w = a.width, h = a.height;
  const colHit = new Array(w).fill(false);
  const colMinY = new Array(w).fill(h), colMaxY = new Array(w).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dr = Math.abs(a.data[i] - b.data[i]), dg = Math.abs(a.data[i + 1] - b.data[i + 1]), db = Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (dr > tol || dg > tol || db > tol) {
        colHit[x] = true;
        if (y < colMinY[x]) colMinY[x] = y;
        if (y > colMaxY[x]) colMaxY[x] = y;
      }
    }
  }
  const runs = [];
  let cur = null;
  for (let x = 0; x < w; x++) {
    if (colHit[x]) {
      if (!cur) cur = { minX: x, maxX: x, minY: colMinY[x], maxY: colMaxY[x] };
      else {
        cur.maxX = x;
        if (colMinY[x] < cur.minY) cur.minY = colMinY[x];
        if (colMaxY[x] > cur.maxY) cur.maxY = colMaxY[x];
      }
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  return runs;
};

// Nearest-neighbor upscale of a rect from a decoded PNG (T0.decodePng), for
// visual bounding-box readout on a 256x224 native frame -- returns PNG bytes
// for T0.save(), never round-tripped through chat.
T0.cropScaled = (imgData, rect, scale) => {
  const src = document.createElement("canvas");
  src.width = imgData.width; src.height = imgData.height;
  src.getContext("2d").putImageData(imgData, 0, 0);
  const out = document.createElement("canvas");
  out.width = rect.w * scale; out.height = rect.h * scale;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w * scale, rect.h * scale);
  return new Promise((resolve) => out.toBlob((blob) => blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))), "image/png"));
};

// Task C: exported loop controls are cwrap'd on demand rather than assumed
// present -- a missing export throws from cwrap itself, which is the
// observation Task C needs ("which export actually works").
T0.callVoidExport = (name) => { T0.Module.cwrap(name, null, [])(); return true; };

// === T6 Task A: level geometry edit ============================================
// LoROM conversion transcribed from src/rom/addressing.ts's loromToOffset
// (read, not copied -- this is a from-scratch reimplementation so a slip here
// can't coincidentally agree with a slip there), specialised to bank<0x40
// headerless ROMs, which is all this task needs.
T0.loromToOffset = (snesAddr) => {
  const bank = (snesAddr >>> 16) & 0xff;
  const addr = snesAddr & 0xffff;
  if (bank === 0x7e || bank === 0x7f) return null;
  const effBank = bank & 0x7f;
  if (effBank <= 0x3f && addr < 0x8000) return null;
  return effBank * 0x8000 + (addr & 0x7fff);
};

// Layer1Ptrs at SNES $05E000, 3-byte entries (bank_05.asm:7235, CODE_05D8B7),
// indexed by the FULL 16-bit level id (_E/_F read as one 16-bit direct-page
// pair in 16-bit-A mode; see CODE_05D8B7's `LDA.B _E` after `REP #$30`) times
// 3, NOT by the low byte alone -- confirmed by resolving level $105 (E=$05,
// submapFlag F=1 -> id=$105) against the ROM and getting a plausible 20-screen
// level header (see spike/t6/evidence/level_105_objects.txt).
T0.readLayer1DataOffset = (levelId) => {
  const y = levelId * 3;
  const ptrOff = T0.romOffset() + T0.loromToOffset(0x05e000 + y);
  const heap = T0.Module.HEAPU8;
  const lo = heap[ptrOff], hi = heap[ptrOff + 1], bank = heap[ptrOff + 2];
  const l1Snes = (bank << 16) | (hi << 8) | lo;
  return { l1Snes, l1FileOffset: T0.loromToOffset(l1Snes), ptrBytes: [lo, hi, bank] };
};

// Generic verified two-byte-or-more patch: refuses to write unless the
// current bytes match what we traced from the disassembly, so a wrong
// address can't silently "succeed". Used for Task B's UseSecondaryExit gate
// NOP (bank_05.asm:7300-7302) -- keeping it generic (not gate-specific) means
// the same call also re-verifies Task A's object bytes are unmodified before
// that edit.
T0.patchBytesVerified = (fileOffset, expectedBefore, newBytes) => {
  const idx = T0.romOffset() + fileOffset;
  const heap = T0.Module.HEAPU8;
  const actual = Array.from(heap.subarray(idx, idx + expectedBefore.length));
  const matches = expectedBefore.every((v, i) => v === actual[i]);
  if (!matches) throw new Error(`byte mismatch at 0x${fileOffset.toString(16)}: expected ${expectedBefore} got ${actual}`);
  newBytes.forEach((v, i) => { heap[idx + i] = v; });
  return { idx, before: actual, after: Array.from(heap.subarray(idx, idx + newBytes.length)) };
};

// Object position nibble patch: byte 0's low nibble is Y (bits 3-0), byte 1's
// low nibble is X (bits 3-0) -- LevelParser.ts parseLevelObjects. Bits 4-7 of
// either byte carry unrelated fields (highCoord/newScreen/objNum) that MUST
// survive, so this only ever touches bits 3-0, same masking discipline as
// T5's patchIndexBits but on the opposite nibble.
T0.patchPositionNibble = (fileOffset, newLow) => {
  const idx = T0.romOffset() + fileOffset;
  const heap = T0.Module.HEAPU8;
  const before = heap[idx];
  heap[idx] = (before & 0xf0) | (newLow & 0x0f);
  const readback = heap[idx];
  return {
    idx, before, readback,
    upperNibblePreserved: (readback & 0xf0) === (before & 0xf0),
    lowNibbleWritten: (readback & 0x0f) === (newLow & 0x0f),
  };
};
