-- Mesen 2 Lua: Layer 2 ground-truth recorder.
--
-- Designed to run alongside `l1_dump.lua` (L1 fixture pipeline) and
-- `l3_dump.lua`. Mesen 2 supports multiple loaded scripts simultaneously and
-- frame numbers are emulator-global, so frame N in this script's CSV refers
-- to the same emulator frame as the L1/L3 dumps.
--
-- HUD row convention (avoid overlapping other capture scripts):
--   l1_dump.lua → top of screen (existing)
--   l2_dump.lua     → row Y=20  ← THIS SCRIPT
--   l3_dump.lua     → row Y=30
--
-- Outputs (under the same OneDrive `maps/<id>/` folder as L1 dumps):
--   <id>/l2_scroll.csv     per-frame snapshot of EVERY scroll-related
--                          WRAM byte (L1/L2 positions, ScrollType/Timer/
--                          Speed/Dir, NextLayer1/2 X/Y, ScreenShakeY,
--                          PlayerY, HorizLayer2Setting, VertLayer2Setting,
--                          ScrollLayerIndex). Used as ground truth to
--                          validate the TS port of CODE_05C04D + the
--                          per-cmd handlers + UpdateScreenPosition.
--   <id>/l2_tilemap.bin    1024 bytes of Layer2TilemapLow, captured once
--                          on level-entry (matches l1_dump workflow — no
--                          manual hotkey)
--   <id>/l2_tilemap.json   sidecar describing the slice
--
-- Controls: none. Capture starts when game-mode hits $14 (Level play) and
-- closes when it leaves. Same convention as l1_dump.lua.
--
-- ROM addresses (verified against C:\Projects\SMWDisX\rammap.asm):
--   Layer2XPos       = $7E:001E   (rammap.asm:166)
--   Layer2YPos       = $7E:0020   (rammap.asm:172)
--   Layer2ScrollCmd  = $7E:143F   (rammap.asm:1567 / SMW_U.sym:9589) — runtime
--                                  index into the scroll-routine dispatch
--                                  table at bank_05.asm:4551-4565. Set by the
--                                  L1 sprite stream's scroll-sprite spawn
--                                  ($E7..$F7) at level entry.
--   Layer2TilemapLow = $7E:B900   (rammap.asm:2094, derived: $7E2000 +
--                                  MarioGraphics(23808=$5D00) +
--                                  AnimatedTiles(15360=$3C00) = $7EB900)
--
-- Workflow:
--   1. Load this in Mesen's Script window alongside l1_dump.lua.
--   2. Enter a level. Per-frame CSV starts on game-mode → $14.
--   3. Optional: hit F2 to snapshot the L2 tilemap once positioned.
--   4. Leaving the level closes the CSV. Re-entering opens a new file.

-- is created on demand so L1/L2/L3 artifacts for the same level live in
-- one place.
-- Fixture root for the captures, which are ROM-derived and therefore never
-- committed: they live in OneDrive, outside the repo, like the ROM corpus and
-- the emulator. Spelled from the environment rather than one developer's
-- drive letter; HACKBENCH_FIXTURES_DIR is the same override the TypeScript
-- side reads (test/suite/unit/fixtures/loadMesenFixture.ts).
local DUMPS_DIR = os.getenv("HACKBENCH_FIXTURES_DIR")
  or ((os.getenv("USERPROFILE") or os.getenv("HOME") or ".") .. "/OneDrive/hackbench-fixtures/maps")
local HUD_ROW   = 20  -- HUD-row convention (see header)

local MEM = emu.memType.snesMemory
-- WRAM-direct memType (mirrors Mesen Memory Viewer "Work RAM" view). Some
-- rapidly-changing values may differ between snesMemory bus reads at
-- endFrame and the live WRAM state — capturing both lets us spot the gap.
local WRAM_MEM = nil
for _, name in ipairs({ "snesWorkRam", "snesWorkRAM", "workRam", "wram" }) do
  local v = emu.memType[name]
  if v ~= nil then WRAM_MEM = v; break end
end

local function r(addr) return emu.read(addr, MEM) end
local function rWramByte(addr)
  if WRAM_MEM == nil then return r(addr) end
  return emu.read(addr - 0x7E0000, WRAM_MEM)
