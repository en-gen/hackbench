-- wram_diff.lua
-- Snapshot-diff tool: captures all WRAM $0000-$1FFF, then on button press
-- captures again and shows ONLY the addresses that changed.
--
-- HOW TO USE:
--   1. Load on overworld. Stand on one level icon. Wait 1-2 seconds (let state settle).
--   2. Press SELECT to take snapshot A.
--   3. Move Mario to a DIFFERENT level icon. Wait for him to stop.
--   4. Press SELECT again to take snapshot B.
--   5. The log will show every WRAM address that changed between A and B.
--
-- Repeat steps 3-5 a few times to narrow down which addresses track the current level.

local SCAN_START = 0x0000
local SCAN_END   = 0x1FFF
local SCAN_LEN   = SCAN_END - SCAN_START + 1

local snapshotA = nil
local snapshotB = nil
local phase = 0  -- 0=waiting for A, 1=waiting for B

local lastSelect = 0

local function takeSnapshot()
  local snap = {}
  for i = 0, SCAN_LEN - 1 do
    snap[i] = emu.read(SCAN_START + i, emu.memType.wram) or 0
  end
  return snap
end

local function diffSnapshots(a, b)
  local diffs = {}
  for i = 0, SCAN_LEN - 1 do
    if a[i] ~= b[i] then
      diffs[#diffs + 1] = { addr = SCAN_START + i, before = a[i], after = b[i] }
    end
  end
  return diffs
end

local function getGameMode()
  return emu.read(0x0100, emu.memType.wram) or 0
end

emu.addEventCallback(function()
  local mode = getGameMode()
  if mode < 0x0C or mode > 0x12 then return end

  -- Read SELECT button (controller 1, bit 5 of $4218 low byte via WRAM mirror)
  -- In Mesen2, read joypad state:
  -- We'll poll $0015 (controller 1 buttons, low byte) — bits: B Y sel start up down left right
  -- Actually use emu.getInput if available, otherwise poll WRAM joypad mirrors.
  -- $7E0015 = controller 1, current frame buttons (low byte)
  -- Bit layout (low byte): B Y Sel Start Up Down Left Right
  local joyLow = emu.read(0x0015, emu.memType.wram) or 0
  local selectBtn = (joyLow >> 5) & 1  -- bit 5 = Select

  if selectBtn == 1 and lastSelect == 0 then
    -- Button just pressed
    if phase == 0 then
      snapshotA = takeSnapshot()
      emu.log("=== Snapshot A taken. Move to a different level icon, then press SELECT again. ===")
      phase = 1
    elseif phase == 1 then
      snapshotB = takeSnapshot()
      local diffs = diffSnapshots(snapshotA, snapshotB)
      emu.log(string.format("=== Snapshot B taken. %d addresses changed: ===", #diffs))
      for _, d in ipairs(diffs) do
        emu.log(string.format("  $%04X: $%02X → $%02X", d.addr, d.before, d.after))
      end
      emu.log("=== (Press SELECT on a new icon to take another B snapshot) ===")
      snapshotA = snapshotB  -- chain: next diff will be from this position
    end
  end
  lastSelect = selectBtn
end, emu.eventType.endFrame)

emu.log("wram_diff.lua loaded.")
emu.log("On the overworld: stand on a level icon, press SELECT for snapshot A.")
emu.log("Move to another level icon, press SELECT for snapshot B.")
emu.log("Changed WRAM addresses will be printed.")
