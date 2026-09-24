<#
.SYNOPSIS
    Mutation proof for headless_capture.lua -- a HARD merge requirement per
    docs/ideas/emulator-oracle-testing.md ("Validating the harness itself").
    Replaces the one-off transcript in an earlier agent report with a
    committed, repeatable test: it proves the oracle goes RED on planted
    defects and can still go GREEN unmutated, so the proof cannot rot.

.DESCRIPTION
    Five single-launch cases:
      1. Baseline (unmutated)              -> exit 0
      2. Wrong level forced                -> exit 14 WRONG_LEVEL_LOADED
      3. Game-mode transition never written -> exit 13 LEVEL_LOAD_TIMEOUT
      4. Unreachable LEVEL_ID               -> exit 11, before any frame runs
      5. Missing --snes.rampoweronstate     -> exit 10 POWERON_STATE_WRONG

    Cases 2-3 mutate a COPY of headless_capture.lua under $env:TEMP; the
    tracked file is only ever read. Cases 4-5 feed the unmutated oracle an
    input it is specifically designed to reject, so no code mutation is
    needed there -- the "defect" is the caller's mistake, which is exactly
    what those exit codes exist to catch. Every mutation is verified to have
    actually changed the copy before it is run (a no-op replace must fail
    the test, not silently run the unmutated file). All scratch output goes
    under $env:TEMP and is deleted in a finally block, so a mid-run crash
    leaves neither the tracked source nor the repo tree touched.

    This is a standalone script, not a vitest test: shelling out to a
    Windows-only emulator binary has nothing for vitest's Node runner to add,
    and a contributor already runs run_headless_capture.ps1 by hand. Skips
    (does not silently pass) when Mesen.exe or the ROM is absent, mirroring
    docs/testing.md's skipIf convention with a distinct, documented exit code
    since there is no vitest `describe` to skip here.

.EXAMPLE
    ./tools/scripts/test_headless_capture_mutations.ps1
#>
param(
  # The emulator, its Saves/ and the ROM corpus live OUTSIDE the repo: they
  # are non-redistributable binaries and copyrighted cartridge bytes, so
  # keeping them out of the checkout means `git clean -x` can no longer reach
  # them. Override with the HACKBENCH_TOOLS environment variable, or pass
  # -ToolsRoot. HACKBENCH_ROMS overrides the corpus directory on its own.
  [string]$ToolsRoot = $(if ($env:HACKBENCH_TOOLS) { $env:HACKBENCH_TOOLS } else { "C:/Projects/hackbench-tools" }),
  [string]$RomDir    = $(if ($env:HACKBENCH_ROMS) { $env:HACKBENCH_ROMS } else { Join-Path $ToolsRoot "roms" }),
  [string]$MesenExe = (Join-Path $ToolsRoot "mesen/Mesen.exe"),
  [string]$Rom      = (Join-Path $RomDir "Super Mario World (USA).vanilla.sfc"),
  [string]$SramPath = (Join-Path $ToolsRoot "mesen/Saves/Super Mario World (USA).vanilla.srm"),
  [int]$TimeoutSec  = 120
)

$ErrorActionPreference = "Stop"
$EXIT_SKIP_NO_ROM_OR_EMULATOR = 77  # documented here; not an oracle exit code

