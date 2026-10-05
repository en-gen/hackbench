-- Mesen 2 Lua: sprite routine oracle. Records every real execution of the
-- game's per-slot sprite handler (INIT and MAIN alike) with its inputs
-- (registers + WRAM) and outputs (the ordered write log), and, at the end of
-- each recorded frame, what the PPU actually drew (OAM, OBJ character VRAM,
-- CGRAM rows 8-15) with every OAM entry attributed to the slot that wrote it.
-- hackbench's 65816 core replays each call from those inputs; the comparator
-- (spikes/sprite-oracle/oracle/compare_sprite_trace.mts) diffs its write log against this.
--
-- Two modes, one recorder (HB_MODE):
--   level  (default)  force-load map HB_LEVEL_ID like headless_capture.lua,
--                     record the first HB_K_FRAMES frames of the level.
--   spawn             spikes/sprite-oracle/mesen/sprite_spawn_extract.lua sets this.
-- Run through spikes/sprite-oracle/scripts/run_sprite_oracle.ps1, or:
--   Mesen.exe --testrunner spikes/sprite-oracle/mesen/sprite_routine_trace.lua <rom> ^
--     --snes.rampoweronstate=AllZeros --snes.disableframeskipping=true
--
-- Unit of recording: HandleSprite ($01:8127, SMWDisX bank_01.asm:181), called
-- once per slot from the loop at CODE_01808C (bank_01.asm:110-129, the
-- `JSR HandleSprite` at $01:80AF, next instruction DEX at $01:80B2). It
-- dispatches on $14C8,X: status 1 -> CallSpriteInit (bank_01.asm:225, per-id
-- pointer table through ExecutePtr), status 8 -> CallSpriteMain
-- (bank_01.asm:893), the rest (killed, stunned, kicked, carried...) to their
-- own handlers that call MAIN. Recording the whole of it, not only the
-- per-id routine, keeps the call self-contained: the core starts at $01:8127
-- with the return address on the recorded stack and stops when the loop's
-- DEX is next to execute.

local MEM = emu.memType.snesMemory
local function r(a) return emu.read(a, MEM) end
local function w(a, v) emu.write(a, v, MEM) end
local function rw(a) return r(a) + r(a + 1) * 256 end

local ENV = {
  MODE = SPRITE_ORACLE_MODE or os.getenv("HB_MODE") or "level",
  OUT = os.getenv("HB_CAPTURE_OUT"),
  K = tonumber(os.getenv("HB_K_FRAMES")) or 3,
  LEVEL = tonumber(os.getenv("HB_LEVEL_ID")) or 0x105,
  IDS = os.getenv("HB_SPAWN_IDS"),        -- spawn mode: "0,5,31" (hex ok)
  SPAWN_LEVEL = tonumber(os.getenv("HB_SPAWN_LEVEL")) or 0x0BD,
  TAG = os.getenv("HB_SAMPLE_TAG") or "",
}
if ENV.MODE == "spawn" then ENV.LEVEL = ENV.SPAWN_LEVEL; ENV.K = tonumber(os.getenv("HB_K_FRAMES")) or 16 end
if not ENV.OUT or ENV.OUT == "" then
  emu.log("HB_CAPTURE_OUT not set")
  emu.stop(25)
  return
end

local logf = io.open(ENV.OUT .. "/debug.log", "w")
local function dlog(s)
  emu.log(s)
  if logf then logf:write(s, "\n"); logf:flush() end
end

local function resolve(names)
  for _, n in ipairs(names) do if emu.memType[n] ~= nil then return emu.memType[n] end end
end
local CGRAM = resolve({ "snesCgRam" })
local VRAM = resolve({ "snesVideoRam" })
local OAM = resolve({ "snesSpriteRam" })
if not (CGRAM and VRAM and OAM) then dlog("PPU memTypes missing"); emu.stop(19); return end

