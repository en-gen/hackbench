-- Mesen 2 Lua: Map16 fixture recorder with a Space-toggled auto-scroll.
--
-- Two modes:
--   NORMAL       (default on every level entry) -- completely hands off.
--                SMW physics + the SNES controller drive Mario as usual.
--                The script just dumps the Map16 tilemap around Mario's
--                column every tick so manual playthroughs are captured.
--   AUTO-SCROLL  (Space-toggled)                -- Mario is snapped to the
--                top of the screen (floatY) and his X position advances
--                STEP_PIXELS per frame. Arrow keys nudge Mario's X/floatY.
--                Dumps continue at the same tick rate.
--
-- Controls:
--   Space        -- toggle NORMAL <-> AUTO-SCROLL.
--                   Toggling ON snaps Mario to FLOAT_Y_PX immediately and
--                   every frame thereafter. Toggling OFF releases physics.
--   Right/Left   -- (AUTO-SCROLL only) nudge Mario's X by NUDGE_PX/frame.
--   Up/Down      -- (AUTO-SCROLL only) move the floatY clamp target up/down.
--
-- Workflow:
--   1. Enter a level from the overworld. Script sees gameMode=$14 and opens
--      test/fixtures/maps/<hhh>/dumps.txt in write mode.
--   2. If the level has a tricky intro, play it manually. When you're ready
--      to cruise, tap Space. Mario snaps up, auto-walk begins.
--   3. Tap Space again to take over manually (e.g. to enter a pipe).
--   4. Reaching the overworld wipes the per-level flags so the next visit
--      re-opens its dumps.txt fresh.
--
-- Horizontal levels only. Vertical levels (header levelMode bit) need a
-- different scroll strategy.

local DUMPS_DIR = "C:/Users/engenb/OneDrive/hackbench-fixtures/maps"
local TICK_FRAMES = 20    -- dump every 1/3s; Mario covers 80px (5 cols) in AUTO-SCROLL between dumps.
local STEP_PIXELS = 4     -- AUTO-SCROLL speed (~Mario running, 240 px/s = 15 cols/s).
local FLOAT_Y_PX  = 0x20  -- Mario's Y when AUTO-SCROLL clamps him. Row 2-ish; adjust with Up/Down.
local NUDGE_PX    = 1     -- AUTO-SCROLL arrow-key nudge amount, per frame held.

local LEFT_PAD   = 8
local RIGHT_PAD  = 20
local ROW_LO     = 0
local ROW_HI     = 26
local BYTES_PER_SCREEN = 0x1B0
local BYTES_PER_ROW    = 0x10

local MEM = emu.memType.snesMemory
local function r(addr)        return emu.read(addr, MEM) end
local function w(addr, val)   emu.write(addr, val, MEM) end

local MARIO_X_LO = 0x7E0094
local MARIO_X_HI = 0x7E0095
local MARIO_Y_LO = 0x7E0096
local MARIO_Y_HI = 0x7E0097
local MARIO_VX   = 0x7E007B   -- X velocity, signed 8-bit
local MARIO_VY   = 0x7E007D   -- Y velocity, signed 8-bit

