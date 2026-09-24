-- Mesen 2 Lua: Layer 3 ground-truth recorder.
--
-- Designed to run alongside `l1_dump.lua` and `l2_dump.lua`. Mesen 2
-- supports multiple loaded scripts simultaneously and frame numbers are
-- emulator-global, so frame N here is the same emulator frame as in the
-- L1/L2 dumps.
--
-- HUD row convention (avoid overlapping other capture scripts):
--   l1_dump.lua → top of screen (existing)
--   l2_dump.lua     → row Y=20
--   l3_dump.lua     → row Y=30  ← THIS SCRIPT
--
-- Outputs (under the same OneDrive `maps/<id>/` folder as L1 dumps):
--   <id>/l3_scroll.csv    per-frame Layer3XPos / Layer3YPos
--   <id>/l3_vram.bin      16384 bytes of VRAM (BG3 chars + tilemap region),
--                         captured once on level-entry (matches l1_dump
--                         workflow — no manual hotkey)
--   <id>/l3_vram.json     sidecar describing the slice
--
-- Controls: none. Capture starts when game-mode hits $14 (Level play) and
-- closes when it leaves. Same convention as l1_dump.lua.
--
-- ROM addresses (verified against C:\Projects\SMWDisX\rammap.asm):
--   Layer3XPos          = $7E:0022   (rammap.asm:178)
--   Layer3YPos          = $7E:0024   (rammap.asm:184)
--   Layer3ScrollType    = $7E:13D5   (rammap.asm:1465)
--   Layer3TideSetting   = $7E:1403   (rammap.asm:1509)  -- 0=non-tide, !=0=tide-on
--   Layer3ScrollXSpeed  = $7E:1458   (rammap.asm:1586)  -- per-frame X drift
--   Layer3ScrollYSpeed  = $7E:145A   (rammap.asm:1587)  -- per-frame Y drift
--   Layer3ScroolDir     = $7E:1460   (rammap.asm:1591)  -- tide direction toggle
--   Layer3TideTimer     = $7E:1B9D   (rammap.asm:2002)  -- counts down till next kick
--   Layer3Setting       = $7E:1BE3   (rammap.asm:2011)  -- per-level 2-bit value (0..3)
--   Layer1YPos          = $7E:001C   (rammap.asm:160)   -- camera Y
--
-- These extra fields let us diagnose "tide looks frozen" cases — sometimes
-- the timer just hasn't expired yet, sometimes the tide gate (Layer3TideSetting)
-- is off, sometimes a different scroll-type takes over. Capturing them per-
-- frame turns visual symptoms into provable diagnoses.
--
-- VRAM mapping: BG3 in 2BPP mode uses word addresses $4000-$4FFF (chars,
-- GFX28-2B at 128 tiles each = 4 files = 4KB words = 8KB bytes) and
-- $5000-$5FFF (64x64 tilemap = 4KB words = 8KB bytes). See L3Loader.ts:42-43.
-- Mesen 2's VRAM byte addressing maps word W → bytes [W*2, W*2+1] little-
-- endian, so the byte range $8000-$BFFF covers both regions.

-- Fixture root for the captures, which are ROM-derived and therefore never
-- committed: they live in OneDrive, outside the repo, like the ROM corpus and
-- the emulator. Spelled from the environment rather than one developer's
-- drive letter; HACKBENCH_FIXTURES_DIR is the same override the TypeScript
-- side reads (test/suite/unit/fixtures/loadMesenFixture.ts).
local DUMPS_DIR = os.getenv("HACKBENCH_FIXTURES_DIR")
  or ((os.getenv("USERPROFILE") or os.getenv("HOME") or ".") .. "/OneDrive/hackbench-fixtures/maps")
local HUD_ROW   = 30  -- HUD-row convention (see header)

local MEM = emu.memType.snesMemory

-- WRAM-direct memType. The Mesen Memory Viewer's "Work RAM" view uses this.
-- For values like Layer3YPos at $7E:0024 that may show stale data via the
-- CPU bus (snesMemory), reading WRAM directly catches the live value the
-- IRQ uses to write BG3VOFS. We resolve defensively across Mesen versions.
local WRAM_MEM = nil
for _, name in ipairs({ "snesWorkRam", "snesWorkRAM", "workRam", "wram" }) do
  local v = emu.memType[name]
  if v ~= nil then WRAM_MEM = v; break end