end
local function rWramWord(addr)
  if WRAM_MEM == nil then return r(addr) + r(addr+1)*256 end
  local off = addr - 0x7E0000
  return emu.read(off, WRAM_MEM) + emu.read(off + 1, WRAM_MEM) * 256
end

-- ── Address constants ─────────────────────────────────────────────────────
local LAYER1_XPOS_LO  = 0x7E001A   -- camera X (rammap.asm)
local LAYER1_YPOS_LO  = 0x7E001C   -- camera Y (rammap.asm:160)
local LAYER2_XPOS_LO  = 0x7E001E
local LAYER2_YPOS_LO  = 0x7E0020
local LAYER2_SCROLL_CMD  = 0x7E143F -- dispatch index, bank_05.asm:4551-4565
local LAYER2_SCROLL_BITS = 0x7E1441 -- bits 5:2 of scroll sprite b0, set by setup
local LAYER2_TILEMAP  = 0x7EB900   -- 1024 bytes
local LAYER2_TILEMAP_BYTES = 1024

-- ── Full scroll-state addresses (SMW_U.sym) ──────────────────────────────
-- All addresses verified against C:\Projects\SMWDisX\SMW_U.sym lines 9344+.
-- Captured per-frame in CSV alongside L1/L2 positions so the TS port of
-- CODE_05C04D + UpdateScreenPosition can be validated frame-for-frame.
local LAYER1_SCROLL_CMD     = 0x7E143E
local LAYER1_SCROLL_BITS    = 0x7E1440
local LAYER1_SCROLL_TYPE    = 0x7E1442
local LAYER2_SCROLL_TYPE    = 0x7E1443
local LAYER1_SCROLL_TIMER   = 0x7E1444
local LAYER2_SCROLL_TIMER   = 0x7E1445
local LAYER1_SCROLL_X_SPEED = 0x7E1446  -- 16-bit signed
local LAYER1_SCROLL_Y_SPEED = 0x7E1448  -- 16-bit signed
local LAYER2_SCROLL_X_SPEED = 0x7E144A
local LAYER2_SCROLL_Y_SPEED = 0x7E144C
local LAYER1_SCROLL_X_UPD   = 0x7E144E  -- 16-bit fractional accumulator
local LAYER1_SCROLL_Y_UPD   = 0x7E1450
local LAYER2_SCROLL_X_UPD   = 0x7E1452
local LAYER2_SCROLL_Y_UPD   = 0x7E1454
local SCROLL_LAYER_INDEX    = 0x7E1456  -- 0=L1, 4=L2 alternation
local NEXT_LAYER1_XPOS      = 0x7E1462  -- 16-bit
local NEXT_LAYER1_YPOS      = 0x7E1464
local NEXT_LAYER2_XPOS      = 0x7E1466
local NEXT_LAYER2_YPOS      = 0x7E1468
local LAYER1_SCROLL_DIR     = 0x7E0055
local SCREEN_SHAKE_Y        = 0x7E1888  -- 16-bit
local PLAYER_X_POS_NEXT     = 0x7E0094  -- 16-bit (Mario's projected X)
local PLAYER_Y_POS_NEXT     = 0x7E0096  -- 16-bit (Mario's projected Y)
local HORIZ_LAYER2_SETTING  = 0x7E1413
local VERT_LAYER2_SETTING   = 0x7E1414

local TRANSLEVEL_LO   = 0x7E13BF
local TRANSLEVEL_HI   = 0x7E13C0
local L1PTR_LO        = 0x7E0065
local L1PTR_HI        = 0x7E0066
local L1PTR_BK        = 0x7E0067
local GAME_MODE       = 0x7E0100
local GM_LEVEL        = 0x14

-- ── Helpers ──────────────────────────────────────────────────────────────
local function readWord(loAddr) return r(loAddr) + r(loAddr + 1) * 256 end

-- ── Sublevel-aware level-id detection (ported from l1_dump.lua) ─────────
--
-- Pipe-entered sublevels don't update TranslevelNo ($7E:13BF) — that byte
-- only changes on overworld entry. Two layered fallbacks catch sublevels:
--
-- 1. SNAPSHOT: bank_05.asm:7110/7226 commits the 9-bit level index by
--    writing 0|1 to $7E:000F (high bit) right after $7E:17BB gets the low
--    byte. A memory-write callback below captures the pair when the
--    write happens during load modes ($0F/$11/$12/$13). Most authoritative,
--    but only fires AFTER a level transition observed during this script
--    session — does nothing if the script is loaded while already inside
--    a sublevel.
--
-- 2. L1PTR CACHE: Build a reverse-lookup table mapping each level's L1
--    object-stream end-pointer (the $FF byte address) to its level-id.
--    During gameplay, $7E:0065-67 (`Layer1DataPtr`) sits at exactly that
--    end-pointer. Subtlety: the level loader REUSES the pointer for L2
--    object-stream parsing (bank_05.asm:424-470), so for L2-object-stream
--    levels we cache L2's end-pointer instead of L1's.
--
-- 3. Translevel fallback: $7E:13BF — only correct for the first room.
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
  local built, failed = 0, 0
  for i = 0, LEVEL_COUNT - 1 do
    local l1Start, _      = readPtr(L1_PTR_TABLE, i)
    local l2Start, l2Bank = readPtr(L2_PTR_TABLE, i)
    local endAddr
    if l2Bank == 0xFF or l2Bank == 0 then
      endAddr = walkObjStreamEnd(l1Start)
    else
      endAddr = walkObjStreamEnd(l2Start)
    end
    if endAddr ~= nil then
      if mapCache[endAddr] == nil then
        mapCache[endAddr] = i
      end
      built = built + 1
    else
      failed = failed + 1
    end
  end
  -- Diagnostic: log a few key entries and totals so we can see whether the
  -- cache built at all and resolved $00E / $0DC correctly.
  emu.log(string.format("[l2_dump] cache built  entries=%d  failed=%d", built, failed))
  for _, lvl in ipairs({0x00E, 0x0DC, 0x009, 0x111}) do
    local l1Start, _      = readPtr(L1_PTR_TABLE, lvl)
    local l2Start, l2Bank = readPtr(L2_PTR_TABLE, lvl)
    local endAddr
    if l2Bank == 0xFF or l2Bank == 0 then endAddr = walkObjStreamEnd(l1Start)
    else endAddr = walkObjStreamEnd(l2Start) end
    emu.log(string.format("[l2_dump]   $%03X  end=%s  cache[end]=%s",
      lvl,
      endAddr and string.format("$%06X", endAddr) or "nil",
      endAddr and (mapCache[endAddr] and string.format("$%03X", mapCache[endAddr]) or "<miss>") or "n/a"))
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

-- Diagnostic: returns a string showing what each detection layer resolved.
-- Called at file-open time to log the chosen source.
local function currentMapIdSources()
  local snap = snapshotLevel
  local l1c  = currentLevelByL1Ptr()
  local tl   = currentLevelByTranslevel()
  local lo   = r(L1PTR_LO); local hi = r(L1PTR_HI); local bank = r(L1PTR_BK)
  return string.format(
    "snap=%s cache=%s tl=%s liveL1Ptr=$%06X",
    snap and string.format("$%03X", snap) or "nil",
    l1c  and string.format("$%03X", l1c)  or "nil",
    tl   and string.format("$%03X", tl)   or "nil",
    bank * 0x10000 + hi * 0x100 + lo)
end

local function mapIdStr(id)
  if id < 0x1000 then return string.format("%03x", id) end
  return string.format("p%06x", id)  -- "p" prefix marks a raw L1Ptr fallback
end

-- ── State ────────────────────────────────────────────────────────────────
local csvFile        = nil
local currentMap     = nil
local frame          = 0
local framesInLevel  = 0
local snapshotFlash  = 0   -- frames left to flash "saved tilemap" message

local function levelDir(id) return DUMPS_DIR .. "/" .. mapIdStr(id) end
local function ensureDir(dir)
  pcall(os.execute, string.format('if not exist "%s" mkdir "%s"',
    dir:gsub("/", "\\"), dir:gsub("/", "\\")))
end
local function csvPath(id)  return levelDir(id) .. "/l2_scroll.csv" end
local function binPath(id)  return levelDir(id) .. "/l2_tilemap.bin" end
local function jsonPath(id) return levelDir(id) .. "/l2_tilemap.json" end

local function openCsv(id)
  if csvFile then csvFile:close() end
  ensureDir(levelDir(id))
  local f, err = io.open(csvPath(id), "w")
  if not f then
    emu.log(string.format("[l2_dump] failed to open %s: %s", csvPath(id), tostring(err)))
    csvFile = nil
    return
  end
  -- CSV columns:
  --   frame              level-frame counter (1-based)
  --   l1x,l1y            Layer1XPos / Layer1YPos (camera, 16-bit pixels)
  --   l2x,l2y            Layer2XPos / Layer2YPos (BG2 viewport, 16-bit pixels)
  --   l2y_wram           Layer2YPos via WRAM-direct read (cross-check)
  --   l2y_lastWrite      Most recent CPU write to $7E:0020
  --   l2y_writeCount     Total writes to $7E:0020 since script load
  --   l1cmd,l2cmd        Scroll cmds at $143E/$143F
  --   l1bits,l2bits      Scroll bits at $1440/$1441
  --   l1type,l2type      Layer{1,2}ScrollType (parallax-table index)
  --   l1timer,l2timer    Layer{1,2}ScrollTimer (countdown)
  --   l1xspd,l1yspd      Layer1Scroll{X,Y}Speed (16-bit signed accumulators)
  --   l2xspd,l2yspd      Layer2Scroll{X,Y}Speed
  --   l1xupd,l1yupd      Layer1Scroll{X,Y}PosUpd (fractional carry)
  --   l2xupd,l2yupd      Layer2Scroll{X,Y}PosUpd
  --   nl1x,nl1y,nl2x,nl2y NextLayer{1,2}{X,Y}Pos (target positions)
  --   l1dir              Layer1ScrollDir (0=neg, 2=pos)
  --   shakeY             ScreenShakeYOffset
  --   marioX,marioY      PlayerXPosNext / PlayerYPosNext (Mario's projected)
  --   horizL2,vertL2     Per-level parallax settings ($1413/$1414)
  --   scrollIdx          ScrollLayerIndex (0=L1, 4=L2)
  f:write("frame,l1x,l1y,l2x,l2y,l2y_wram,l2y_lastWrite,l2y_writeCount" ..
    ",l1cmd,l2cmd,l1bits,l2bits,l1type,l2type,l1timer,l2timer" ..
    ",l1xspd,l1yspd,l2xspd,l2yspd,l1xupd,l1yupd,l2xupd,l2yupd" ..
    ",nl1x,nl1y,nl2x,nl2y,l1dir,shakeY,marioX,marioY,horizL2,vertL2,scrollIdx\n")
  csvFile = f
  framesInLevel = 0
  emu.log(string.format("[l2_dump] opened %s  (%s)", csvPath(id), currentMapIdSources()))
end

local function closeCsv()
  if csvFile then
    csvFile:close()
    csvFile = nil
  end
end

local function snapshotTilemap(id)
  -- Read 1024 bytes of Layer2TilemapLow as raw binary.
  local bytes = {}
  for i = 0, LAYER2_TILEMAP_BYTES - 1 do
    bytes[i + 1] = string.char(r(LAYER2_TILEMAP + i))
  end
  local bin = io.open(binPath(id), "wb")
  if not bin then
    emu.log(string.format("[l2_dump] failed to open %s for write", binPath(id)))
    return false
  end
  bin:write(table.concat(bytes))
  bin:close()

  local jsn = io.open(jsonPath(id), "w")
  if jsn then
    jsn:write(string.format(
      '{"map":"$%s","source":"Layer2TilemapLow","snesAddr":"$7E:B900",' ..
      '"bytes":%d,"frame":%d,"l2x":%d,"l2y":%d,"note":"32x32 BG2 Map16-low byte grid"}\n',
      mapIdStr(id), LAYER2_TILEMAP_BYTES, framesInLevel,
      readWord(LAYER2_XPOS_LO), readWord(LAYER2_YPOS_LO)))
    jsn:close()
  end
  emu.log(string.format("[l2_dump] snapshot saved: %s", binPath(id)))
  return true
end

-- ── HUD ──────────────────────────────────────────────────────────────────
local COLOR_ON   = 0x88FFAA  -- soft green = capturing
local COLOR_IDLE = 0x808080  -- grey = waiting / not in level
local COLOR_FLASH = 0xFFEE66  -- yellow = snapshot just saved

local function drawHud()
  local gm = r(GAME_MODE)
  local inLevel = (gm == GM_LEVEL) and (csvFile ~= nil)
  local mapStr  = currentMap and mapIdStr(currentMap) or "----"
  local color, msg
  if snapshotFlash > 0 then
    color = COLOR_FLASH
    msg = string.format("[L2] map $%s -- saved tilemap", mapStr)
    snapshotFlash = snapshotFlash - 1
  elseif inLevel then
    color = COLOR_ON
    msg = string.format("[L2] map $%s -- cap on (frame %d)", mapStr, framesInLevel)
  else
    color = COLOR_IDLE
    msg = "[L2] idle (waiting for level)"
  end
  emu.drawString(8, HUD_ROW, msg, color, 0x000000)
  -- Live read of $7E:0020 alongside emu.read at endFrame, so the user can
  -- compare against Mesen's Memory Viewer at the same instant.
  if inLevel then
    local liveL2Y = readWord(LAYER2_YPOS_LO)
    emu.drawString(8, HUD_ROW + 30, string.format(
      "[L2] Lua: l2y=$%02X writes=%d  (compare to Mem Viewer @\\$7E:0020)",
      liveL2Y, _G.l2yWriteCount or 0),
      0xFFFFAA, 0x000000)
  end
end

-- ── Main loop ────────────────────────────────────────────────────────────
local function onFrame()
  frame = frame + 1
  local gm = r(GAME_MODE)

  if gm == GM_LEVEL then
    -- Resolve with cache-first ordering. GenerateTile (bank_00.asm:7179)
    -- clobbers Layer1DataPtr ($7E:0065-67) to a scratch address whenever
    -- Mario hits an interactive block (on/off, P-switch, ?-block...),
    -- causing the L1Ptr cache to miss for ~1 frame. snapshot can also be
    -- stale across pipe transitions if the level-load $7E:000F write
    -- happens at a gameMode our filter rejects. TranslevelNo always
    -- returns the parent OW map -- wrong for sublevels.
    --
    -- Policy: only OPEN/SWITCH files when the live cache resolves
    -- (cache != nil). The transient block-hit miss leaves the previously
    -- open file untouched; the cache comes back next frame. Translevel
    -- is allowed only as the seed value for the very first file.
    local cache = currentLevelByL1Ptr()
    local snap  = snapshotLevel
    local tl    = currentLevelByTranslevel()
    local id    = cache or snap or tl
        or (r(L1PTR_BK) * 0x10000 + r(L1PTR_HI) * 0x100 + r(L1PTR_LO))
    local entered = (csvFile == nil) or (id ~= currentMap)
    if entered and (cache ~= nil or csvFile == nil) then
      currentMap = id
      openCsv(id)
      -- Snapshot the L2 tilemap once on level-entry. Wait one frame so the
      -- game-mode-$14 transition completes its tilemap setup before we
      -- read; in practice the tilemap is ready as of the first $14 frame
      -- but a small flash here gives visual feedback regardless.
      if snapshotTilemap(currentMap) then snapshotFlash = 60 end
    end
    if csvFile then
      framesInLevel = framesInLevel + 1
      -- Per-frame snapshot of every scroll-related WRAM byte the simulator
      -- needs for frame-by-frame validation. Order matches the CSV header
      -- in openCsv().
      csvFile:write(string.format(
        "%d," ..  -- frame
        "%d,%d,%d,%d," ..  -- l1x,l1y,l2x,l2y
        "%d,%d,%d," ..  -- l2y_wram,l2y_lastWrite,l2y_writeCount
        "%d,%d,%d,%d," ..  -- l1cmd,l2cmd,l1bits,l2bits
        "%d,%d,%d,%d," ..  -- l1type,l2type,l1timer,l2timer
        "%d,%d,%d,%d," ..  -- l1xspd,l1yspd,l2xspd,l2yspd
        "%d,%d,%d,%d," ..  -- l1xupd,l1yupd,l2xupd,l2yupd
        "%d,%d,%d,%d," ..  -- nl1x,nl1y,nl2x,nl2y
        "%d,%d,%d,%d," ..  -- l1dir,shakeY,marioX,marioY
        "%d,%d,%d\n",      -- horizL2,vertL2,scrollIdx
        framesInLevel,
        readWord(LAYER1_XPOS_LO), readWord(LAYER1_YPOS_LO),
        readWord(LAYER2_XPOS_LO), readWord(LAYER2_YPOS_LO),
        rWramWord(LAYER2_YPOS_LO), _G.lastL2YWrite, _G.l2yWriteCount,
        r(LAYER1_SCROLL_CMD), r(LAYER2_SCROLL_CMD),
        r(LAYER1_SCROLL_BITS), r(LAYER2_SCROLL_BITS),
        r(LAYER1_SCROLL_TYPE), r(LAYER2_SCROLL_TYPE),
        r(LAYER1_SCROLL_TIMER), r(LAYER2_SCROLL_TIMER),
        readWord(LAYER1_SCROLL_X_SPEED), readWord(LAYER1_SCROLL_Y_SPEED),
        readWord(LAYER2_SCROLL_X_SPEED), readWord(LAYER2_SCROLL_Y_SPEED),
        readWord(LAYER1_SCROLL_X_UPD),   readWord(LAYER1_SCROLL_Y_UPD),
        readWord(LAYER2_SCROLL_X_UPD),   readWord(LAYER2_SCROLL_Y_UPD),
        readWord(NEXT_LAYER1_XPOS), readWord(NEXT_LAYER1_YPOS),
        readWord(NEXT_LAYER2_XPOS), readWord(NEXT_LAYER2_YPOS),
        r(LAYER1_SCROLL_DIR), readWord(SCREEN_SHAKE_Y),
        readWord(PLAYER_X_POS_NEXT), readWord(PLAYER_Y_POS_NEXT),
        r(HORIZ_LAYER2_SETTING), r(VERT_LAYER2_SETTING),
        r(SCROLL_LAYER_INDEX)))
    end
  else
    -- Left the level: close the CSV so the next entry opens a fresh one.
    if csvFile ~= nil then
      emu.log(string.format("[l2_dump] closed (gameMode=%02X)", gm))
      closeCsv()
      currentMap = nil
    end
  end

  drawHud()
end

emu.addEventCallback(onFrame, emu.eventType.endFrame)

-- ── Write trace on $7E:0020 (Layer2YPos low byte) ────────────────────────
-- Mirror of l3_dump's tide diagnostic. Captures every CPU write to
-- $7E:0020 along with the value, surfaced in the per-frame CSV.
_G.lastL2YWrite  = -1
_G.l2yWriteCount = 0
local writeCallbackOk = false
local function onLayer2YPosWrite(addr, value)
  _G.lastL2YWrite = value
  _G.l2yWriteCount = _G.l2yWriteCount + 1
end
local writeCallbackTypes = {
  emu.callbackType and emu.callbackType.cpuWrite,
  emu.callbackType and emu.callbackType.write,
  emu.memCallbackType and emu.memCallbackType.cpuWrite,
  emu.memCallbackType and emu.memCallbackType.write,
}
for _, t in ipairs(writeCallbackTypes) do
  if t ~= nil then
    local ok = pcall(emu.addMemoryCallback, onLayer2YPosWrite, t, 0x7E0020)
    if ok then writeCallbackOk = true; break end
  end
end

-- ── Sublevel snapshot via $7E:000F write trace ──────────────────────────
-- Catches pipe-entered sublevels that TranslevelNo doesn't track. See the
-- comment block on `currentMapId` for the rationale.
--
-- Uses emu.callbackType.write directly (matching l1_dump). The pcall-loop
-- pattern used for the $7E:0020 trace above silently fails to register on
-- the current Mesen 2 build — verified via the existing l2y_writeCount
-- staying at 0 across captures. Direct registration is what works.
local function onFWrite(_addr, value)
  if value > 1 then return end
  local gm = r(0x7E0100)
  if gm ~= 0x0F and gm ~= 0x11 and gm ~= 0x12 and gm ~= 0x13 then return end
  local low = r(0x7E17BB)
  local candidate = value * 0x100 + low
  if candidate ~= snapshotLevel then
    emu.log(string.format("[l2_dump] LOAD_SNAP gameMode=%02X $000F:=%d $17BB=%02X -> $%03x",
      gm, value, low, candidate))
    snapshotLevel = candidate
  end
end
emu.addMemoryCallback(onFWrite, emu.callbackType.write, 0x7E000F)

emu.log(string.format("[l2_dump] ready -- HUD row 20 -- auto-snapshot on level entry -- wramMem=%s writeTrace=%s sublevelSnap=ON",
  WRAM_MEM == nil and "<UNRESOLVED>" or tostring(WRAM_MEM),
  writeCallbackOk and "ON" or "<UNAVAILABLE>"))
