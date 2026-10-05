// T0 capability probe harness. Disposable. Calling convention (config keys,
// callMain/resumeMainLoop sequence, cmd_take_screenshot -> /screenshot.png)
// reverse-derived from EmulatorJS data/src/{emulator,GameManager}.js
// (GameManager.js:41 writes the retroarch.cfg below; :226 is the screenshot
// poll loop we mirror). GameMode address ($7E0100) is rammap.asm:980.

const T0 = (window.T0 = { log: [], Module: null });

// Push evidence bytes to serve.py's /save route instead of round-tripping
// base64 through chat (that silently truncated a blob once already).
T0.save = async (name, bytes) => {
  const r = await fetch("/save?name=" + encodeURIComponent(name), { method: "POST", body: bytes, headers: { "X-Save-Token": window.SAVE_TOKEN } });
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