end

-- VRAM memType — defensive resolution since Mesen 2 has had naming shifts
-- across releases. We try a few names; first hit wins.
local VRAM_MEM = nil
local VRAM_CANDIDATES = { "snesVideoRam", "snesVram", "videoRam", "vram" }
for _, name in ipairs(VRAM_CANDIDATES) do
  local v = emu.memType[name]
  if v ~= nil then VRAM_MEM = v; break end
end

local function r(addr)         return emu.read(addr, MEM) end
-- Read via WRAM-direct memType. Pass full $7E:xxxx; we strip the bank to
-- get the WRAM offset (WRAM is 128KB, banks $7E and $7F).
local function rWram(addr)
  if WRAM_MEM == nil then return r(addr) end
  return emu.read(addr - 0x7E0000, WRAM_MEM)
end
local function rWramWord(addr)
  if WRAM_MEM == nil then return r(addr) + r(addr+1)*256 end
  local off = addr - 0x7E0000
  return emu.read(off, WRAM_MEM) + emu.read(off + 1, WRAM_MEM) * 256
end
local function rVram(addr)
  if VRAM_MEM == nil then return 0 end
  return emu.read(addr, VRAM_MEM)
end

-- ── Address constants ─────────────────────────────────────────────────────
local LAYER3_XPOS_LO         = 0x7E0022
local LAYER3_YPOS_LO         = 0x7E0024
local LAYER3_SCROLL_TYPE     = 0x7E13D5
local LAYER3_TIDE_SETTING    = 0x7E1403
local LAYER3_SCROLL_XSPEED   = 0x7E1458   -- 2 bytes
local LAYER3_SCROLL_YSPEED   = 0x7E145A   -- 2 bytes
local LAYER3_SCROOL_DIR      = 0x7E1460   -- (typo "Scrool" matches rammap.asm)
local LAYER3_TIDE_TIMER      = 0x7E1B9D
local LAYER3_SETTING_RAM     = 0x7E1BE3   -- per-level 2-bit value, NOT same as Layer3TideSetting
local LAYER1_YPOS_LO         = 0x7E001C   -- 2 bytes; camera Y
local EFF_FRAME              = 0x7E0014

-- VRAM dump window: word $4000..$5FFF == byte $8000..$BFFF == 16384 bytes.
-- Covers BG3 chars (GFX28-2B) and the L3 tilemap.
local VRAM_DUMP_BYTE_START = 0x8000
local VRAM_DUMP_BYTES      = 0x4000   -- 16384

local TRANSLEVEL_LO = 0x7E13BF
local L1PTR_LO      = 0x7E0065
local L1PTR_HI      = 0x7E0066
local L1PTR_BK      = 0x7E0067
local GAME_MODE     = 0x7E0100
local GM_LEVEL      = 0x14

-- ── Helpers ──────────────────────────────────────────────────────────────
local function readWord(loAddr) return r(loAddr) + r(loAddr + 1) * 256 end

-- ── Sublevel-aware level-id detection (ported from l1_dump.lua) ─────────
-- See l2_dump.lua's matching block for the full rationale. Three layers:
--   1. SNAPSHOT of $7E:000F writes during load modes (after-the-fact).
--   2. L1PTR REVERSE-LOOKUP CACHE built once at script start (works the
--      moment the script loads, even when already in a sublevel).
--   3. TranslevelNo fallback (overworld only).
local snapshotLevel = nil

local LEVEL_COUNT = 0x200
local L1_PTR_TABLE = 0x05E000
local L2_PTR_TABLE = 0x05E600
local mapCache = nil
local mapCacheBuilt = false

local function walkObjStreamEnd(startAddr)
  local p = startAddr + 5
  for _ = 1, 2048 do
    local b0 = r(p)
    if b0 == nil then return nil end
    if b0 == 0xFF then return p end
    local b1 = r(p + 1)
    local b2 = r(p + 2)
    if b1 == nil or b2 == nil then return nil end
    p = p + 3
    local objNumHigh = math.floor((b0 % 128) / 32) * 16
    local objNumLow  = math.floor(b1 / 16) % 16
    local objectNumber = objNumHigh + objNumLow
    if objectNumber == 0 and b2 == 0 then p = p + 1 end
  end
  return nil