-- ── tiny JSON writer (no library under --testrunner) ─────────────────────────
local function enc(v)
  local t = type(v)
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return string.format("%d", v)
  elseif t == "boolean" then return tostring(v)
  elseif t == "string" then
    return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"'
  elseif t == "table" then
    if v[1] ~= nil or next(v) == nil then
      local p = {}
      for i = 1, #v do p[i] = enc(v[i]) end
      return "[" .. table.concat(p, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local p = {}
    for _, k in ipairs(keys) do p[#p + 1] = enc(tostring(k)) .. ":" .. enc(v[k]) end
    return "{" .. table.concat(p, ",") .. "}"
  end
  return "null"
end

local function bytesOf(memType, start, count)
  local out = {}
  for i = 0, count - 1, 256 do
    local n = math.min(256, count - i)
    local c = {}
    for j = 0, n - 1 do c[j + 1] = emu.read(start + i + j, memType) end
    out[#out + 1] = string.char(table.unpack(c))
  end
  return table.concat(out)
end

local function writeFile(path, data, binary)
  local f = io.open(path, binary and "wb" or "w")
  if not f then dlog("io.open failed " .. path); return false end
  f:write(data)
  f:close()
  return true
end

-- ── addresses (each cited) ───────────────────────────────────────────────────
local A = {
  GAME_MODE = 0x7E0100,        -- rammap.asm:977
  OVERRIDE = 0x7E0109,         -- rammap.asm:1033
  SUBMAP = 0x7E1F11,
  PLAYER_ANIM = 0x7E0071,      -- rammap.asm:563
  STATUS = 0x7E14C8,           -- SpriteStatus, rammap.asm:1703
  NUMBER = 0x7E009E,           -- SpriteNumber, rammap.asm:919
  OAMIDX = 0x7E15EA,           -- SpriteOAMIndex, rammap.asm:1730
  XL = 0x7E00E4, XH = 0x7E14E0, YL = 0x7E00D8, YH = 0x7E14D4,
}
local HANDLE_SPRITE = 0x018127   -- SMWDisX bank_01.asm:181
local LOOP_NEXT = 0x0180B2       -- DEX after `JSR HandleSprite`, bank_01.asm:125-126
local L1PTR = 0x0065             -- Layer1DataPtr, rammap.asm:533
local L1TABLE = 0x05E000         -- Layer1Ptrs, bank_05.asm:7235
local WRAM_LO = 0x2000           -- recorded in full per call: all of $7E0000-$7E1FFF
-- Level Map16: sprites read tile numbers for block collision from these
-- (low byte $7EC800, high byte $7FC800; bank_00.asm "LDA.B [_6]" style
-- indirect reads). Tile data is static during the first frames, so it is
-- recorded once per map, not per call.
local MAP16_LO, MAP16_HI, MAP16_LEN = 0x7EC800, 0x7FC800, 0x3800
-- Other WRAM the handlers read, found by two full sweeps (1122 calls; the only
-- calls that read outside $7E0000-$7E1FFF and the Map16 were INIT of ids $29
-- and $A0 and the sprites of map $0C3, up to $7EB1B1 and $7F9BF8): per-call
-- snapshots, in this order, in wram_hi.bin. Extend the list when the
-- comparator names a new unseeded read.
local HI = { { 0x7EAD00, 0x700 }, { 0x7F8000, 0x2000 } }

-- ── recorder state ───────────────────────────────────────────────────────────
local S = {
  frame = 0, on = false, f = 0, calls = {}, frames = {}, cur = nil,
  oamOwner = {}, nmiHits = 0, wramBlob = {}, hiBlob = {}, nWram = 0,
  status0 = 0, perStatus = {}, hit7e = 0,
  vramBlobs = {}, vramIdx = {}, oamBlob = {}, cgBlob = {}, wmirBlob = {},
}
local NMI_ENTRY = nil

local function clearOwners() for i = 0, 127 do S.oamOwner[i] = -1 end end
clearOwners()

local function canon(address)
  local bank = address >> 16
  local off = address & 0xFFFF
  if bank == 0x7E or bank == 0x7F then return address end
  if off < 0x2000 then return 0x7E0000 + off end
  return off     -- hardware registers: $2100-$21FF, $4200-$43FF, bank folded
end

local function onWrite(address, value)
  if address >= 0x7E0000 then S.hit7e = S.hit7e + 1 end
  local c = S.cur
  if not c then return end
  local a = canon(address)
  -- $2100-$21FF: PPU registers. MEASURED: HDMA channels (window, colour math)
  -- write here mid-routine and Mesen reports them as writes at the same
  -- addresses, indistinguishable from the CPU's, so the whole range is
  -- counted and dropped. A sprite routine's own PPU writes cannot be graded.
  if a >= 0x2100 and a < 0x2200 then c.ppuw = (c.ppuw or 0) + 1; return end
  -- Interrupt handlers (IRQ at the status-bar scanline hits most calls, NMI on
  -- lag frames) run inside the routine. Their writes are the shadow's (so the
  -- completeness check still balances) but not the routine's: not logged.
  if S.inInt then c.ov[a] = value; c.intw = (c.intw or 0) + 1; return end
  c.writes[#c.writes + 1] = a * 256 + value     -- packed: addr << 8 | value
  c.ov[a] = value
  if a >= 0x7E0200 and a < 0x7E0400 then
    S.oamOwner[(a - 0x7E0200) >> 2] = c.i
  elseif a >= 0x7E0420 and a < 0x7E04A0 then
    S.oamOwner[a - 0x7E0420] = c.i   -- OAMTileSize, one byte per entry (rammap.asm:1107, ORG $0420)
  end
end
for bank = 0, 15 do
  local b = bank * 0x10000
  emu.addMemoryCallback(onWrite, emu.callbackType.write, b, b + 0x1FFF)
  emu.addMemoryCallback(onWrite, emu.callbackType.write, b + 0x2100, b + 0x43FF)
end
emu.addMemoryCallback(onWrite, emu.callbackType.write, 0x7E0000, 0x7FFFFF)

local function snapshotWram()
  local t, chunks = {}, {}
  for i = 0, WRAM_LO - 1, 256 do
    local c = {}
    for j = 0, 255 do local v = emu.read(0x7E0000 + i + j, MEM); c[j + 1] = v; t[i + j] = v end
    chunks[#chunks + 1] = string.char(table.unpack(c))
  end
  return t, table.concat(chunks)
end

-- frame = -1 for calls made while the level is still loading (GameModes $11 and
-- $12 already run the sprite loop once, which is where on-screen sprites get
-- their INIT): no frame dump exists for them, so their OAM cannot be graded.
local function onEnter()
  if not S.on or S.cur then return end
  local st = emu.getState()
  local x = st["cpu.x"]
  if x > 11 then return end
  local status = r(A.STATUS + x)
  S.perStatus[status] = (S.perStatus[status] or 0) + 1
  if status == 0 then S.status0 = S.status0 + 1; return end   -- EraseSprite only
  local snap, blob = snapshotWram()
  local i = #S.calls
  local kind = (status == 1 and "init") or (status == 8 and "main") or "other"
  S.cur = {
    i = i, frame = (r(A.GAME_MODE) == 0x14) and S.f or -1, emuFrame = S.frame, gm = r(A.GAME_MODE), kind = kind, slot = x, id = r(A.NUMBER + x), status = status,
    regs = { a = st["cpu.a"], x = st["cpu.x"], y = st["cpu.y"], s = st["cpu.sp"], d = st["cpu.d"],
             db = st["cpu.dbr"], p = st["cpu.ps"], e = st["cpu.emulationMode"] and 1 or 0,
             pc = st["cpu.pc"], pb = st["cpu.k"] },
    writes = {}, ov = {}, snap = snap, nmi = 0,
  }
  S.wramBlob[#S.wramBlob + 1] = blob
  local hi = {}
  for _, reg in ipairs(HI) do hi[#hi + 1] = bytesOf(MEM, reg[1], reg[2]) end
  S.hiBlob[#S.hiBlob + 1] = table.concat(hi)
  S.nWram = S.nWram + 1
end

local function onLeave()
  local c = S.cur
  if not c then return end
  S.cur = nil; S.inInt = false
  -- Completeness check: entry WRAM + logged writes must equal WRAM now. A
  -- non-zero count means a write path the callbacks missed (or an NMI).
  local bad, first = 0, {}
  for i = 0, WRAM_LO - 1 do
    local exp = c.ov[0x7E0000 + i]
    if exp == nil then exp = c.snap[i] end
    local got = emu.read(0x7E0000 + i, MEM)
    if got ~= exp then
      bad = bad + 1
      if #first < 6 then first[#first + 1] = { i, exp, got } end
    end
  end
  S.calls[#S.calls + 1] = {
    i = c.i, frame = c.frame, emuFrame = c.emuFrame, gm = c.gm, kind = c.kind, slot = c.slot, id = c.id, status = c.status,
    regs = c.regs, wram = c.i, nWrites = #c.writes, writes = c.writes, ppuWritesDropped = c.ppuw or 0, intWritesDropped = c.intw or 0, intPushMismatch = c.pushMismatch or false, irq = c.irq or 0,
    nmi = c.nmi, unlogged = bad, unloggedFirst = first,
    exitS = emu.getState()["cpu.sp"],
  }
end

emu.addMemoryCallback(onEnter, emu.callbackType.exec, HANDLE_SPRITE, HANDLE_SPRITE)
emu.addMemoryCallback(onLeave, emu.callbackType.exec, LOOP_NEXT, LOOP_NEXT)
-- Interrupts: NMI ($00:816A, bank_00.asm:193) and IRQ ($00:8374, :435), the
-- vectors read at runtime ($00:FFEA/$FFEE); both end at an RTI ($00:82C3,
-- :353, and $00:83B9, :475). Entry flags the call and switches the write log
-- off until the RTI (see onWrite).
NMI_ENTRY = rw(0x00FFEA)
local IRQ_ENTRY = rw(0x00FFEE)
local RTI_NMI, RTI_IRQ = 0x0082C3, 0x0083B9
-- The CPU's own interrupt push (PB, PC, P: 4 bytes native, 3 emulation) lands
-- BEFORE the first handler instruction, so it is already in the log when the
-- entry callback fires. Strip it by shape: the last n writes must be the
-- n descending stack bytes just below the pre-interrupt S.
local function stripIntPush(c)
  local st = emu.getState()
  local n = st["cpu.emulationMode"] and 3 or 4
  local sp, w = st["cpu.sp"], c.writes
  if #w < n then c.pushMismatch = true; return end
  for j = 1, n do
    if (w[#w - n + j] >> 8) ~= 0x7E0000 + sp + (n - j + 1) then c.pushMismatch = true; return end
  end
  for _ = 1, n do w[#w] = nil end
  c.intw = (c.intw or 0) + n
end
emu.addMemoryCallback(function()
  S.nmiHits = S.nmiHits + 1
  if S.cur then S.cur.nmi = S.cur.nmi + 1; stripIntPush(S.cur); S.inInt = true end
end, emu.callbackType.exec, NMI_ENTRY, NMI_ENTRY)
emu.addMemoryCallback(function()
  S.irqHits = (S.irqHits or 0) + 1
  if S.cur then S.cur.irq = (S.cur.irq or 0) + 1; stripIntPush(S.cur); S.inInt = true end
end, emu.callbackType.exec, IRQ_ENTRY, IRQ_ENTRY)
local function rti() S.inInt = false end
emu.addMemoryCallback(rti, emu.callbackType.exec, RTI_NMI, RTI_NMI)
emu.addMemoryCallback(rti, emu.callbackType.exec, RTI_IRQ, RTI_IRQ)

-- ── per-frame dump: what the PPU holds, attributed to slots ──────────────────
local function ppuKeys()
  local st, o = emu.getState(), {}
  for k, v in pairs(st) do
    if k:find("^ppu%.") and (k:find("[oO]am") or k:find("[oO]bj") or k:find("name") or k:find("Name")) then o[k] = v end
  end
  return o
end

local function recFrame()
  local st = ppuKeys()
  -- OBJ character data: the two 256-char tables. Name base and gap come from
  -- Mesen's own PPU state; analysis cross-checks them against SMW's OBSEL.
  local base = st["ppu.oamBaseAddress"] or 0
  local gap = st["ppu.oamAddressOffset"] or 0
  S.frames[#S.frames + 1] = {
    f = S.f, ppu = st, owners = { table.unpack(S.oamOwner, 0, 127) },
    s15ea = (function() local t = {} for s = 0, 11 do t[s + 1] = r(A.OAMIDX + s) end return t end)(),
    status = (function() local t = {} for s = 0, 11 do t[s + 1] = r(A.STATUS + s) end return t end)(),
    ids = (function() local t = {} for s = 0, 11 do t[s + 1] = r(A.NUMBER + s) end return t end)(),
    cam = { l1x = rw(0x7E001A), l1y = rw(0x7E001C), mx = rw(0x7E0094), my = rw(0x7E0096) },
    obsel = nil,
  }
  S.oamBlob[#S.oamBlob + 1] = bytesOf(OAM, 0, 544)
  S.cgBlob[#S.cgBlob + 1] = bytesOf(CGRAM, 256, 256)               -- rows 8-15 = colours 128-255
  S.wmirBlob[#S.wmirBlob + 1] = bytesOf(MEM, 0x7E0200, 0x2A0)     -- OAM buffer $0200-$03FF, packed sizes $0400, OAMTileSize $0420-$049F
  -- OBJ character VRAM: the two 256-char tables, 8 KB each. Mesen's
  -- oamBaseAddress / oamAddressOffset are VRAM WORD addresses of table 1 and
  -- of table 2 relative to it (SMW run: $6000 and $1000, i.e. OBSEL base 3,
  -- gap 0), so bytes = word * 2. Both are in frames.json for the analysis.
  local t1 = (base * 2) % 0x10000
  local t2 = ((base + gap) * 2) % 0x10000
  S.vramBlobs[#S.vramBlobs + 1] = bytesOf(VRAM, t1, 0x2000) .. bytesOf(VRAM, t2, 0x2000)
  clearOwners()
  S.f = S.f + 1
end

local function flush(extra, dirOverride)
  local dir = dirOverride or ENV.OUT
  local meta = {
    mode = ENV.MODE, k = ENV.K, nCalls = #S.calls, nFrames = #S.frames, nmiHits = S.nmiHits,
    status0Skipped = S.status0, perStatus = S.perStatus, hit7e = S.hit7e, nmiEntry = NMI_ENTRY,
    emuFrames = S.frame, hiRegions = HI,
  }
  for k, v in pairs(extra or {}) do meta[k] = v end
  writeFile(dir .. "/calls.json", enc(S.calls), false)
  writeFile(dir .. "/wram.bin", table.concat(S.wramBlob), true)
  writeFile(dir .. "/wram_hi.bin", table.concat(S.hiBlob), true)
  writeFile(dir .. "/oam.bin", table.concat(S.oamBlob), true)
  writeFile(dir .. "/cgram_rows8_15.bin", table.concat(S.cgBlob), true)
  writeFile(dir .. "/oam_wram_mirror.bin", table.concat(S.wmirBlob), true)
  writeFile(dir .. "/vram.bin", table.concat(S.vramBlobs), true)
  writeFile(dir .. "/frames.json", enc(S.frames), false)
  writeFile(dir .. "/meta.json", enc(meta), false)
end

-- ── mode: level ──────────────────────────────────────────────────────────────
local M = {}   -- mode state
local GM_TITLE, GM_FADE, GM_LEVEL = 7, 0x0F, 0x14
local function encodeOverride(L)
  local lo = L % 256
  if lo == 0 or lo > 0xDB then return nil end
  return (lo < 0x25) and lo or lo + 0x24, (L >= 0x100) and 1 or 0
end

local phase, prevGM, deadline = "title", nil, 0
local override, submap = encodeOverride(ENV.LEVEL)
local expectPtr, observedPtr, pLo, pMid, listening = nil, nil, nil, nil, false
emu.addMemoryCallback(function(address, value)
  if not listening then return end
  if address == L1PTR then pLo = value
  elseif address == L1PTR + 1 then pMid = value
  elseif address == L1PTR + 2 and observedPtr == nil then
    observedPtr = (pLo or 0) + (pMid or 0) * 256 + value * 65536
  end
end, emu.callbackType.write, L1PTR, L1PTR + 2)

local spawn = nil

local function finishLevel()
  dlog(string.format("[DONE] level %03x: %d calls, %d frames, nmi=%d", ENV.LEVEL, #S.calls, #S.frames, S.nmiHits))
  writeFile(ENV.OUT .. "/map16_7ec800.bin", M.map16lo or "", true)
  writeFile(ENV.OUT .. "/map16_7fc800.bin", M.map16hi or "", true)
  flush({ level = ENV.LEVEL, layer1Ptr = observedPtr, expectPtr = expectPtr, sessions = M.sessions or 1 })
  emu.stop(0)
end

local function onFrameLevel()
  local gm = r(A.GAME_MODE)
  if phase == "title" then
    if S.frame == 1 then
      local z = 0
      for i = 0, 15 do z = z + r(0x7EC100 + i) end
      if z ~= 0 then dlog("[POWERON] WRAM probe not zero"); emu.stop(10); return end
      expectPtr = (r(L1TABLE + ENV.LEVEL * 3) + r(L1TABLE + ENV.LEVEL * 3 + 1) * 256 + r(L1TABLE + ENV.LEVEL * 3 + 2) * 65536)
    end
    if prevGM and prevGM ~= GM_TITLE and gm == GM_TITLE then
      if not override then dlog("level unreachable"); emu.stop(11); return end
      w(A.SUBMAP, submap); w(A.OVERRIDE, override); w(A.GAME_MODE, GM_FADE)
      listening = true
      -- Recording is armed from the trigger, not from the first GM $14 frame
      -- the callback sees: the sprite loop already ran in that frame (INIT of
      -- every on-screen sprite), before this endFrame fires. GameModes
      -- $0F-$13 never run the loop, so nothing earlier is recorded.
      S.on = (ENV.MODE == "level")
      phase, deadline = "wait", S.frame + 900
    elseif S.frame > 3600 then dlog("[TIMEOUT] title"); emu.stop(12); return end
    prevGM = gm
    return
  end
  if phase == "wait" then
    if gm == GM_LEVEL then
      if observedPtr ~= expectPtr then
        dlog(string.format("[WRONG_LEVEL] expected %06X observed %s", expectPtr, tostring(observedPtr)))
        emu.stop(14); return
      end
      if ENV.MODE == "spawn" then phase = "settle"; M.settleFrom = S.frame; return end
      -- Level is live: record from the NEXT frame's main loop. Any later
      -- GameMode excursion (entrance-room reload) restarts the session.
      M.map16lo = bytesOf(MEM, MAP16_LO, MAP16_LEN)
      M.map16hi = bytesOf(MEM, MAP16_HI, MAP16_LEN)
      M.sessions = (M.sessions or 0) + 1
      dlog(string.format("[SESSION %d] frame=%d gm=$14 anim=$%02X", M.sessions, S.frame, r(A.PLAYER_ANIM)))
      phase = "rec"
      M.entered = S.frame
      recFrame()   -- frame 0 = the first GM $14 frame, whose calls are already logged
      if S.f >= ENV.K + 1 then phase = "done"; S.on = false; finishLevel() end
      return
    elseif S.frame > deadline then dlog("[TIMEOUT] level"); emu.stop(13) end
    return
  end
  if phase == "settle" or phase == "run" or phase == "waitsave" or phase == "waitload" then return SPAWN_STEP(gm) end
  if phase == "rec" then
    if gm ~= GM_LEVEL then
      dlog(string.format("[RESTART] frame=%d GameMode left $14 (now $%02X); session dropped", S.frame, gm))
      S.cur = nil; phase = "wait"; deadline = S.frame + 900
      S.f, S.calls, S.frames = 0, {}, {}
      S.wramBlob, S.hiBlob, S.nWram, S.oamBlob, S.cgBlob, S.wmirBlob, S.vramBlobs = {}, {}, 0, {}, {}, {}, {}
      S.perStatus, S.status0 = {}, 0
      clearOwners()
      return
    end
    recFrame()
    if S.f >= ENV.K + 1 then phase = "done"; S.on = false; finishLevel() end
  end
end

-- ── mode: spawn ───────────────────────────────────────────────────────────────
-- One fixed, sprite-free level (default $0BD: one screen, no sprites in its
-- list, so nothing scrolls in). When it has settled a savestate is taken;
-- then per id: restore it, clear every sprite slot, put the id in slot 0
-- with status 1 (INIT: HandleSprite's table, bank_01.asm:190-191) and run
-- HB_K_FRAMES frames recording like level mode. Every write the seed makes is
-- in the id's seed.json, and the settled WRAM (the base those writes land on)
-- in baseline_wram.bin, so a replayer can start from identical bytes.
local SPRITE_TABLES = {   -- 12-entry per-slot tables, rammap.asm ("skip 12"), minus MinExtSprite*/collection flags
  0x009E,0x00AA,0x00B6,0x00C2,0x00D8,0x00E4,0x14C8,0x14D4,0x14E0,0x14EC,0x14F8,0x1504,0x1510,0x151C,0x1528,0x1534,
  0x1540,0x154C,0x1558,0x1564,0x1570,0x157C,0x1588,0x1594,0x15A0,0x15AC,0x15B8,0x15C4,0x15D0,0x15DC,0x15EA,0x15F6,
  0x1602,0x160E,0x161A,0x1626,0x1632,0x163E,0x164A,0x1656,0x1662,0x166E,0x167A,0x1686,0x186C,0x187B,0x190F,0x1FD6,0x1FE2,
}
-- LoadSpriteTables / LoadTweakerBytes (bank_07.asm:975-1004) copy these ROM
-- tables, indexed by sprite id, into the slot's tweaker bytes.
local TWEAKER = { {0x07F26C, 0x1656}, {0x07F335, 0x1662}, {0x07F3FE, 0x166E}, {0x07F4C7, 0x167A}, {0x07F590, 0x1686}, {0x07F659, 0x190F} }
-- Level coordinates, slot 0. X = 128. Y = the settled camera Y + 128: the level
-- scrolls vertically with Mario (camera Y 192 when he stands on the floor), so
-- a fixed Y of 128 would sit 64 px ABOVE the screen and the handler's off-screen
-- test would kill most ids at once. The values used are in every seed.json.
local SPAWN_X, SPAWN_Y_OFF = 128, 128
local MARIO_X = 64

local SP = { ids = {}, i = 0, ss = nil, base = nil }
if ENV.IDS and ENV.IDS ~= "" then
  for tok in ENV.IDS:gmatch("[^,]+") do SP.ids[#SP.ids + 1] = tonumber(tok, 16) end
else
  for id = 0, 0xC8 do SP.ids[#SP.ids + 1] = id end
end

local function resetRecorder()
  S.f, S.calls, S.frames, S.cur, S.inInt = 0, {}, {}, nil, false
  S.wramBlob, S.hiBlob, S.nWram, S.oamBlob, S.cgBlob, S.wmirBlob, S.vramBlobs = {}, {}, 0, {}, {}, {}, {}
  S.perStatus, S.status0, S.nmiHits, S.irqHits = {}, 0, 0, 0
  clearOwners()
end

local function seedId(id)
  local W = {}
  local SPAWN_Y = SP.base.camy + SPAWN_Y_OFF
  local function put(addr, v) emu.write(addr, v & 0xFF, MEM); W[#W + 1] = addr * 256 + (v & 0xFF) end
  local function put16(addr, v) put(addr, v & 0xFF); put(addr + 1, (v >> 8) & 0xFF) end
  for _, base in ipairs(SPRITE_TABLES) do for s = 0, 11 do put(0x7E0000 + base + s, 0) end end
  for s = 0, 11 do put(0x7E161A + s, 0xFF) end            -- SpriteLoadIndex: never respawned from the level list
  put(0x7E009E, id)                                        -- SpriteNumber[0]
  put(0x7E14C8, 1)                                         -- SpriteStatus[0] = 1: INIT
  put(0x7E00E4, SPAWN_X & 0xFF); put(0x7E14E0, SPAWN_X >> 8)   -- X low/high
  put(0x7E00D8, SPAWN_Y & 0xFF); put(0x7E14D4, SPAWN_Y >> 8)   -- Y low/high
  put(0x7E15A0, 1)                                         -- ZeroSpriteTables: SpriteOffscreenX = 1 (bank_07.asm:967-968)
  for _, t in ipairs(TWEAKER) do put(0x7E0000 + t[2], r(t[1] + id)) end
  put(0x7E15F6, r(0x07F3FE + id) & 0x0F)                   -- SpriteOBJAttribute (LoadSpriteTables)
  put16(0x7E0094, MARIO_X); put16(0x7E00D1, MARIO_X)      -- Mario X and its next-frame copy
  put16(0x7E0096, SP.base.my); put16(0x7E00D3, SP.base.my) -- Mario Y (the settled standing height)
  put16(0x7E001A, 0); put16(0x7E1462, 0)                  -- Layer 1 X camera (one-screen level: no scroll)
  put16(0x7E001C, SP.base.camy); put16(0x7E1464, SP.base.camy)
  put(0x7E0013, 0); put(0x7E0014, 0)                      -- frame counters
  return W
end

local function spawnFinish(code)
  writeFile(ENV.OUT .. "/baseline_wram.bin", SP.baseWram or "", true)
  dlog(string.format("[DONE] spawn: %d ids", #SP.ids))
  emu.stop(code)
end

-- emu.createSavestate / loadSavestate only work inside an exec callback of the
-- main CPU (MEASURED: Mesen raises an error from an endFrame callback), so
-- endFrame only raises a flag and an exec callback does the work, on GameLoop
-- ($00:806B, SMWDisX bank_00.asm:49), the idle spin between frames. It runs in
-- every game state (an earlier version hooked the sprite loop and hung forever
-- when a spawned id ended the level) and is a clean boundary: no handler or
-- interrupt is in flight.
local LOOP_START = 0x00806B   -- GameLoop, the idle spin between frames: runs in every state
local function startId()
  SP.i = SP.i + 1
  if SP.i > #SP.ids then phase = "finished"; return spawnFinish(0) end
  resetRecorder()
  local id = SP.ids[SP.i]
  SP.seed = seedId(id)
  S.on = true
  phase = "run"
end

local function loopHook()
  SP.hooks = (SP.hooks or 0) + 1
  if ENV.MODE ~= "spawn" then return end
  if SP.wantSave then
    SP.wantSave = false
    SP.base = { my = rw(0x7E0096), camy = rw(0x7E001C), mx = rw(0x7E0094), camx = rw(0x7E001A) }
    SP.baseWram = bytesOf(MEM, 0x7E0000, WRAM_LO)
    M.map16lo = bytesOf(MEM, MAP16_LO, MAP16_LEN)
    M.map16hi = bytesOf(MEM, MAP16_HI, MAP16_LEN)
    SP.ss = emu.createSavestate()
    dlog(string.format("[SETTLED] frame=%d level $%03x marioY=%d camY=%d savestate=%d bytes", S.frame, ENV.LEVEL, SP.base.my, SP.base.camy, #SP.ss))
    startId()
  elseif SP.wantLoad then
    SP.wantLoad = false
    if SP.anyRef then emu.removeMemoryCallback(SP.anyRef, emu.callbackType.exec, 0, 0xFFFFFF); SP.anyRef = nil end
    emu.loadSavestate(SP.ss)
    startId()
  end
end
emu.addMemoryCallback(function()
  local ok, err = xpcall(loopHook, debug.traceback)
  if not ok then dlog("[ERROR] " .. tostring(err)); emu.stop(42) end
end, emu.callbackType.exec, LOOP_START, LOOP_START)

function SPAWN_STEP(gm)
  if phase == "settle" then
    -- Settled: Mario free of any entrance animation, 30 frames after load.
    if gm ~= GM_LEVEL then return end
    if r(A.PLAYER_ANIM) ~= 0 or S.frame < M.settleFrom + 30 then return end
    SP.wantSave = true
    phase = "waitsave"
    return
  end
  if phase == "waitload" then
    SP.waited = (SP.waited or 0) + 1
    if SP.waited % 20 == 1 then dlog(string.format("[WAIT] waited=%d hooks=%d gm=%02X wantLoad=%s", SP.waited, SP.hooks or 0, gm, tostring(SP.wantLoad))) end
    if SP.waited > 120 then dlog("[ERROR] savestate load never ran; hook calls so far: " .. tostring(SP.hooks) .. " phase=" .. phase .. " gm=" .. gm); emu.stop(41) end
    return
  end
  if phase ~= "run" then return end
  -- phase "run": one recorded frame per endFrame
  recFrame()
  if S.f < ENV.K + 1 then return end
  S.on = false
  local id = SP.ids[SP.i]
  local dir = string.format("%s/%02x", ENV.OUT, id)
  writeFile(dir .. "/map16_7ec800.bin", M.map16lo, true)
  writeFile(dir .. "/map16_7fc800.bin", M.map16hi, true)
  writeFile(dir .. "/seed.json", enc({ id = id, level = ENV.LEVEL, x = SPAWN_X, y = SP.base.camy + SPAWN_Y_OFF, marioX = MARIO_X, marioY = SP.base.my,
    camX = 0, camY = SP.base.camy, k = ENV.K, writes = SP.seed, baselineWram = "../baseline_wram.bin" }), false)
  -- A handler still open now never returned: no call record exists for it.
  local hung = S.cur and { slot = S.cur.slot, id = S.cur.id, kind = S.cur.kind, status = S.cur.status, nWrites = #S.cur.writes } or false
  flush({ id = id, level = ENV.LEVEL, gmEnd = gm, hung = hung }, dir)
  phase = "waitload"
  SP.waited = 0
  SP.wantLoad = true
  -- A spawned id can hang the game (MEASURED: $33 loops inside its INIT
  -- forever), and then GameLoop is never reached again. Until the restore has
  -- run, any instruction will do as the hook.
  SP.anyRef = emu.addMemoryCallback(function()
    local ok, err = xpcall(loopHook, debug.traceback)
    if not ok then dlog("[ERROR] " .. tostring(err)); emu.stop(42) end
  end, emu.callbackType.exec, 0, 0xFFFFFF)
end

local function onEndFrame()
  S.frame = S.frame + 1
  onFrameLevel()
end
-- A Lua error inside a callback is otherwise silent (Mesen exits -1 after a
-- timeout with no log), so it is caught, logged and turned into exit 40.
emu.addEventCallback(function()
  local ok, err = xpcall(onEndFrame, debug.traceback)
  if not ok then dlog("[ERROR] " .. tostring(err)); emu.stop(40) end
end, emu.eventType.endFrame)
dlog(string.format("sprite_routine_trace.lua loaded: mode=%s level=%03x K=%d nmi=%06X", ENV.MODE, ENV.LEVEL, ENV.K, NMI_ENTRY))