if (-not (Test-Path $MesenExe) -or -not (Test-Path $Rom)) {
  Write-Host "SKIP: Mesen.exe ($MesenExe) or the ROM ($Rom) is not present locally. Both live outside the repo under `$ToolsRoot; set HACKBENCH_TOOLS or HACKBENCH_ROMS to point elsewhere (see docs/testing.md). Not a pass or a failure."
  exit $EXIT_SKIP_NO_ROM_OR_EMULATOR
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$LuaSrc   = Join-Path $RepoRoot "tools/mesen/headless_capture.lua"
$Runner   = Join-Path $PSScriptRoot "run_headless_capture.ps1"
$work     = Join-Path $env:TEMP ("hb-mutation-proof-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null
$failures = @()

# Applies one literal find/replace to a COPY of headless_capture.lua and
# proves it actually landed. A find that matches zero (or more than one) site
# means the source moved since this test was written -- fail loudly rather
# than silently exercise the unmutated file.
function New-MutatedLua([string]$find, [string]$replace, [string]$name) {
  $src = Get-Content -Raw -Path $LuaSrc
  $hits = ([regex]::Matches($src, [regex]::Escape($find))).Count
  if ($hits -ne 1) { throw "mutation anchor '$name' matched $hits site(s), expected exactly 1 -- fix the anchor in this script." }
  $mutated = $src.Replace($find, $replace)
  $path = Join-Path $work "$name.lua"
  Set-Content -Path $path -Value $mutated -NoNewline
  if (-not (Get-Content -Raw -Path $path).Contains($replace)) { throw "mutation '$name' did not apply to $path" }
  return $path
}

function Assert-Exit([string]$case, [int]$actual, [int]$expected) {
  if ($actual -ne $expected) {
    $script:failures += "$case -- expected exit $expected, got $actual"
    Write-Host "FAIL: $case -- expected exit $expected, got $actual"
  } else {
    Write-Host "PASS: $case -- exit $actual"
  }
}

function Get-DebugLog([string]$dir) {
  $p = Join-Path $dir "debug.log"
  if (Test-Path $p) { Get-Content -Raw -Path $p } else { "" }
}

try {
  # 1. Baseline. A mutation test that only ever asserts failure could itself
  # be vacuous -- prove the unmutated oracle can still pass.
  $outBase = Join-Path $work "baseline"
  & $Runner -MesenExe $MesenExe -Rom $Rom -LuaScript $LuaSrc -SramPath $SramPath -OutputDir $outBase -TimeoutSec $TimeoutSec | Out-Null
  Assert-Exit "baseline" $LASTEXITCODE 0
  if (-not (Get-DebugLog $outBase).Contains("[DONE]")) { $failures += "baseline: debug.log missing [DONE]" }

  # 2. Wrong level: trigger writes override+1 (a different, validly-loading
  # level) while verification still expects the configured level's
  # Layer1DataPtr. Must be caught, not silently accepted.
  $wrongLevelLua = New-MutatedLua `
    'w(OVERWORLD_OVERRIDE, overrideByte)   -- $7E0109 (rammap.asm:1036)' `
    'w(OVERWORLD_OVERRIDE, overrideByte + 1)   -- MUTATION(wrong_level): forces a different level than expectedLayer1Ptr' `
    "wrong_level"
  $outWrong = Join-Path $work "wrong_level"
  & $Runner -MesenExe $MesenExe -Rom $Rom -LuaScript $wrongLevelLua -SramPath $SramPath -OutputDir $outWrong -TimeoutSec $TimeoutSec | Out-Null
  Assert-Exit "wrong_level" $LASTEXITCODE 14
  if (-not (Get-DebugLog $outWrong).Contains("[WRONG_LEVEL]")) { $failures += "wrong_level: debug.log missing [WRONG_LEVEL] diagnostic" }

  # 3. Never loads: OverworldOverride/OWPlayerSubmap still get written, but
  # the GameMode write that actually starts the transition doesn't -- must
  # time out, not silently hang or false-pass.
  $neverLoadsLua = New-MutatedLua `
    'w(GAME_MODE, GM_FADE_TO_LEVEL)        -- $7E0100 (rammap.asm:980) -> $0F' `
    '-- MUTATION(never_loads): game-mode transition intentionally not written' `
    "never_loads"
  $outNever = Join-Path $work "never_loads"
  & $Runner -MesenExe $MesenExe -Rom $Rom -LuaScript $neverLoadsLua -SramPath $SramPath -OutputDir $outNever -TimeoutSec $TimeoutSec | Out-Null
  Assert-Exit "never_loads" $LASTEXITCODE 13
  if (-not (Get-DebugLog $outNever).Contains("never reached GameMode==`$14")) { $failures += "never_loads: debug.log missing LEVEL_LOAD_TIMEOUT diagnostic" }

  # 4. Unreachable config: $1DC's low byte ($DC) is outside the reachability
  # constraint. Must fail before frame 1 -- proven by total absence of
  # [POWERON] (only written from inside the frame loop), not just exit code.
  $outUnreach = Join-Path $work "unreachable"
  & $Runner -MesenExe $MesenExe -Rom $Rom -LuaScript $LuaSrc -SramPath $SramPath -OutputDir $outUnreach -LevelId "0x1DC" -TimeoutSec $TimeoutSec | Out-Null
  Remove-Item Env:\HB_LEVEL_ID -ErrorAction SilentlyContinue  # do not leak into case 5 below
  Assert-Exit "unreachable_config" $LASTEXITCODE 11
  $unreachLog = Get-DebugLog $outUnreach
  if ($unreachLog.Contains("[POWERON]")) { $failures += "unreachable_config: a frame ran ([POWERON] present) -- not fail-fast" }
  if (-not $unreachLog.Contains("UNREACHABLE")) { $failures += "unreachable_config: debug.log missing UNREACHABLE diagnostic" }
  if (@(Get-ChildItem -Path $outUnreach -Filter "frame_*").Count -ne 0) { $failures += "unreachable_config: sample artifacts exist despite zero frames run" }

  # 5. Missing determinism flag: the wrapper always adds both required flags,
  # so this case bypasses it and invokes Mesen directly -- meaning it needs
  # its own SRAM guard, mirroring (in miniature) what the wrapper does.
  $outFlag = Join-Path $work "missing_flag"
  New-Item -ItemType Directory -Path $outFlag | Out-Null
  $sramExisted = Test-Path $SramPath
  if ($sramExisted) {
    $hashBefore = (Get-FileHash $SramPath -Algorithm SHA256).Hash
    Copy-Item $SramPath "$SramPath.mutproof-backup" -Force
    Remove-Item $SramPath -Force
  }
  try {
    $env:HB_CAPTURE_OUT = $outFlag
    $psi = [System.Diagnostics.ProcessStartInfo]::new($MesenExe, "--testrunner `"$LuaSrc`" `"$Rom`" --snes.disableframeskipping=true")
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    if (-not $p.WaitForExit($TimeoutSec * 1000)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; throw "missing_flag case timed out after ${TimeoutSec}s" }
    Assert-Exit "missing_flag" $p.ExitCode 10
  } finally {
    Remove-Item Env:\HB_CAPTURE_OUT -ErrorAction SilentlyContinue
    if ($sramExisted) {
      Copy-Item "$SramPath.mutproof-backup" $SramPath -Force
      Remove-Item "$SramPath.mutproof-backup" -Force
      if ((Get-FileHash $SramPath -Algorithm SHA256).Hash -ne $hashBefore) { $failures += "missing_flag: SRAM restore hash mismatch" }
    } elseif (Test-Path $SramPath) {
      Remove-Item $SramPath -Force
    }
  }
  if (-not (Get-DebugLog $outFlag).Contains("NOT all zero")) { $failures += "missing_flag: debug.log missing POWERON_STATE_WRONG diagnostic" }
}
finally {
  Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($failures.Count -eq 0) {
  Write-Host "VERDICT: all 5 mutation-proof cases behaved as expected."
  exit 0
} else {
  Write-Host "VERDICT: FAILED"
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