end

local function readPtr(tableBase, i)
  local lo   = r(tableBase + i * 3)     or 0
  local hi   = r(tableBase + i * 3 + 1) or 0
  local bank = r(tableBase + i * 3 + 2) or 0
  return bank * 0x10000 + hi * 0x100 + lo, bank
end

local function buildMapCache()
  mapCacheBuilt = true
  mapCache = {}
  for i = 0, LEVEL_COUNT - 1 do
    local l1Start, _      = readPtr(L1_PTR_TABLE, i)
    local l2Start, l2Bank = readPtr(L2_PTR_TABLE, i)
    local endAddr
    if l2Bank == 0xFF or l2Bank == 0 then
      endAddr = walkObjStreamEnd(l1Start)
    else
      endAddr = walkObjStreamEnd(l2Start)
    end
    if endAddr ~= nil and mapCache[endAddr] == nil then
      mapCache[endAddr] = i
    end
  end
end

local function currentLevelByL1Ptr()
  if not mapCacheBuilt then buildMapCache() end
  local lo   = r(L1PTR_LO)
  local hi   = r(L1PTR_HI)
  local bank = r(L1PTR_BK)
  local key  = bank * 0x10000 + hi * 0x100 + lo
  return mapCache[key]
end

local function currentLevelByTranslevel()
  local tl = readWord(TRANSLEVEL_LO)
  if tl == 0 then return nil end
  if tl >= 0x25 then return (tl - 0x24) + 0x100 end
  return tl
end

local function currentMapId()
  return snapshotLevel
      or currentLevelByL1Ptr()
      or currentLevelByTranslevel()
      or (r(L1PTR_BK) * 0x10000 + r(L1PTR_HI) * 0x100 + r(L1PTR_LO))
end

local function mapIdStr(id)
  if id < 0x1000 then return string.format("%03x", id) end
  return string.format("p%06x", id)
end

-- ── State ────────────────────────────────────────────────────────────────
local csvFile        = nil
local currentMap     = nil
local frame          = 0
local framesInLevel  = 0
local snapshotFlash  = 0

local function levelDir(id) return DUMPS_DIR .. "/" .. mapIdStr(id) end
local function ensureDir(dir)
  pcall(os.execute, string.format('if not exist "%s" mkdir "%s"',
    dir:gsub("/", "\\"), dir:gsub("/", "\\")))
end
local function csvPath(id)  return levelDir(id) .. "/l3_scroll.csv" end
local function binPath(id)  return levelDir(id) .. "/l3_vram.bin" end
local function jsonPath(id) return levelDir(id) .. "/l3_vram.json" end

local function openCsv(id)
  if csvFile then csvFile:close() end
  ensureDir(levelDir(id))
  local f, err = io.open(csvPath(id), "w")
  if not f then
    emu.log(string.format("[l3_dump] failed to open %s: %s", csvPath(id), tostring(err)))
    csvFile = nil
    return
  end
  f:write("frame,l3x,l3y,l3y_wram,l3y_lastWrite,l3y_writeCount,tideSet,tideTimer,xSpeed,ySpeed,dir,scrollType,effFrame,l3Setting,l1y\n")
  csvFile = f
  framesInLevel = 0
  emu.log(string.format("[l3_dump] opened %s", csvPath(id)))
end

local function closeCsv()
  if csvFile then csvFile:close(); csvFile = nil end
end

