-- Mesen 2 Lua: Map16 fixture recorder with a Space-toggled auto-scroll.
--
-- Two modes:
--   NORMAL       (default on every level entry) -- completely hands off.
--                SMW physics + the SNES controller drive Mario as usual.
--                The script just dumps the Map16 tilemap around Mario every
--                tick so manual playthroughs are captured.
--   AUTO-SCROLL  (Space-toggled)                -- Mario is snapped along the
--                cross-axis (floatY in horizontal levels, floatX in vertical)
--                and his main-axis position advances STEP_PIXELS per frame.
--                Arrow keys nudge position / adjust the clamp target.
--                Dumps continue at the same tick rate.
--
-- Controls:
--   Space        -- toggle NORMAL <-> AUTO-SCROLL.
--                   Toggling ON snaps Mario to the cross-axis clamp immediately.
--                   Toggling OFF releases physics.
--   Horizontal levels:
--     Right/Left -- (AUTO-SCROLL) nudge Mario's X by NUDGE_PX/frame.
--     Up/Down    -- (AUTO-SCROLL) move the floatY clamp target up/down.
--   Vertical levels:
--     Down/Up    -- (AUTO-SCROLL) nudge Mario's Y by NUDGE_PX/frame.
--     Left/Right -- (AUTO-SCROLL) move the floatX clamp target left/right.
--   (Auto-advance direction is always "forward" along the main axis:
--    +X in horizontal, +Y in vertical — vanilla vertical levels descend.)
--
-- Vertical detection: ScreenMode ($7E005B) bit 0 = Layer 1 vertical
-- (rammap.asm:481, VerticalTable at bank_05.asm:480 stamps this bit per
-- levelMode). Flipping this flag selects the right Map16 memory layout and
-- swaps the dump window to "all 32 cols, rows around Mario".
--
-- Workflow:
--   1. Enter a level from the overworld. Script sees gameMode=$14 and opens
--      test/fixtures/maps/<hhh>/dumps.txt in write mode.
--   2. If the level has a tricky intro, play it manually. When you're ready
--      to cruise, tap Space. Mario snaps to the clamp, auto-walk begins.
--   3. Tap Space again to take over manually (e.g. to enter a pipe).
--   4. Reaching the overworld wipes the per-level flags so the next visit
--      re-opens its dumps.txt fresh.

local DUMPS_DIR = "C:/Users/engenb/OneDrive/hackbench-fixtures/maps"
local TICK_FRAMES = 20    -- dump every 1/3s; Mario covers 80px (5 tiles) in AUTO-SCROLL between dumps.
local STEP_PIXELS = 4     -- AUTO-SCROLL speed (~Mario running, 240 px/s = 15 tiles/s).
local FLOAT_Y_PX  = 0x20  -- Mario's Y when horizontal AUTO-SCROLL clamps him. Row 2-ish; Up/Down tweak.
local FLOAT_X_PX  = 0x80  -- Mario's X when vertical AUTO-SCROLL clamps him. Col 8-ish (middle); Left/Right tweak.
local NUDGE_PX    = 1     -- AUTO-SCROLL arrow-key nudge amount, per frame held.

-- Horizontal dump window: 27 rows × (LEFT_PAD + 1 + RIGHT_PAD) cols around marioCol.
local LEFT_PAD   = 8
local RIGHT_PAD  = 20
local ROW_LO     = 0
local ROW_HI     = 26

-- Vertical dump window: 32 cols (the full level width) × (UP_PAD + 1 + DOWN_PAD) rows around marioRow.
local UP_PAD     = 8
local DOWN_PAD   = 20
local VERT_COLS  = 32