local function marioX()      return r(MARIO_X_LO) + r(MARIO_X_HI) * 256 end
local function marioY()      return r(MARIO_Y_LO) + r(MARIO_Y_HI) * 256 end
local function setMarioX(x)  w(MARIO_X_LO, x % 256); w(MARIO_X_HI, (x // 256) % 256) end
local function setMarioY(y)  w(MARIO_Y_LO, y % 256); w(MARIO_Y_HI, (y // 256) % 256) end

-- Main-level detection via TranslevelNo at $7E:13BF. The game writes this
-- from OWLayer1Translevel whenever the player enters a level from the
-- overworld (bank_05.asm CODE_05D8A2 line 7214). Pipe-entered sublevels
-- do NOT touch $13BF — sublevel detection uses the L1Ptr cache below.
--
-- Mapping per CODE_05D8A2 lines 7217-7226:
--     if TL >= $25: map-id = (TL - $24) | $100   (submap overworld)
--     else:         map-id = TL                  (main overworld)
local function currentLevelByTranslevel()
  local tl = r(0x7E13BF) + r(0x7E13C0) * 256
  if tl == 0 then return nil end
  if tl >= 0x25 then return (tl - 0x24) + 0x100 end
  return tl
end

-- Sublevel detection via Layer1DataPtr reverse-lookup.
--
-- During gameplay, the L1 parser stops AT the $FF terminator, leaving
-- Layer1DataPtr ($7E:0065-0067) pointing AT that $FF. By walking every map
-- in the ROM's L1 pointer table to its own $FF terminator, we can build
-- a cache keyed on the end-pointer. When the player pipes into a sub-area,
-- Layer1DataPtr changes to the new map's end-pointer and the cache gives
-- us its map-id directly.
--
-- Verified: $106 start=$068A2F end=$068BB2 matches live; $1CA start=$068BB3
-- end=$068BDD matches live. 194 unique entries built from the running ROM.
local LEVEL_COUNT = 0x200
local mapCache = nil                 -- [end-pointer] = map-id
local mapCacheBuilt = false

-- Walk L1 stream from startAddr until $FF terminator. Returns the SNES
-- address of the $FF byte itself. Handles both 3-byte objects and 4-byte
-- screen-exit extended objects (extended object with settings == 0).
local function walkL1End(startAddr)
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

local function buildMapCache()
  mapCacheBuilt = true
  mapCache = {}
  local tableBase = 0x05E000
  for i = 0, LEVEL_COUNT - 1 do
    local lo   = r(tableBase + i * 3)     or 0
    local hi   = r(tableBase + i * 3 + 1) or 0
    local bank = r(tableBase + i * 3 + 2) or 0
    local start = bank * 0x10000 + hi * 0x100 + lo
    local endAddr = walkL1End(start)
    if endAddr ~= nil and mapCache[endAddr] == nil then
      mapCache[endAddr] = i
    end
  end
end

-- Look up the current map-id from live Layer1DataPtr. Returns nil if not
-- cached (meaning snesMemory doesn't see this hack's pointer table).
local function currentLevelByL1Ptr()
  if not mapCacheBuilt then buildMapCache() end
  local lo   = r(0x7E0065)
  local hi   = r(0x7E0066)
  local bank = r(0x7E0067)
  local key  = bank * 0x10000 + hi * 0x100 + lo
  return mapCache[key]
end

-- Load-edge snapshot of the 16-bit level index the engine looks up in the
-- Layer 1 pointer table ($05E000). Per bank_05.asm CODE_05D8B7, the engine
-- reads `$7E:000E` as a 16-bit word — (_F << 8) | _E — and multiplies by 3
-- to get the table offset. `_E` (= low byte, also stored at $17BB) and `_F`
-- (= high bit, 0 or 1) are set right before the JSR LoadLevel.
--
-- $000E/$000F are general-purpose scratch RAM that many subroutines reuse
-- during gameplay. To avoid noise we only sample during level-load game
-- modes ($0F/$11/$12/$13) and freeze the value when gameMode returns to
-- $14. This disambiguates sub-areas whose L1 end-pointers collide in the
-- mapCache (e.g. multiple rooms of Donut Ghost House aliasing to $004).
local snapshotLevel = nil   -- last (_F<<8)|_E observed during a load mode

local function currentLevelBySnapshot()
  return snapshotLevel
end

-- Combined map-id detection. Preference order:
--   1. snapshot from $000E/$000F captured during level-load modes — the
--      authoritative 9-bit level index the engine used to pick L1 data.
--      Correct even when the L1 end-ptr cache has collisions.
--   2. L1Ptr reverse-lookup — works live for both main levels and
--      pipe-entered sub-areas, but can false-positive on cache collisions.
--   3. translevel — main overworld only; always stays on the parent map
--      across pipes, so use only as last resort.
local function currentLevel()
  return currentLevelBySnapshot()
      or currentLevelByL1Ptr()
      or currentLevelByTranslevel()
end

-- Folder-safe 3-digit lowercase hex for a map-id.
local function formatLevelId(lvl)
  return string.format("%03x", lvl)
end

-- ── File / session state ──────────────────────────────────────────────────
local file = nil
local writeLine = function(s) emu.log(s) end
local currentFileLevel = -1
local seenLevels = {}   -- [lvl]=true once we've opened its file this session

local function closeCurrentFile(reason)
  if file then
    writeLine(string.format("# pausing (%s)", reason or ""))
    file:flush()
    file:close()
  end
  file = nil
  writeLine = function(s) emu.log(s) end
end

local function openFileForLevel(lvl)
  closeCurrentFile("switching level")
  local hex = formatLevelId(lvl)
  local dir = DUMPS_DIR .. "/" .. hex
  pcall(os.execute, string.format('if not exist "%s" mkdir "%s"',
    dir:gsub("/", "\\"), dir:gsub("/", "\\")))
  local path = dir .. "/dumps.txt"
  local alreadySeen = seenLevels[lvl] or false
  local mode = alreadySeen and "a" or "w"
  local f, err = io.open(path, mode)
  if f then
    file = f
    writeLine = function(s) f:write(s); f:write("\n") end
    local action = alreadySeen and "resumed (append)" or "started (fresh)"
    emu.log(string.format("%s: %s", action, path))
    writeLine(string.format("# %s  level=$%s  mode=%s", action, hex:upper(), mode))
    seenLevels[lvl] = true
    currentFileLevel = lvl
  else
    emu.log("io.open failed for " .. path .. ": " .. tostring(err))
    currentFileLevel = -1
  end
end

-- First file open is lazy inside onFrame. Opening at script start would
-- truncate the last-visited level's dump if the user is on the overworld.

local function tileAt(col, row)
  local screen = col // 16
  local cs     = col % 16
  local off    = screen * BYTES_PER_SCREEN + row * BYTES_PER_ROW + cs
  return ((r(0x7FC800 + off) % 2) * 256) + r(0x7EC800 + off)
end

local tickNum = 0
local function dumpAroundCol(marioCol)
  -- Skip dumping entirely if we have no open file. Otherwise dumps get
  -- routed to emu.log (because writeLine falls back to log on startup),
  -- flooding the Script Window console with tile grids.
  if not file then return end
  tickNum = tickNum + 1
  local lo = math.max(0, marioCol - LEFT_PAD)
  local hi = marioCol + RIGHT_PAD
  writeLine(string.format("=== tick %d  marioCol=%d  range=%d..%d ===", tickNum, marioCol, lo, hi))
  for row = ROW_LO, ROW_HI do
    local line = string.format("r%2d:", row)
    for col = lo, hi do
      local id = tileAt(col, row)
      if id == 0x25 then line = line .. " .  "
      else              line = line .. string.format("%03x ", id) end
    end
    writeLine(line)
  end
  file:flush()
end

-- ── Key input ─────────────────────────────────────────────────────────────
-- Mesen 2's emu.isKeyPressed name format isn't well-documented; try variants.
-- NOTE: Mesen's main window must have keyboard focus — presses in the
-- Script Window don't propagate.
local KEY_VARIANTS = {
  Right = { "Right", "RightArrow", "Right Arrow" },
  Left  = { "Left",  "LeftArrow",  "Left Arrow"  },
  Up    = { "Up",    "UpArrow",    "Up Arrow"    },
  Down  = { "Down",  "DownArrow",  "Down Arrow"  },
  Space = { "Space", "Spacebar", " " },
}
local keyResolved = {}

local function keyPressed(logicalKey)
  local resolved = keyResolved[logicalKey]
  if resolved then
    local ok, v = pcall(emu.isKeyPressed, resolved)
    return ok and v or false
  end
  for _, name in ipairs(KEY_VARIANTS[logicalKey] or {}) do
    local ok, v = pcall(emu.isKeyPressed, name)
    if ok and v then
      keyResolved[logicalKey] = name
      emu.log(string.format("resolved key %s -> %q", logicalKey, name))
      return true
    end
  end
  return false
end

-- ── Mode state ────────────────────────────────────────────────────────────
local autoScroll = false        -- default: hands-off NORMAL mode
local prevSpace  = false
local floatY     = FLOAT_Y_PX   -- AUTO-SCROLL clamp target; Up/Down tweak it
local wasInLevel = false        -- detects re-entry even when the level number repeats

-- ── Sub-area detection diagnostics ────────────────────────────────────────
-- SublevelCount at $7E141A is SMW's own bookkeeping: incremented every
-- time the player enters a sub-area via pipe/door (bank_00.asm:9632 and
-- bank_05.asm:7619 both `INC SublevelCount`). Watching edges on it is the
-- most reliable "just entered a sub-area" signal regardless of whether
-- the L1Ptr cache lookup resolves.
local prevSublevelCount = nil   -- nil on first frame; set to live value
local prevL1Key         = nil

-- Map-ID HUD line shown on every frame. "map" is the umbrella term for
-- both overworld-entered levels and pipe-entered sublevels. Green when we
-- have a file open; yellow when the translevel read returns nothing
-- (title screen / overworld with TL=0). L1Ptr is shown alongside so you
-- can eyeball pipe transitions — during pipes TL stays on the parent map
-- but L1Ptr changes, visible evidence we need separate sublevel detection.
local function drawLevelHud()
  local lvl  = currentLevel()
  local tl   = r(0x7E13BF) + r(0x7E13C0) * 256
  local l1lo = r(0x7E0065)
  local l1hi = r(0x7E0066)
  local l1bk = r(0x7E0067)
  local sub    = r(0x7E141A)
  local lln    = r(0x7E17BB)
  local fileStatus = file and ("file: $" .. string.format("%03x", currentFileLevel) .. " open")
                           or "file: <none>"
  local lvlStr = lvl and ("$" .. string.format("%03x", lvl)) or "?"
  local color  = lvl and 0x00FF88 or 0xFFFF00
  emu.drawString(8, 30, string.format("map=%s  TL=%02X  L1Ptr=%02X:%02X%02X",
    lvlStr, tl, l1bk, l1hi, l1lo), color, 0x000000)
  emu.drawString(8, 40, fileStatus, color, 0x000000)
  local snapStr = snapshotLevel
    and string.format("$%03x", snapshotLevel)
    or "nil"
  emu.drawString(8, 50, string.format("SublevelCount=%02X  $17BB=%02X  snap=%s",
    sub, lln, snapStr), color, 0x000000)
end

-- ── Main loop ─────────────────────────────────────────────────────────────
local frames = 0
local function onFrame()
  frames = frames + 1

  -- Game mode $7E0100 (values from rammap.asm !GameMode_* enum):
  --   14 (0x0E) = overworld     — SKIP (not level play!)
  --   15-19     = fade/load/prepare level — SKIP
  --   20 (0x14) = Level play    — RECORD
  --   21+       = game over / cutscene / etc. — SKIP
  local gameMode = r(0x7E0100)

  -- Edge detectors: log (and surface for debugging) any transition on
  -- SublevelCount ($7E141A) or Layer1DataPtr ($7E:0065-0067). We sample
  -- every frame regardless of gameMode so transitions during level-load
  -- modes ($0F-$13) are captured — that's when the new sub-area's L1Ptr
  -- gets written.
  local sublevelCount = r(0x7E141A)
  local l1Key = r(0x7E0067) * 0x10000 + r(0x7E0066) * 0x100 + r(0x7E0065)
  if prevSublevelCount ~= nil and sublevelCount ~= prevSublevelCount then
    local byL1 = currentLevelByL1Ptr()
    local byTL = currentLevelByTranslevel()
    local snapStr = snapshotLevel and string.format("$%03x", snapshotLevel) or "nil"
    emu.log(string.format(
      "[SUBLVL_EDGE] %d->%d  gameMode=%02X  L1Ptr=$%06X  mapBySnap=%s  mapByL1=%s  mapByTL=%s  $17BB=%02X",
      prevSublevelCount, sublevelCount, gameMode, l1Key, snapStr,
      byL1 and string.format("$%03x", byL1) or "nil",
      byTL and string.format("$%03x", byTL) or "nil",
      r(0x7E17BB)))
  end
  if prevL1Key ~= nil and l1Key ~= prevL1Key then
    local byL1 = currentLevelByL1Ptr()
    emu.log(string.format(
      "[L1_EDGE] $%06X -> $%06X  gameMode=%02X  mapByL1=%s",
      prevL1Key, l1Key, gameMode,
      byL1 and string.format("$%03x", byL1) or "nil"))
  end
  prevSublevelCount = sublevelCount
  prevL1Key = l1Key

  if gameMode ~= 0x14 then
    wasInLevel = false
    -- Overworld fully exits level-chain: wipe per-session state so the next
    -- level visit starts a fresh dumps.txt, and drop back to NORMAL mode so
    -- the user has to re-engage AUTO-SCROLL manually on the next level.
    if gameMode == 0x0E and currentFileLevel ~= -1 then
      closeCurrentFile("reached overworld")
      seenLevels = {}
      currentFileLevel = -1
      autoScroll = false
      snapshotLevel = nil
      emu.log("session reset: overworld, NORMAL mode restored")
    end
    emu.drawString(8, 8, string.format("PAUSED  mode=0x%02x", gameMode), 0xFFFF00, 0x000000)
    drawLevelHud()
    return
  end

  -- Level entry (fresh, re-entry from overworld, or sub-area via pipe):
  -- open a dumps.txt and reset to NORMAL mode. You always re-tap Space to
  -- engage AUTO-SCROLL in the new area, including sub-areas via pipe — that
  -- way a level with a tricky post-pipe intro doesn't auto-walk Mario into
  -- a wall.
  -- Resolve current map-id with confidence tracking. The TranslevelNo
  -- fallback always returns the PARENT overworld map-id, which is WRONG
  -- during sub-area play. SMW also briefly writes sentinel values like
  -- $00BDA8 to Layer1DataPtr during pipe/door entry, causing the L1Ptr
  -- cache to miss mid-play. Without confidence tracking we'd fall through
  -- to TranslevelNo on every sentinel frame and incorrectly switch the
  -- dump file back to the parent map.
  --
  -- Policy: require a high-confidence signal (snapshot or L1Ptr cache hit)
  -- to open or switch files. A TL-only answer is allowed only for the
  -- very first file-open (currentFileLevel == -1) so OW entry still works
  -- if the L1Ptr cache hasn't built yet.
  local snapLevel = currentLevelBySnapshot()
  local l1Level   = currentLevelByL1Ptr()
  local tlLevel   = currentLevelByTranslevel()
  local nowLevel  = snapLevel or l1Level or tlLevel
  local highConfidence = (snapLevel ~= nil) or (l1Level ~= nil)
  local justEntered = not wasInLevel
  wasInLevel = true
  if nowLevel ~= nil and (justEntered or nowLevel ~= currentFileLevel) then
    if highConfidence or currentFileLevel == -1 then
      openFileForLevel(nowLevel)
      autoScroll = false
    end
  end

  -- Space edge-toggle.
  local spaceNow = keyPressed("Space")
  if spaceNow and not prevSpace then
    autoScroll = not autoScroll
    if autoScroll then
      floatY = FLOAT_Y_PX   -- snap clamp target back to sky on engage
    end
    emu.log("AUTO-SCROLL: " .. (autoScroll and "ON" or "OFF"))
  end
  prevSpace = spaceNow

  if not autoScroll then
    -- NORMAL mode: hands off Mario entirely. SMW physics + SNES controller
    -- (which keyboard arrows map to by default in Mesen) drive the game.
    -- Dumps still fire so manual playthroughs get captured.
    emu.drawString(8, 8,  "NORMAL  (tap Space for auto-scroll)", 0xFFFFFF, 0x000000)
    emu.drawString(8, 18, string.format("col=%d  marioY=0x%04x  tick=%d",
      marioX() // 16, marioY(), tickNum), 0xFFFFFF, 0x000000)
    drawLevelHud()
    if frames % TICK_FRAMES == 0 then
      dumpAroundCol(marioX() // 16)
    end
    return
  end

  -- AUTO-SCROLL: arrow-key nudges, clamp-to-floatY, auto-advance X.
  local nudged = false
  if keyPressed("Right") then setMarioX(marioX() + NUDGE_PX); nudged = true end
  if keyPressed("Left")  then setMarioX(math.max(0, marioX() - NUDGE_PX)); nudged = true end
  if keyPressed("Up")    then floatY = math.max(0, floatY - NUDGE_PX); nudged = true end
  if keyPressed("Down")  then floatY = floatY + NUDGE_PX; nudged = true end

  setMarioY(floatY)
  w(MARIO_VX, 0)
  w(MARIO_VY, 0)

  if not nudged then
    setMarioX(marioX() + STEP_PIXELS)
  end

  local marioCol = marioX() // 16
  local remaining = TICK_FRAMES - (frames % TICK_FRAMES)
  local secs = math.ceil(remaining / 60)
  local status = nudged and "NUDGE" or "AUTO"
  emu.drawString(8, 8,  string.format("%s  DUMP IN %ds  (Space to stop)", status, secs), 0x00FF00, 0x000000)
  emu.drawString(8, 18, string.format("col=%d  tick=%d  floatY=0x%02x", marioCol, tickNum, floatY), 0x00FF00, 0x000000)
  drawLevelHud()

  if frames % TICK_FRAMES == 0 then
    dumpAroundCol(marioCol)
  end
end

emu.addEventCallback(onFrame, emu.eventType.endFrame)

-- Memory-write callback on $7E:000F (_F, the high bit of the level index).
-- Per bank_05.asm lines 7110 and 7226, the level-load code writes 0 or 1 to
-- _F right after $17BB gets the low byte. Every OTHER write to _F is scratch
-- noise from unrelated subroutines, so we filter on value <= 1 AND gameMode
-- in load modes. When both hold, read $17BB for the low byte and commit the
-- full 9-bit level index to snapshotLevel.
--
-- This gives us a clean signal at the exact moment SMW commits the level
-- number, eliminating the need for per-frame polling of scratch RAM.
local function onFWrite(address, value)
  if value > 1 then return end
  local gm = r(0x7E0100)
  if gm ~= 0x0F and gm ~= 0x11 and gm ~= 0x12 and gm ~= 0x13 then return end
  local low = r(0x7E17BB)
  local candidate = value * 0x100 + low
  if candidate ~= snapshotLevel then
    emu.log(string.format("[LOAD_SNAP] gameMode=%02X  $000F:=%d  $17BB=%02X  -> $%03x",
      gm, value, low, candidate))
    snapshotLevel = candidate
  end
end
emu.addMemoryCallback(onFWrite, emu.callbackType.write, 0x7E000F)

writeLine(string.format("# auto-walker session start  tick_frames=%d  step=%dpx  float_y=0x%02x",
  TICK_FRAMES, STEP_PIXELS, FLOAT_Y_PX))
if file then file:flush() end