local function snapshotVram(id)
  if VRAM_MEM == nil then
    emu.log("[l3_dump] no VRAM memType resolved; cannot snapshot")
    return false
  end
  local bytes = {}
  for i = 0, VRAM_DUMP_BYTES - 1 do
    bytes[i + 1] = string.char(rVram(VRAM_DUMP_BYTE_START + i))
  end
  local bin = io.open(binPath(id), "wb")
  if not bin then
    emu.log(string.format("[l3_dump] failed to open %s for write", binPath(id)))
    return false
  end
  bin:write(table.concat(bytes))
  bin:close()

  local jsn = io.open(jsonPath(id), "w")
  if jsn then
    jsn:write(string.format(
      '{"map":"$%s","source":"VRAM byte $8000-$BFFF (= word $4000-$5FFF)",' ..
      '"bytes":%d,"frame":%d,"l3x":%d,"l3y":%d,' ..
      '"layout":"BG3 chars at byte $8000-$9FFF (word $4000-$4FFF), tilemap at byte $A000-$BFFF (word $5000-$5FFF)"}\n',
      mapIdStr(id), VRAM_DUMP_BYTES, framesInLevel,
      readWord(LAYER3_XPOS_LO), readWord(LAYER3_YPOS_LO)))
    jsn:close()
  end
  emu.log(string.format("[l3_dump] snapshot saved: %s", binPath(id)))
  return true
end

-- ── HUD ──────────────────────────────────────────────────────────────────
local COLOR_ON    = 0x88FFAA
local COLOR_IDLE  = 0x808080
local COLOR_FLASH = 0xFFEE66
local COLOR_WARN  = 0xFF8888

local function drawHud()
  local gm = r(GAME_MODE)
  local inLevel = (gm == GM_LEVEL) and (csvFile ~= nil)
  local mapStr = currentMap and mapIdStr(currentMap) or "----"
  local color, msg
  if VRAM_MEM == nil and snapshotFlash == 0 then
    color = COLOR_WARN
    msg = "[L3] WARN no VRAM memType (CSV still works)"
  elseif snapshotFlash > 0 then
    color = COLOR_FLASH
    msg = string.format("[L3] map $%s -- saved vram", mapStr)
    snapshotFlash = snapshotFlash - 1
  elseif inLevel then
    color = COLOR_ON
    msg = string.format("[L3] map $%s -- cap on (frame %d)", mapStr, framesInLevel)
  else
    color = COLOR_IDLE
    msg = "[L3] idle (waiting for level)"
  end
  emu.drawString(8, HUD_ROW, msg, color, 0x000000)
  -- Live read of $7E:0024 + $7E:0014, displayed on HUD so we can compare
  -- against Mesen's Memory Viewer at the same instant.
  if inLevel then
    local liveL3Y    = readWord(LAYER3_YPOS_LO)
    local liveEff    = r(EFF_FRAME)
    local liveTideSet = r(LAYER3_TIDE_SETTING)
    local liveYSpeed  = readWord(LAYER3_SCROLL_YSPEED)
    emu.drawString(8, HUD_ROW + 10, string.format(
      "[L3] Lua: l3y=$%02X eff=$%02X tideSet=%d ySpd=%d  (compare to Mem Viewer @\\$7E:0024)",
      liveL3Y, liveEff, liveTideSet, liveYSpeed),
      0xFFFFAA, 0x000000)
  end
end

