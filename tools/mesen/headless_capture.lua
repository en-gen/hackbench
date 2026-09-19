-- Mesen 2 Lua: headless, deterministic, scripted level-entry capture route.
--
-- Phase 1 of docs/ideas/emulator-oracle-testing.md. Replaces the human-in-the-
-- loop step in l1_dump.lua / l2_dump.lua / l3_dump.lua ("Enter a level from
-- the overworld") with a scripted route that reaches a configured level from
-- power-on with NO human input and NO simulated button-press navigation
-- through the title screen / file select / overworld menus (that approach
-- was explicitly rejected in the design doc as fragile).
--
-- Instead this drives SMW's own game-mode state machine directly, using the
-- ROM's own "force-load a level in lieu of the overworld" hook -- the same
-- mechanism the ROM itself uses at every power-on to force-load the title
-- screen's background level. See "TRACED MECHANISM" below for the full
-- citation chain. Every RAM address and constant here is traced to a
-- SMWDisX file:line -- see the comments at each use site. Do NOT modify
-- l1_dump.lua / l2_dump.lua / l3_dump.lua; this is a new, separate script.
--
-- Invocation (see tools/scripts/run_headless_capture.ps1 for the wrapper):
--   Mesen.exe --testrunner tools/mesen/headless_capture.lua <rom> ^
--     --snes.rampoweronstate=AllZeros --snes.disableframeskipping=true
--
-- Both flags are REQUIRED for determinism (proven in
-- docs/ideas/emulator-oracle-testing.md, "Determinism: required conditions").
-- This script itself verifies the power-on-state flag took effect (see
-- POWERON_PROBE below) and aborts loudly if it did not. disableframeskipping
-- has no WRAM-readable proof; it is verified functionally by running this
-- route N times and diffing artifact hashes (tools/scripts/run_headless_capture.ps1
-- documents that check) -- see README.md.
--
-- ── TRACED MECHANISM: how a specific level is force-loaded ──────────────────
--
-- OverworldOverride ($7E0109, rammap.asm:1033-1036, "translevel number to
-- load in lieu of the overworld") force-loads a level without walking the
-- overworld cursor to it (bank_05.asm:7169-7215's tile-click derivation --
-- what a scripted button-press route would otherwise have to fake, and was
-- rejected by design). The ROM uses this same mechanism at boot for its own
-- title-screen background level: bank_00.asm:2626-2632 sets override=$EB via
-- !MainMapLvls+!TitleScreenLevel (constants.asm:155,158) before falling
-- through to GM11LoadLevel.
--
-- CODE_05D8A2 (bank_05.asm:7216-7227) decodes the override byte into the
-- direct-page scratch pair _E/_F (rammap.asm:9,23-24):
--     _E = (override >= $25) and override - $24 or override
--     _F = (OWPlayerSubmap[0] ~= 0) and 1 or 0
-- CODE_05D8B7 (bank_05.asm:7227) then reads _E+_F*256 as the map-id and
-- indexes Layer1Ptrs/Layer2Ptrs/Ptrs05EC00 (bank_05.asm:7235-7256).
-- encodeOverride() below inverts this decode.
--
-- CROSS-CHECK against the ROM's own use above: override=$EB,
-- OWPlayerSubmap[0]=0 -> _E=$EB-$24=$C7, _F=0 -> level=$C7=!TitleScreenLevel.
-- Matches.
--
-- REACHABILITY CONSTRAINT (a real limitation, not a bug): OverworldOverride
-- is one byte (0-255) and OWPlayerSubmap[0] contributes only one bit (_F).
-- Solving the CMP/SBC arithmetic above for the achievable low byte (_E)
-- shows _E must be <= $DB (219) -- an override value >= $25 that decodes to
-- _E in [$DC,$FF] would need override > $FF, which cannot be represented in
-- one byte. ALSO EXCLUDED: low byte $00. override=$00 does not reach
-- CODE_05D8A2 at all -- bank_05.asm:7167-7168 is `LDA.W OverworldOverride /
-- BNE CODE_05D8A2`, so a zero override falls through to the normal
-- overworld-cursor derivation instead of the forced-load path, and is
-- silently ignored rather than loading level $000/$100. So the reachable
-- level-index set is [$001,$0DB] u [$101,$1DB], NOT [$000,$0DB] u [$100,$1DB].
-- Levels with low byte $00 or in [$DC,$FF] ($0DC-$0FF, $1DC-$1FF) cannot be
-- forced via this mechanism. CONFIG.LEVEL_ID is validated against this at
-- script start and the script fails loudly (EXIT_LEVEL_UNREACHABLE_CONFIG)
-- rather than silently loading the wrong level.
--
-- WHY WAIT FOR THE TITLE SCREEN FIRST (GameMode==7) rather than forcing the
-- level load at power-on: bank_00.asm:1-56 (the reset vector) only performs
-- hardware bring-up (SPC upload, OAM reset routine, ClearMemory, window DMA)
-- before entering the per-frame GameLoop with GameMode==0. GameMode 0-6
-- (LoadPresents..SpotlightTitleScreen, rammap.asm:982-988) then perform
-- one-time asset uploads (font, HUD, common palettes) that level rendering
-- depends on. Rather than guess which of those are required, this script
-- lets the ROM's own natural, input-free, frame-driven boot sequence run
-- all the way to GameMode==7 (TitleScreen) -- by which point the ROM has
-- ALREADY force-loaded and rendered one level (the title-screen background,
-- via this exact mechanism, at bank_00.asm:2626-2632) proving all
-- prerequisites are satisfied -- and only then injects our own override.
-- No button press is simulated at any point.

local MEM = emu.memType.snesMemory
local function r(addr)      return emu.read(addr, MEM) end
local function w(addr, val) emu.write(addr, val, MEM) end

-- PPU CGRAM: 512 bytes = 256 BGR555 words, the palette the PPU actually held
-- at the sampled frame. This is hardware state, NOT the ROM tables our
-- PaletteLoader derives from and NOT MainPalette ($7E0703, rammap.asm:1175,
-- the game's own WRAM staging buffer), so comparing our derivation against it
-- is not circular. Mesen 2 has renamed memType members across builds, so
-- resolve defensively the same way l3_dump.lua resolves VRAM.
local CGRAM_MEM = nil
local CGRAM_MEM_NAME = nil
for _, name in ipairs({ "snesCgRam", "snesCgram", "cgRam", "cgram" }) do
  local v = emu.memType[name]
  if v ~= nil then CGRAM_MEM = v; CGRAM_MEM_NAME = name; break end
end
local CGRAM_BYTES = 512

-- ── CONFIG: the one place to edit ───────────────────────────────────────────
local CONFIG = {
  -- Target level index, 0-0x1FF, in the same space as Layer1Ptrs/Layer2Ptrs/
  -- Ptrs05EC00 (bank_05.asm:7235-7256). Must satisfy the reachability
  -- constraint above (see the docstring). $105 is the design doc's own
  -- example level (docs/ideas/emulator-oracle-testing.md, Tier 2 section).
  -- Overridable via HB_LEVEL_ID so a sweep runner can drive many levels
  -- through one Lua file without hand-editing this config each time.
  LEVEL_ID = tonumber(os.getenv("HB_LEVEL_ID")) or 0x105,

  -- Frames AFTER GameMode first reads $14 (Level) at which to dump
  -- artifacts. Kept small for Phase 1 per the task brief ("keep the
  -- artifact set small and obvious").
  SAMPLE_FRAMES = { 0, 30, 60 },

  -- Absolute output directory. Must be writable and MUST NOT be inside a
  -- git-tracked path that isn't gitignored -- tools/mesen/* is gitignored
  -- except *.lua and README.md (see .gitignore), so anything under
  -- tools/mesen/ is safe. run_headless_capture.ps1 sets HB_CAPTURE_OUT to
  -- its own -OutputDir before launching Mesen.exe, so a worktree writes
  -- artifacts inside itself instead of the checkout the ROM happens to live
  -- in. The literal fallback below only applies when this script is invoked
  -- directly (bypassing the wrapper).
  OUTPUT_DIR = os.getenv("HB_CAPTURE_OUT") or "C:/Projects/hackbench/tools/mesen/headless_output",

  -- Safety-net frame budgets (see "Fail loudly" in the module docstring).
  -- Generous on purpose: they exist to catch a genuinely stuck emulator or
  -- a broken route, not to be tuned to the observed nominal timing.
  TITLE_SCREEN_FRAME_BUDGET = 3600,  -- 60s @ 60fps: power-on -> GameMode==7
  LEVEL_LOAD_FRAME_BUDGET   = 900,   -- 15s @ 60fps: GameMode==7 -> GameMode==$14
}

-- ── Exit codes (documented in tools/mesen/README.md) ────────────────────────
local EXIT_OK                        = 0
local EXIT_POWERON_STATE_WRONG       = 10
local EXIT_LEVEL_UNREACHABLE_CONFIG  = 11
local EXIT_TITLE_SCREEN_TIMEOUT      = 12
local EXIT_LEVEL_LOAD_TIMEOUT        = 13
local EXIT_WRONG_LEVEL_LOADED        = 14
local EXIT_SAMPLE_STALL              = 15
local EXIT_CGRAM_UNAVAILABLE         = 16

-- ── Traced RAM addresses (every one cited above or inline) ──────────────────
local GAME_MODE           = 0x7E0100  -- rammap.asm:977-980
local OVERWORLD_OVERRIDE  = 0x7E0109  -- rammap.asm:1033-1036
local OW_PLAYER_SUBMAP_0  = 0x7E1F11  -- rammap.asm ORG $000400.. parse -> OWPlayerSubmap[0]

local GM_TITLE_SCREEN = 7   -- !GameMode_TitleScreen, rammap.asm:989
local GM_FADE_TO_LEVEL = 0x0F -- !GameMode_FadeToLevel, rammap.asm:997
local GM_LEVEL          = 0x14 -- !GameMode_Level, rammap.asm:1002

-- Power-on-randomization probe. $7EC100-$7EC67F is explicitly documented as
-- unused by the ENTIRE disassembly (rammap.asm:2109: "; 7EC100 - 7EC67F
-- unused", a 1408-byte gap between Layer2TilemapHigh and Mode7BossTilemap,
-- ORG $7E2000 block). No bank ever reads or writes it, so on real hardware
-- and in Mesen it can only reflect true power-on state -- never legitimate
-- game behavior. This makes it a clean witness for
-- --snes.rampoweronstate=AllZeros, independent of ClearMemory (which only
-- clears $0000-$1FFF per bank_00.asm:42) and independent of anything the
-- boot sequence legitimately writes.
local POWERON_PROBE_ADDR = 0x7EC100
local POWERON_PROBE_LEN  = 16

-- ── Level-index <-> OverworldOverride encoding (traced above) ───────────────
-- Returns overrideByte, submapFlag on success. On failure returns
-- nil, reason -- two distinct reasons exist (out-of-range vs. unreachable
-- low byte) and the caller reports whichever one actually applies.
local function encodeOverride(L)
  if L < 0 or L > 0x1FF then return nil, "out of range 0-0x1FF" end
  local highBit = (L >= 0x100) and 1 or 0
  local lowByte = L % 0x100
  -- low byte $00 (levels $000 and $100) is unreachable: OverworldOverride=0
  -- falls through to the overworld-cursor path instead of the forced-load
  -- path and is silently ignored (bank_05.asm:7167-7168, "LDA.W
  -- OverworldOverride / BNE CODE_05D8A2" -- BNE does not branch on zero).
  -- Reject at config time rather than burning a full run to hit exit 14.
  if lowByte == 0 then return nil, "low byte $00 unreachable: OverworldOverride=0 falls through to the overworld-cursor path, see bank_05.asm:7167-7168" end
  if lowByte > 0xDB then return nil, "low byte > $DB, see REACHABILITY CONSTRAINT" end
  local overrideByte
  if lowByte < 0x25 then
    overrideByte = lowByte
  else
    overrideByte = lowByte + 0x24
  end
  return overrideByte, highBit
end

-- Recursively remove OUTPUT_DIR and recreate it empty. Must run before
-- anything else in this file writes to it (including debug.log below).
--
-- Why this matters: a Mesen exit(0) full artifact set and a later exit(14)
-- failure used to share a directory where only debug.log gets overwritten
-- on every run. A reviewer captured level $105 (exit 0, full artifacts),
-- then ran level $013 into the SAME OUTPUT_DIR (exit 14) -- and the
-- directory still held a complete, plausible-looking artifact set
-- afterward, entirely $105's, because the screenshot/WRAM files from the
-- first run were never cleaned up. Any consumer globbing that directory
-- after a failed run would silently read stale, wrong-level data instead
-- of noticing there was no valid capture. Cleaning at run start means a
-- failed run leaves the directory empty -- absence is the only honest
-- signal for "no valid capture available".
local function cleanOutputDir(path)
  local winPath = path:gsub("/", "\\")
  pcall(os.execute, string.format('if exist "%s" rd /s /q "%s"', winPath, winPath))
  pcall(os.execute, string.format('mkdir "%s"', winPath))
end

-- emu.log's destination isn't reliably visible from --testrunner (no GUI
-- script window, and it does not appear on stdout). Mirror every log line
-- to a plain file so failures are diagnosable without attaching a GUI.
cleanOutputDir(CONFIG.OUTPUT_DIR)
local debugLogFile = io.open(CONFIG.OUTPUT_DIR .. "/debug.log", "w")
local function dlog(s)
  emu.log(s)
  if debugLogFile then debugLogFile:write(s, "\n"); debugLogFile:flush() end
end

local overrideByte, submapFlag = encodeOverride(CONFIG.LEVEL_ID)
if overrideByte == nil then
  local reason = submapFlag -- encodeOverride's second return is the failure reason here
  dlog(string.format(
    "[CONFIG] level $%03x is UNREACHABLE via OverworldOverride (%s). " ..
    "Aborting before running any frames.",
    CONFIG.LEVEL_ID, reason))
  emu.stop(EXIT_LEVEL_UNREACHABLE_CONFIG)
  return
end

-- An oracle that silently skips a check it advertises is worse than no
-- check. If CGRAM is not readable from this Mesen build, abort before
-- running a frame rather than producing a capture with no cgram.bin in it.
if CGRAM_MEM == nil then
  dlog("[CGRAM] no CGRAM memType resolved from emu.memType (tried snesCgRam/snesCgram/cgRam/cgram). Aborting.")
  emu.stop(EXIT_CGRAM_UNAVAILABLE)
  return
end

-- ── State ────────────────────────────────────────────────────────────────
local frame = 0
local phase = "poweron_check"   -- poweron_check -> wait_title -> wait_level -> sampling -> done
local levelLoadDeadline = nil
local levelEntryFrame = nil
local sampleIdx = 1
local prevGameMode = nil

local function writeBinary(path, bytes)
  local f, err = io.open(path, "wb")
  if not f then
    dlog("io.open failed for " .. path .. ": " .. tostring(err))
    return false
  end
  f:write(bytes)
  f:close()
  return true
end

local function dumpWram8k(path)
  local chunks = {}
  for addr = 0x7E0000, 0x7E1FFF do
    chunks[#chunks + 1] = string.char(r(addr))
  end
  return writeBinary(path, table.concat(chunks))
end

local function dumpCgram(path)
  local chunks = {}
  for i = 0, CGRAM_BYTES - 1 do
    chunks[#chunks + 1] = string.char(emu.read(i, CGRAM_MEM))
  end
  return writeBinary(path, table.concat(chunks))
end

local function dumpScreenshot(path)
  local png = emu.takeScreenshot()
  return writeBinary(path, png)
end

-- Verification.
--
-- MECHANISM: emu.addMemoryCallback DOES fire under --testrunner and is used
-- directly here, rather than polling emu.read from addEventCallback(endFrame)
-- as an earlier version of this script did. That polling design is what
-- produced the defect this rewrite replaces (see "FIRST COMPLETE WRITE"
-- below) -- callbacks require CPU-space addresses (e.g. plain $0065), not
-- $7E-prefixed absolute ones (independently verified: a write hook on
-- CPU-space $0065-$0067 fires correctly; the $7E-prefixed absolute form
-- does not fire at all under --testrunner).
--
-- The AUTHORITATIVE signal is Layer1DataPtr ($7E0065-0067, bank_05.asm:7236
-- "STA.B Layer1DataPtr", the same address l1_dump.lua already uses for its
-- own map-id reverse lookup). It is written once per level load, from the
-- ROM's Layer1Ptrs table (SNES $05E000, 3 bytes/level -- l1_dump.lua's own
-- L1_PTR_TABLE constant) indexed by the FULL 16-bit _E+_F*256 value
-- (bank_05.asm:7228-7240), and then stays live and in active use for the
-- rest of the level. Comparing the live Layer1DataPtr against the ROM
-- table entry for CONFIG.LEVEL_ID, read independently, proves the whole
-- chain (override decode AND the submap/high-bit flag) resolved to the
-- correct table row, and does not depend on timing assumptions -- other
-- than correctly identifying the ONE write that matters, below.
--
-- FIRST COMPLETE WRITE: bank_05.asm:7235-7240 writes the 3-byte pointer as
-- three back-to-back 8-bit LDA/STA pairs with NO branch, JSR, or JSL between
-- them:
--     LDA.W Layer1Ptrs,Y    : STA.B Layer1DataPtr      (offset 0, $0065)
--     LDA.W Layer1Ptrs+1,Y  : STA.B Layer1DataPtr+1    (offset 1, $0066)
--     LDA.W Layer1Ptrs+2,Y  : STA.B Layer1DataPtr+2    (offset 2, $0067)
-- Because that sequence cannot be interrupted mid-stream (65816 instructions
-- complete atomically; there is no NMI-driven WRAM writer for this address
-- in this build), the write to offset 2 ($0067) is PROVABLY the last of the
-- three to land. So "first complete write" is defined as: the first
-- post-trigger write callback whose address equals the top of the range
-- ($0067), closing out a pointer built from the VALUE ARGUMENT of each of
-- the three callback firings (offset 0, then 1, then 2) -- never from a
-- follow-up emu.read. Reading back via emu.read once offset 2 fires looks
-- equivalent (offsets 0 and 1 are already committed by then) but is NOT:
-- Mesen's write callback fires before the triggering write itself commits
-- to memory, so emu.read on the SAME address inside that same callback
-- still returns the pre-write value. Building the pointer from the
-- callback's own `value` parameter for all three offsets sidesteps that
-- pre/post-write question entirely and is correct regardless of it.
--
-- This is also exactly what fixes the $0DB false-fail: the old poll+debounce
-- design needed the pristine value to survive across 2+ *frame* boundaries,
-- which $0DB's object parser does not allow (it starts consuming the pointer
-- within the SAME frame it is written). A write callback has no such
-- requirement -- it fires mid-frame, at the exact CPU cycle of the write, so
-- it captures the pristine value even when the parser overwrites it before
-- the frame ends.
--
-- Guarding against a stale pre-trigger write: Layer1DataPtr already holds a
-- valid (but irrelevant) value before our trigger, because the ROM force-
-- loads its OWN title-screen background level via this identical mechanism
-- at boot (see TRACED MECHANISM above). The callback is registered
-- unconditionally at script load, but `listening` gates it to only act on
-- writes that happen at or after our own trigger -- set synchronously, in
-- the same Lua call that performs the trigger writes below -- so the
-- title screen's own pointer write is ignored.
--
-- Guarding against a write that never happens: if GameMode reaches
-- GM_LEVEL ($14) and `captured` is still false, the callback simply never
-- fired for this run (wrong address space, wrong build, or a genuinely
-- different code path). That is treated as a verification failure with its
-- own distinct log message below, not silently ignored -- an oracle must
-- fail loudly when its central assumption doesn't hold, not report "OK" by
-- omission.
local LAYER1_PTRS_TABLE = 0x05E000  -- bank_05.asm:7235 "LDA.W Layer1Ptrs,Y"; == l1_dump.lua L1_PTR_TABLE
local LAYER1_DATA_PTR   = 0x0065    -- rammap.asm:533 (CPU-space direct-page address, no $7E bank)
local function readPtr24(addr)
  return r(addr) + r(addr + 1) * 0x100 + r(addr + 2) * 0x10000
end
local expectedLayer1Ptr = nil -- computed on first frame, once ROM is confirmed mapped

local listening = false        -- true once our own trigger has been written
local captured = false         -- true once the first complete post-trigger write landed
local observedLayer1Ptr = nil
local capturedAtFrame = nil
local pendingLo, pendingMid = nil, nil  -- bytes 0/1 of the in-progress write, from the callback's OWN value arg

-- emu.addMemoryCallback(fn, writeType, startAddr, endAddr) watches CPU-space
-- writes to $0065-$0067 (Layer1DataPtr). See "FIRST COMPLETE WRITE" above for
-- why only the write to the top of the range ($0067) closes out a capture.
--
-- IMPORTANT: this reconstructs the pointer from the `value` argument the
-- callback receives for EACH of the three writes, never from a follow-up
-- emu.read. An earlier version of this fix read back all three bytes via
-- emu.read once offset 2's write fired, reasoning that the ASM's three
-- back-to-back STAs (no branch between them) guarantee 0 and 1 already
-- landed by then. That part is true, but it wrongly assumed emu.read at
-- callback time also sees offset 2's OWN just-written byte -- a 27-level
-- sweep proved otherwise: 6 of 27 levels captured the CORRECT low/mid bytes
-- but the PREVIOUS level's bank byte (e.g. expected $0788CB, observed
-- $0688CB -- low 16 bits right, bank off by exactly the boot-time title-
-- screen level's own bank). Mesen's write callback fires before the write
-- is committed to memory, so emu.read on the address being written in that
-- same callback returns the pre-write value; the other two offsets read
-- correctly only because THEY were written in earlier, already-committed
-- instructions. Using the callback's own `value` parameter for all three
-- offsets sidesteps this pre/post-write timing question entirely.
local function onLayer1PtrWrite(address, value)
  if not listening or captured then return end
  if address == LAYER1_DATA_PTR then
    pendingLo = value
    return
  elseif address == LAYER1_DATA_PTR + 1 then
    pendingMid = value
    return
  elseif address ~= LAYER1_DATA_PTR + 2 then
    return
  end
  observedLayer1Ptr = (pendingLo or 0) + (pendingMid or 0) * 0x100 + value * 0x10000
  captured = true
  capturedAtFrame = frame
end
emu.addMemoryCallback(onLayer1PtrWrite, emu.callbackType.write, LAYER1_DATA_PTR, LAYER1_DATA_PTR + 2)

local function onFrame()
  frame = frame + 1
  local gameMode = r(GAME_MODE)

  if phase == "poweron_check" then
    -- First frame only: verify --snes.rampoweronstate=AllZeros actually
    -- took effect before trusting anything else this run produces.
    local bad = false
    local sample = {}
    for i = 0, POWERON_PROBE_LEN - 1 do
      local b = r(POWERON_PROBE_ADDR + i)
      sample[#sample + 1] = b
      if b ~= 0 then bad = true end
    end
    if bad then
      dlog(string.format(
        "[POWERON] $7EC100-$7EC10F NOT all zero: %s -- rampoweronstate=AllZeros did not take effect (or was omitted). Aborting.",
        table.concat(sample, " ")))
      emu.stop(EXIT_POWERON_STATE_WRONG)
      return
    end
    dlog("[POWERON] power-on WRAM probe zeroed, OK")
    -- ROM is confirmed mapped and readable now (we just read WRAM fine);
    -- safe to read the Layer1Ptrs table for our verification baseline.
    expectedLayer1Ptr = readPtr24(LAYER1_PTRS_TABLE + CONFIG.LEVEL_ID * 3)
    dlog(string.format("[CONFIG] expected Layer1DataPtr for level $%03x = $%06X (Layer1Ptrs[$%03x], SNES $%06X)",
      CONFIG.LEVEL_ID, expectedLayer1Ptr, CONFIG.LEVEL_ID, LAYER1_PTRS_TABLE + CONFIG.LEVEL_ID * 3))
    phase = "wait_title"
    prevGameMode = gameMode
  end

  if phase == "wait_title" then
    if prevGameMode ~= GM_TITLE_SCREEN and gameMode == GM_TITLE_SCREEN then
      -- Inject the forced level load. See the module docstring's TRACED
      -- MECHANISM section for the full citation chain.
      w(OW_PLAYER_SUBMAP_0, submapFlag)     -- $7E1F11 (rammap.asm parse)
      w(OVERWORLD_OVERRIDE, overrideByte)   -- $7E0109 (rammap.asm:1036)
      w(GAME_MODE, GM_FADE_TO_LEVEL)        -- $7E0100 (rammap.asm:980) -> $0F
      listening = true  -- arm the Layer1DataPtr write callback; see "Verification" above
      dlog(string.format(
        "[TRIGGER] frame=%d  TitleScreen reached -> forcing level $%03x  override=$%02X submap=%d  (readback: submap0=%d override=%02X gm=%02X)",
        frame, CONFIG.LEVEL_ID, overrideByte, submapFlag,
        r(OW_PLAYER_SUBMAP_0), r(OVERWORLD_OVERRIDE), r(GAME_MODE)))
      levelLoadDeadline = frame + CONFIG.LEVEL_LOAD_FRAME_BUDGET
      phase = "wait_level"
    elseif frame > CONFIG.TITLE_SCREEN_FRAME_BUDGET then
      dlog(string.format(
        "[TIMEOUT] frame=%d  never reached GameMode==7 (TitleScreen); last GameMode=%02X. Aborting.",
        frame, gameMode))
      emu.stop(EXIT_TITLE_SCREEN_TIMEOUT)
      return
    end
    prevGameMode = gameMode
  end

  -- Deliberately `if`, not `elseif`, mirroring the poweron_check ->
  -- wait_title fallthrough above: a phase transition earlier in this same
  -- onFrame call must be visible to the next phase's check on the SAME
  -- frame (needed so a sample offset of 0 -- "the entry frame itself" --
  -- is actually reachable instead of being missed by one frame).
  if phase == "wait_level" then
    if prevGameMode ~= gameMode then
      dlog(string.format("[DBG] gameMode transition %02X -> %02X at frame=%d",
        prevGameMode or -1, gameMode, frame))
      prevGameMode = gameMode
    end
    if gameMode == GM_LEVEL then
      -- Authoritative check: see the "Verification" comment above
      -- onLayer1PtrWrite. `captured` was set by the FIRST COMPLETE WRITE to
      -- Layer1DataPtr following our own trigger, and must match the ROM's
      -- own Layer1Ptrs table entry for CONFIG.LEVEL_ID.
      if not captured then
        dlog(string.format(
          "[WRONG_LEVEL] frame=%d  GameMode reached $%02X (Level) but the Layer1DataPtr write callback never fired since the trigger -- expected Layer1DataPtr=$%06X (level $%03x) was never observed. Aborting rather than capturing.",
          frame, GM_LEVEL, expectedLayer1Ptr, CONFIG.LEVEL_ID))
        emu.stop(EXIT_WRONG_LEVEL_LOADED)
        return
      elseif observedLayer1Ptr ~= expectedLayer1Ptr then
        dlog(string.format(
          "[WRONG_LEVEL] frame=%d  expected Layer1DataPtr=$%06X (level $%03x)  observed=$%06X (captured at frame %d). Route drift -- aborting rather than capturing.",
          frame, expectedLayer1Ptr, CONFIG.LEVEL_ID, observedLayer1Ptr, capturedAtFrame))
        emu.stop(EXIT_WRONG_LEVEL_LOADED)
        return
      end
      dlog(string.format("[LEVEL_OK] frame=%d  confirmed level $%03x  (Layer1DataPtr=$%06X, captured at frame %d via write callback)",
        frame, CONFIG.LEVEL_ID, observedLayer1Ptr, capturedAtFrame))
      levelEntryFrame = frame
      phase = "sampling"
    elseif frame > levelLoadDeadline then
      dlog(string.format(
        "[TIMEOUT] frame=%d  never reached GameMode==$14 (Level) after trigger; last GameMode=%02X. Aborting.",
        frame, gameMode))
      emu.stop(EXIT_LEVEL_LOAD_TIMEOUT)
      return
    end
  end

  if phase == "sampling" then
    local target = levelEntryFrame + CONFIG.SAMPLE_FRAMES[sampleIdx]
    if frame == target then
      local tag = string.format("%s/frame_%04d", CONFIG.OUTPUT_DIR, CONFIG.SAMPLE_FRAMES[sampleIdx])
      local okPng = dumpScreenshot(tag .. ".png")
      local okWram = dumpWram8k(tag .. "_wram.bin")
      local okCg = dumpCgram(tag .. "_cgram.bin")
      dlog(string.format("[SAMPLE] frame=%d  offset=+%d  png=%s wram=%s cgram=%s",
        frame, CONFIG.SAMPLE_FRAMES[sampleIdx], tostring(okPng), tostring(okWram), tostring(okCg)))
      if not (okPng and okWram and okCg) then
        emu.stop(EXIT_SAMPLE_STALL)
        return
      end
      sampleIdx = sampleIdx + 1
      if sampleIdx > #CONFIG.SAMPLE_FRAMES then
        dlog(string.format("[DONE] frame=%d  all %d sample(s) captured for level $%03x",
          frame, #CONFIG.SAMPLE_FRAMES, CONFIG.LEVEL_ID))
        emu.stop(EXIT_OK)
        return
      end
    elseif frame > target + 60 then
      -- Belt-and-suspenders: with disableframeskipping=true and no input
      -- ever injected, frame counting is exact and this should be
      -- unreachable. Guards against a truly stuck emulator rather than
      -- silently hanging the test runner forever.
      dlog(string.format("[STALL] frame=%d  missed sample target=%d", frame, target))
      emu.stop(EXIT_SAMPLE_STALL)
      return
    end
  end
end

emu.addEventCallback(onFrame, emu.eventType.endFrame)
dlog(string.format("headless_capture.lua loaded: target level $%03x (override=$%02X submap=%d), output=%s, cgramMem=%s",
  CONFIG.LEVEL_ID, overrideByte, submapFlag, CONFIG.OUTPUT_DIR, tostring(CGRAM_MEM_NAME)))