-- Map16 memory layout — separate stride tables per orientation, derived from
-- bank_00.asm:6727+ (DATA_00BAD8 = horizontal, DATA_00BB38 = vertical):
--
--   Horizontal: stride $1B0 per screen, 16 cols × 27 rows, row-major
--       off = row*$10 + (col % 16)
--
--   Vertical:   stride $200 per screen; the screen is TWO 16-wide half-
--       screens concatenated, each row-major. Within a 32×16 screen:
--       off = (col // 16)*$100 + (row % 16)*$10 + (col % 16)
--
--       bank_05.asm:781 does `INC Map16LowPtr+1` (+$100) to jump from the
--       left half to the right half. That's consistent with row-major-halves
--       (skip 256 bytes = skip the entire 16-col left half) and NOT with a
--       single col-major 32×16 screen (which would also skip 256 bytes, but
--       would make the handlers' INY-advance-col actually advance row, and
--       CODE_0585D8's nibble swap then places tiles at a 90°-rotated
--       position from what the extension renders). Verified by trace:
--       b0=0x02 b1=0x13 → post-swap LevelLoadPos = 0x32 = 50, which under
--       row-major-halves = (col=2, row=3) — matching the intended grid.
local BYTES_PER_SCREEN_H  = 0x1B0
local BYTES_PER_ROW_H     = 0x10
local BYTES_PER_SCREEN_V  = 0x200
local BYTES_PER_HALF_V    = 0x100   -- 16 cols × 16 rows per half
local BYTES_PER_ROW_V     = 0x10

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
-- During gameplay, the object parser (bank_05.asm LoadLevelData line 677)
-- stops AT the $FF terminator, leaving Layer1DataPtr ($7E:0065-0067)
-- pointing AT that $FF. But there's a subtlety: after finishing L1, the
-- level loader REUSES Layer1DataPtr for L2 parsing — it copies
-- `Layer2DataPtr + 5` into Layer1DataPtr and jumps back to LoadAgain
-- (bank_05.asm LoadLevel path around line 424-470). So the live end-
-- pointer depends on the level's L2 type:
--
--   L2 preset (L2 bank byte = $FF): game never runs object parsing for
--     L2, so Layer1DataPtr stays at L1's $FF.
--   L2 object stream (bank != $FF): parser re-runs on L2, leaving
--     Layer1DataPtr at L2's $FF instead.
--
-- Missing this branch routes all object-stream-L2 levels to their parent
-- level's folder via the translevel fallback — we saw this with level
-- $0E7 (a vertical sub-area of $007) whose vertical ticks landed in
-- 007/dumps.txt. Fix: cache whichever end-pointer will actually be live.
--
-- Verified: $106 start=$068A2F end=$068BB2 matches live; $1CA start=$068BB3
-- end=$068BDD matches live; $0E7 L2-end=$069F63 now routes to $0E7.
local LEVEL_COUNT = 0x200
local L1_PTR_TABLE = 0x05E000
local L2_PTR_TABLE = 0x05E600
local mapCache = nil                 -- [end-pointer] = map-id
local mapCacheBuilt = false

-- Walk an object stream from startAddr until $FF terminator. Returns the
-- SNES address of the $FF byte itself. Handles both 3-byte objects and
-- 4-byte screen-exit extended objects (extended object with settings == 0).
--
-- `startAddr` is the raw L1/L2 pointer value: the walker adds 5 to skip
-- what the game treats as a header (L1 really has one; L2 doesn't but the
-- game skips 5 bytes anyway via LoadLevel's `ADC #$05`).
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
    local l1Start, _          = readPtr(L1_PTR_TABLE, i)
    local l2Start, l2Bank     = readPtr(L2_PTR_TABLE, i)
    -- Pick the end-pointer the game will actually leave Layer1DataPtr at.
    -- Preset L2 (bank $FF) or unused L2 (bank $00): L1 end wins.
    -- Object-stream L2: L2 end wins (L1 ran first, then got overwritten).
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

-- Entrance-cutscene detection.
--
-- When Mario lands on an overworld tile that triggers a cutscene (ghost
-- house intro, castle intro, no-Yoshi intro), the engine (bank_05.asm
-- CODE_05DA5E) writes the cutscene's Layer-1 stream into the normal
-- Map16 tilemap and sets PlayerAnimation = !PlayerAni_EnterCastle to
-- block player input while Mario is scripted to walk toward the door.
-- That animation ID stays latched for the whole cutscene and clears to
-- !PlayerAni_Default ($00) when the engine hands control back to the
-- player (normal gameplay or the post-cutscene sub-area).
--
-- Keying the skip off PlayerAnimation ($7E0071) catches the full window
-- without the fragility of watching Layer1DataPtr, which GenerateTile
-- (bank_00.asm CODE_00BF46) clobbers to the LoadBlkPtrs scratch address
-- every time Mario's scripted walk touches an interactive block.
--
-- Value $0A = !PlayerAni_EnterCastle covers ghost-house / castle / no-
-- Yoshi entrance intros. Other non-zero PlayerAnimation values (growing,
-- iframes, death, door-enter) are intentionally NOT filtered -- those
-- are transient states during legitimate gameplay and the tilemap
-- content at those frames is still valid.
local PLAYER_ANI_ENTER_CASTLE = 0x0A

local function isInEntranceCutscene()
  return (r(0x7E0071) or 0) == PLAYER_ANI_ENTER_CASTLE
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
-- Cache-first ordering matches the onFrame resolver. The L1Ptr cache
-- reflects live RAM and is the most authoritative signal when it hits;
-- the snapshot can be stale across pipe transitions whose level-load
-- $7E:000F write happens at a gameMode our filter rejects.
local function currentLevel()
  return currentLevelByL1Ptr()
      or currentLevelBySnapshot()
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

-- True when the current level is Layer-1 vertical.
-- ScreenMode ($7E005B) bit 0 is set by LoadLevel via VerticalTable lookup
-- (bank_05.asm:552). We read the live value rather than recomputing from
-- LevelModeSetting so we automatically track sub-area transitions.
local function levelIsVertical()
  return (r(0x7E005B) % 2) == 1
end

local function tileAtHoriz(col, row)
  local screen = col // 16
  local cs     = col % 16
  local off    = screen * BYTES_PER_SCREEN_H + row * BYTES_PER_ROW_H + cs
  return ((r(0x7FC800 + off) % 2) * 256) + r(0x7EC800 + off)
end

local function tileAtVert(col, row)
  local screen   = row // 16
  local rs       = row % 16
  local halfIdx  = col // 16        -- 0 = left half (cols 0-15), 1 = right half (16-31)
  local halfCol  = col % 16
  local off = screen * BYTES_PER_SCREEN_V
           + halfIdx * BYTES_PER_HALF_V
           + rs * BYTES_PER_ROW_V
           + halfCol
  return ((r(0x7FC800 + off) % 2) * 256) + r(0x7EC800 + off)
end

local function tileAt(col, row)
  if levelIsVertical() then return tileAtVert(col, row) end
  return tileAtHoriz(col, row)
end

local tickNum = 0

-- Horizontal dump: LEFT_PAD..RIGHT_PAD cols around marioCol × all 27 rows.
local function dumpAroundCol(marioCol)
  if not file then return end
  if isInEntranceCutscene() then return end
  tickNum = tickNum + 1
  local lo = math.max(0, marioCol - LEFT_PAD)
  local hi = marioCol + RIGHT_PAD
  writeLine(string.format("=== tick %d  marioCol=%d  range=%d..%d ===", tickNum, marioCol, lo, hi))
  for row = ROW_LO, ROW_HI do
    local line = string.format("r%2d:", row)
    for col = lo, hi do
      local id = tileAtHoriz(col, row)
      if id == 0x25 then line = line .. " .  "
      else              line = line .. string.format("%03x ", id) end
    end
    writeLine(line)
  end
  file:flush()
end

-- Vertical dump: all 32 cols (full level width) × UP_PAD..DOWN_PAD rows
-- around marioRow. Row numbers are absolute (0..screens*16-1) so a multi-
-- screen vertical level produces row indices >= 16 naturally. The dump
-- header tags the orientation so downstream consumers know which formula
-- to use when reconstructing (col, row).
local function dumpAroundRow(marioRow)
  if not file then return end
  if isInEntranceCutscene() then return end
  tickNum = tickNum + 1
  local lo = math.max(0, marioRow - UP_PAD)
  local hi = marioRow + DOWN_PAD
  writeLine(string.format("=== tick %d  marioRow=%d  range=%d..%d (VERTICAL) ===", tickNum, marioRow, lo, hi))
  for row = lo, hi do
    local line = string.format("r%3d:", row)
    for col = 0, VERT_COLS - 1 do
      local id = tileAtVert(col, row)
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
local floatY     = FLOAT_Y_PX   -- Horizontal AUTO-SCROLL Y clamp; Up/Down tweak it
local floatX     = FLOAT_X_PX   -- Vertical   AUTO-SCROLL X clamp; Left/Right tweak it
local wasInLevel = false        -- detects re-entry even when the level number repeats
local stableFrames = 0          -- frames spent continuously in gameMode=$14

-- GameMode labels from rammap.asm:982-1021. The important cluster for the
-- auto-walker is the level-transition sequence $0F..$13 and its landing
-- state $14. The full table is included so the HUD shows something sensible
-- in any mode.
local GAMEMODE_NAMES = {
  [0x00] = "LoadPresents",
  [0x01] = "Presents",
  [0x02] = "FadeToTitle",
  [0x03] = "LoadTitle",
  [0x04] = "PrepareTitle",
  [0x05] = "FadeInTitle",
  [0x06] = "SpotlightTitle",
  [0x07] = "TitleScreen",
  [0x08] = "FileSelect",
  [0x09] = "FileDelete",
  [0x0A] = "PlayerSelect",
  [0x0B] = "FadeToOverworld",
  [0x0C] = "LoadOverworld",
  [0x0D] = "FadeInOverworld",
  [0x0E] = "Overworld",
  [0x0F] = "FadeToLevel",
  [0x10] = "FadeLevelBlack",
  [0x11] = "LoadLevel",
  [0x12] = "PrepareLevel",
  [0x13] = "FadeInLevel",
  [0x14] = "Level",
  [0x15] = "FadeToGameOver",
  [0x16] = "LoadGameOver",
  [0x17] = "GameOver",
  [0x18] = "FadeToCutscene",
  [0x19] = "LoadCutscene",
  [0x1A] = "FadeInCutscene",
  [0x1B] = "Cutscene",
}
local function gameModeLabel(m)
  return GAMEMODE_NAMES[m] or "?"
end

-- ── Sub-area detection diagnostics ────────────────────────────────────────
-- SublevelCount at $7E141A is SMW's own bookkeeping: incremented every
-- time the player enters a sub-area via pipe/door (bank_00.asm:9632 and
-- bank_05.asm:7619 both `INC SublevelCount`). Watching edges on it is the
-- most reliable "just entered a sub-area" signal regardless of whether
-- the L1Ptr cache lookup resolves.
local prevSublevelCount = nil   -- nil on first frame; set to live value
local prevL1Key         = nil

-- Compact single-line HUD aligned with l2_dump.lua (row Y=20) and
-- l3_dump.lua (row Y=30). Reserves row Y=10 for L1.
--
-- States:
--   idle (gameMode != $14)         -- "[L1] idle (gameMode=XX)"
--   level NORMAL                    -- "[L1] map $XXX -- normal (stable N)"
--   level AUTO-SCROLL / NUDGE       -- "[L1] map $XXX -- auto-scroll col=C tick=T"
--
-- Detailed debug (game mode label, full L1Ptr, SublevelCount, snap, etc.)
-- moved to emu.log edge events. Open Mesen's Script log window if you need
-- to trace pipe / sub-area transitions.
local COLOR_ON_L1     = 0x88FFAA  -- soft green = capturing (matches l2/l3)
local COLOR_IDLE_L1   = 0x808080  -- grey
local COLOR_AUTO_L1   = 0x66FFEE  -- cyan = auto-scrolling
local HUD_ROW_L1      = 10

local function drawL1Hud(state, extra)
  local color, msg
  if state == "idle" then
    local gm = r(0x7E0100)
    color = COLOR_IDLE_L1
    msg = string.format("[L1] idle (gameMode=%02X)", gm)
  else
    -- Prefer the file-locked level: it's stable across transient cache
    -- misses (block hits clobber Layer1DataPtr for ~1 frame), so the HUD
    -- doesn't flicker to the parent OW level when the player hits a block.
    local lvl    = (currentFileLevel ~= -1 and currentFileLevel) or currentLevel()
    local lvlStr = lvl and string.format("%03x", lvl) or "----"
    if state == "normal" then
      color = COLOR_ON_L1
      msg = string.format("[L1] map $%s -- normal %s", lvlStr, extra or "")
    else  -- auto-scroll / nudge
      color = COLOR_AUTO_L1
      msg = string.format("[L1] map $%s -- %s %s", lvlStr, state, extra or "")
    end
  end
  emu.drawString(8, HUD_ROW_L1, msg, color, 0x000000)
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
    -- Edge log: we were stable in level play last frame; now we're not.
    -- This marks the START of a transition (pipe, door, death, exit).
    if wasInLevel then
      emu.log(string.format(
        "[STABLE_EDGE] stable->transition  gameMode=%02X %s  afterFrames=%d  currentFile=%s",
        gameMode, gameModeLabel(gameMode), stableFrames,
        currentFileLevel == -1 and "<none>" or string.format("$%03x", currentFileLevel)))
    end
    wasInLevel = false
    stableFrames = 0
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
    drawL1Hud("idle")
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
  -- $00BDA8 to Layer1DataPtr during pipe/door entry (GenerateTile in
  -- bank_00.asm:7179 overwrites $7E0065-0067 with the LoadBlkPtrs scratch
  -- address when Mario hits any interactive block), causing the L1Ptr cache
  -- to miss mid-play.
  --
  -- Policy: require a high-confidence signal (snapshot or L1Ptr cache hit)
  -- to open or switch files. A TL-only answer is allowed only for the very
  -- first file-open (currentFileLevel == -1) so overworld entry still works
  -- if the L1Ptr cache hasn't built yet.
  --
  -- Cache-first ordering: live $7E:0065-67 reverse-lookup is the primary
  -- signal because the snapshot can be stale (callback's gameMode filter
  -- can miss writes during pipe transitions, leaving snap pinned to the
  -- previous level). When the cache hits, it agrees with reality;
  -- snapshot is only consulted when cache misses transiently. File
  -- switches require cache hit -- block-hit Layer1DataPtr clobber
  -- (GenerateTile, bank_00.asm:7179) leaves the existing file untouched.
  local l1Level   = currentLevelByL1Ptr()
  local snapLevel = currentLevelBySnapshot()
  local tlLevel   = currentLevelByTranslevel()
  local nowLevel  = l1Level or snapLevel or tlLevel
  local highConfidence = l1Level ~= nil
  local justEntered = not wasInLevel
  wasInLevel = true
  stableFrames = stableFrames + 1
  if justEntered then
    -- Edge log: transition just finished. Record which signal resolved
    -- the level-id (L1Ptr cache > snapshot > translevel fallback).
    emu.log(string.format(
      "[STABLE_EDGE] transition->stable  gameMode=14 Level  resolved=%s (conf=%s)  prevFile=%s",
      nowLevel and string.format("$%03x", nowLevel) or "nil",
      highConfidence and "high" or "low",
      currentFileLevel == -1 and "<none>" or string.format("$%03x", currentFileLevel)))
    -- Scroll-cmd snapshot. The L1 sprite stream's scroll sprite ($E7..$F5)
    -- runs through CODE_05BCD6 → CODE_05BCE9 → L1 setup routine, which
    -- typically 16-bit-STAs Layer1ScrollCmd at $143E, also setting
    -- Layer2ScrollCmd at $143F via the high byte. This logs the post-
    -- dispatch state for verifying L2 motion porting work (#246).
    --   Layer1ScrollCmd  = $7E:143E   (rammap.asm:1566 / SMW_U.sym)
    --   Layer2ScrollCmd  = $7E:143F   (rammap.asm:1567)
    --   Layer1ScrollBits = $7E:1440   (rammap.asm:1568)
    --   Layer2ScrollBits = $7E:1441   (rammap.asm:1569)
    emu.log(string.format(
      "[SCROLL_SNAP] L1Cmd=$%02X L2Cmd=$%02X L1Bits=$%02X L2Bits=$%02X",
      r(0x7E143E), r(0x7E143F), r(0x7E1440), r(0x7E1441)))
    stableFrames = 1
  end
  if nowLevel ~= nil and (justEntered or nowLevel ~= currentFileLevel) then
    if highConfidence or currentFileLevel == -1 then
      openFileForLevel(nowLevel)
      autoScroll = false
    end
  end

  -- Space edge-toggle.
  local spaceNow = keyPressed("Space")
  local vert     = levelIsVertical()
  if spaceNow and not prevSpace then
    autoScroll = not autoScroll
    if autoScroll then
      -- Snap the cross-axis clamp back to its default on engage. Orientation-
      -- specific: horizontal clamps Y (sky), vertical clamps X (mid-screen).
      if vert then floatX = FLOAT_X_PX else floatY = FLOAT_Y_PX end
    end
    emu.log("AUTO-SCROLL: " .. (autoScroll and "ON" or "OFF") .. "  (" .. (vert and "vertical" or "horizontal") .. ")")
  end
  prevSpace = spaceNow

  local marioCol = marioX() // 16
  local marioRow = marioY() // 16

  if not autoScroll then
    -- NORMAL mode: hands off Mario entirely. SMW physics + SNES controller
    -- (which keyboard arrows map to by default in Mesen) drive the game.
    -- Dumps still fire so manual playthroughs get captured.
    drawL1Hud("normal", string.format("(stable %d, Space=auto-scroll)", stableFrames))
    if frames % TICK_FRAMES == 0 then
      if vert then dumpAroundRow(marioRow) else dumpAroundCol(marioCol) end
    end
    return
  end

  -- AUTO-SCROLL: arrow-key nudges, clamp the cross-axis, auto-advance the
  -- main axis. Direction depends on orientation:
  --   horizontal: clamp Y (floatY), advance X         (→)
  --   vertical:   clamp X (floatX), advance Y downward (↓) — vanilla vertical
  --               levels descend; reverse with Up to nudge back.
  local nudged = false
  if vert then
    if keyPressed("Down")  then setMarioY(marioY() + NUDGE_PX); nudged = true end
    if keyPressed("Up")    then setMarioY(math.max(0, marioY() - NUDGE_PX)); nudged = true end
    if keyPressed("Left")  then floatX = math.max(0, floatX - NUDGE_PX); nudged = true end
    if keyPressed("Right") then floatX = floatX + NUDGE_PX; nudged = true end

    setMarioX(floatX)
    w(MARIO_VX, 0)
    w(MARIO_VY, 0)

    if not nudged then
      setMarioY(marioY() + STEP_PIXELS)
    end
  else
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
  end

  -- Re-read post-move positions so the HUD + dump line up with what
  -- we just set. Cheap and keeps status honest under a NUDGE tap.
  marioCol = marioX() // 16
  marioRow = marioY() // 16

  local remaining = TICK_FRAMES - (frames % TICK_FRAMES)
  local secs = math.ceil(remaining / 60)
  local status = nudged and "nudge" or "auto-scroll"
  local extra
  if vert then
    extra = string.format("(col=%d row=%d dump in %ds, Space=stop)", marioCol, marioRow, secs)
  else
    extra = string.format("(col=%d dump in %ds, Space=stop)", marioCol, secs)
  end
  drawL1Hud(status, extra)

  if frames % TICK_FRAMES == 0 then
    if vert then dumpAroundRow(marioRow) else dumpAroundCol(marioCol) end
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

writeLine(string.format("# auto-walker session start  tick_frames=%d  step=%dpx  float_y=0x%02x  float_x=0x%02x",
  TICK_FRAMES, STEP_PIXELS, FLOAT_Y_PX, FLOAT_X_PX))
if file then file:flush() end