-- ── Main loop ────────────────────────────────────────────────────────────
local function onFrame()
  frame = frame + 1
  local gm = r(GAME_MODE)

  if gm == GM_LEVEL then
    -- Cache-first resolution. See l2_dump.lua's onFrame for the rationale:
    -- block hits clobber Layer1DataPtr for ~1 frame, so we only switch
    -- files when the live cache resolves. Transient miss leaves the
    -- previously open file untouched.
    local cache = currentLevelByL1Ptr()
    local snap  = snapshotLevel
    local tl    = currentLevelByTranslevel()
    local id    = cache or snap or tl
        or (r(L1PTR_BK) * 0x10000 + r(L1PTR_HI) * 0x100 + r(L1PTR_LO))
    local entered = (csvFile == nil) or (id ~= currentMap)
    if entered and (cache ~= nil or csvFile == nil) then
      currentMap = id
      openCsv(id)
      -- Snapshot VRAM once on level-entry. The game's L3 setup runs during
      -- the load modes ($0F-$13) before $14, so VRAM is ready as of the
      -- first Level frame.
      if snapshotVram(currentMap) then snapshotFlash = 60 end
    end
    if csvFile then
      framesInLevel = framesInLevel + 1
      -- Signed-byte for ScrollYSpeed: it's an 8-bit acceleration that the
      -- tide animation can drive negative. We store as raw 16-bit word but
      -- consumers should interpret bit-7 of the low byte as sign for the
      -- single-byte speed reads. Layer3ScrollXSpeed/YSpeed are 2-byte
      -- per rammap.asm.
      csvFile:write(string.format("%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\n",
        framesInLevel,
        readWord(LAYER3_XPOS_LO),
        readWord(LAYER3_YPOS_LO),       -- via snesMemory (CPU bus)
        rWramWord(LAYER3_YPOS_LO),      -- via WRAM-direct
        _G.lastL3YWrite,                -- last value observed via write callback
        _G.l3yWriteCount,               -- total writes since script load
        r(LAYER3_TIDE_SETTING),
        r(LAYER3_TIDE_TIMER),
        readWord(LAYER3_SCROLL_XSPEED),
        readWord(LAYER3_SCROLL_YSPEED),
        r(LAYER3_SCROOL_DIR),
        r(LAYER3_SCROLL_TYPE),
        r(EFF_FRAME),
        r(LAYER3_SETTING_RAM),
        readWord(LAYER1_YPOS_LO)))
    end
  else
    if csvFile ~= nil then
      emu.log(string.format("[l3_dump] closed (gameMode=%02X)", gm))
      closeCsv()
      currentMap = nil
    end
  end

  drawHud()
end

emu.addEventCallback(onFrame, emu.eventType.endFrame)

-- ── Write trace on $7E:0024 (Layer3YPos low byte) ────────────────────────
-- Definitive diagnostic: every CPU write to $7E:0024 stores the value into
-- `lastL3YWrite` and bumps `l3yWriteCount`. If the per-frame CSV's read
-- columns stay static at $D0 while `lastL3YWrite` shows varying values,
-- emu.read returns stale data and we should switch to the callback-tracked
-- value as ground truth.
_G.lastL3YWrite   = -1   -- value of the last observed write, -1 = none yet
_G.l3yWriteCount  = 0    -- total writes seen since script load
local writeCallbackOk = false
local function onLayer3YPosWrite(addr, value)
  _G.lastL3YWrite = value
  _G.l3yWriteCount = _G.l3yWriteCount + 1
end
local writeCallbackTypes = {
  emu.callbackType and emu.callbackType.cpuWrite,
  emu.callbackType and emu.callbackType.write,
  emu.memCallbackType and emu.memCallbackType.cpuWrite,
  emu.memCallbackType and emu.memCallbackType.write,
}
for _, t in ipairs(writeCallbackTypes) do
  if t ~= nil then
    local ok = pcall(emu.addMemoryCallback, onLayer3YPosWrite, t, 0x7E0024)
    if ok then writeCallbackOk = true; break end
  end
end

-- ── Sublevel snapshot via $7E:000F write trace ──────────────────────────
-- Direct registration with emu.callbackType.write (matching l1_dump). The
-- pcall-loop pattern used elsewhere in this file was silently failing to
-- register; this works.
local function onFWrite(_addr, value)
  if value > 1 then return end
  local gm = r(0x7E0100)
  if gm ~= 0x0F and gm ~= 0x11 and gm ~= 0x12 and gm ~= 0x13 then return end
  local low = r(0x7E17BB)
  local candidate = value * 0x100 + low
  if candidate ~= snapshotLevel then
    emu.log(string.format("[l3_dump] LOAD_SNAP gameMode=%02X $000F:=%d $17BB=%02X -> $%03x",
      gm, value, low, candidate))
    snapshotLevel = candidate
  end
end
emu.addMemoryCallback(onFWrite, emu.callbackType.write, 0x7E000F)

emu.log(string.format("[l3_dump] ready -- HUD row 30 -- auto-snapshot on level entry -- vramMem=%s wramMem=%s writeTrace=%s sublevelSnap=ON",
  VRAM_MEM == nil and "<UNRESOLVED>" or tostring(VRAM_MEM),
  WRAM_MEM == nil and "<UNRESOLVED>" or tostring(WRAM_MEM),
  writeCallbackOk and "ON" or "<UNAVAILABLE>"))
