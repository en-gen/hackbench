<#
.SYNOPSIS
    Runs tools/mesen/headless_capture.lua headlessly against Mesen, handling
    the two hazards documented in docs/ideas/emulator-oracle-testing.md:
    the user's real SRAM save file, and the required-but-easy-to-forget
    determinism flags.

.DESCRIPTION
    - Backs up the real SRAM file, then removes it before each run so the
      route boots with no save data (a "known state" -- our route never
      reads save-slot data anyway, since it force-loads a level directly
      and never visits File Select, but this is done defensively per the
      documented SRAM-carryover hazard).
    - Always passes BOTH required determinism flags
      (--snes.rampoweronstate=AllZeros --snes.disableframeskipping=true).
      Proven required in docs/ideas/emulator-oracle-testing.md; omitting
      either reintroduces cross-run nondeterminism.
    - Restores the real SRAM file afterward, EVEN IF the route fails or
      the script is interrupted (finally block), and verifies the restored
      file's SHA-256 matches what was backed up.
    - With -Runs > 1, archives each run's output directory to
      <OutputDir>-runs/run_<n>/ and prints a per-file SHA-256 comparison
      table across all runs at the end (the determinism check).

.PARAMETER Runs
    Number of cold-process runs. 1 for a normal capture, 5+ for the
    determinism check.

.PARAMETER LevelId
    Optional override for headless_capture.lua's CONFIG.LEVEL_ID (e.g.
    "0x0DB" or "219"), passed through as the HB_LEVEL_ID environment
    variable. Omit to use the Lua file's own hardcoded default. Lets a
    sweep runner drive many levels through one Lua file.

.EXAMPLE
    ./run_headless_capture.ps1
    ./run_headless_capture.ps1 -Runs 5
    ./run_headless_capture.ps1 -LevelId 0x0DB -OutputDir ../mesen/sweep/0db
#>
param(
  [string]$MesenExe  = "C:/Projects/hackbench/tools/mesen/Mesen.exe",
  [string]$Rom       = "C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc",
  [string]$LuaScript = $(Join-Path $PSScriptRoot "../mesen/headless_capture.lua"),
  [string]$SramPath  = "C:/Projects/hackbench/tools/mesen/Saves/Super Mario World (USA).vanilla.srm",
  # Relative to this script's own repo (not the checkout the ROM/Mesen.exe
  # happen to live in) so running from a worktree writes inside that worktree
  # instead of polluting whatever checkout $MesenExe/$Rom point at.
  [string]$OutputDir = $(Join-Path $PSScriptRoot "../mesen/headless_output"),
  [int]$Runs = 1,
  [int]$TimeoutSec = 120,
  # Optional: override headless_capture.lua's CONFIG.LEVEL_ID via HB_LEVEL_ID
  # without editing the Lua file. Omit to use the Lua file's own default.
  # Hex ("0x105") and decimal are both accepted since Lua's tonumber() (which
  # reads this env var on the other end) parses both.
  [string]$LevelId = $null
)

$ErrorActionPreference = "Stop"

# See tools/mesen/README.md for the meaning of each exit code.
function Resolve-ExitName([int]$code) {
  if ($code -eq 124) { return "PROCESS_TIMEOUT (killed by this runner)" }
  return "see tools/mesen/README.md"
}

if (-not (Test-Path $MesenExe))  { throw "Mesen.exe not found at $MesenExe" }
if (-not (Test-Path $Rom))       { throw "ROM not found at $Rom (see docs/testing.md to obtain one)" }
if (-not (Test-Path $LuaScript)) { throw "Route script not found at $LuaScript" }

# Normalize away any ".." from the $PSScriptRoot-relative default (or a
# caller-supplied relative path) BEFORE it's used for string-length-based
# path arithmetic below (Substring(rd.Length)): Get-ChildItem's FullName is
# always OS-resolved with no "..", so comparing lengths against an
# unresolved literal path silently produces the wrong offset.
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)

# Plumb OutputDir to the Lua script itself -- CONFIG.OUTPUT_DIR reads this,
# falling back to a hardcoded literal only when the script is invoked
# directly, bypassing this wrapper.
$env:HB_CAPTURE_OUT = $OutputDir
if ($LevelId) {
  $env:HB_LEVEL_ID = $LevelId
} elseif ($env:HB_LEVEL_ID) {
  # An ambient HB_LEVEL_ID used to be cleared here with no output at all, so
  # setting it directly (the obvious thing to try) silently ran the default
  # level instead -- a confidently-wrong pass. -LevelId is the only supported
  # way to target a level; warn instead of clearing quietly.
  Write-Warning "Ambient HB_LEVEL_ID='$($env:HB_LEVEL_ID)' is ignored by this wrapper -- pass -LevelId instead. Clearing it for this run."
  Remove-Item Env:\HB_LEVEL_ID -ErrorAction SilentlyContinue
} else {
  Remove-Item Env:\HB_LEVEL_ID -ErrorAction SilentlyContinue
}

$sramExisted = Test-Path $SramPath
$sramBackup  = "$SramPath.headless-backup"
$originalHash = $null

if ($sramExisted) {
  Copy-Item -Path $SramPath -Destination $sramBackup -Force
  $originalHash = (Get-FileHash -Path $SramPath -Algorithm SHA256).Hash
  Write-Host "Backed up SRAM: $SramPath"
  Write-Host "  SHA-256: $originalHash"
} else {
  Write-Host "No existing SRAM at $SramPath (nothing to back up; will remove anything the route creates)."
}

$runsArchiveDir = "$OutputDir-runs"
$exitCodes = @()

try {
  for ($i = 1; $i -le $Runs; $i++) {
    Write-Host ""
    Write-Host "=== Run $i of $Runs ==="

    # Pin SRAM to a known state before each run.
    if (Test-Path $SramPath) { Remove-Item $SramPath -Force }

    # Start-Process -WindowStyle Hidden still allocates a window (WindowStyle
    # is only a hint a GUI app may ignore) and steals focus on this machine.
    # ProcessStartInfo with UseShellExecute=$false + CreateNoWindow=$true
    # does not create a window at all.
    $argStr = "--testrunner `"$LuaScript`" `"$Rom`" --snes.rampoweronstate=AllZeros --snes.disableframeskipping=true"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $MesenExe
    $psi.Arguments = $argStr
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)

    $finished = $proc.WaitForExit($TimeoutSec * 1000)
    if (-not $finished) {
      Write-Warning ("Run {0}: Mesen did not exit within {1}s; killing process." -f $i, $TimeoutSec)
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      $exitCodes += 124
      continue
    }
    $code = $proc.ExitCode
    $name = Resolve-ExitName $code
    Write-Host "Run $i exit code: $code ($name)"
    $exitCodes += $code

    if ($Runs -gt 1) {
      $runDir = Join-Path $runsArchiveDir "run_$i"
      if (Test-Path $runDir) { Remove-Item $runDir -Recurse -Force }
      New-Item -ItemType Directory -Path $runDir -Force | Out-Null
      if (Test-Path $OutputDir) {
        Move-Item -Path (Join-Path $OutputDir "*") -Destination $runDir -Force
      }
    }
  }
}
finally {
  if ($sramExisted) {
    Copy-Item -Path $sramBackup -Destination $SramPath -Force
    $restoredHash = (Get-FileHash -Path $SramPath -Algorithm SHA256).Hash
    Remove-Item $sramBackup -Force
    if ($restoredHash -ne $originalHash) {
      Write-Error "SRAM RESTORE MISMATCH: expected $originalHash got $restoredHash. The backup was already copied back; investigate immediately."
    } else {
      Write-Host ""
      Write-Host "SRAM restored and verified: $restoredHash"
    }
  } elseif (Test-Path $SramPath) {
    Remove-Item $SramPath -Force
    Write-Host "Removed SRAM created by this run (none existed before)."
  }
}

if ($Runs -gt 1) {
  Write-Host ""
  Write-Host "=== Determinism check: per-file SHA-256 across $Runs runs ==="
  $runDirs = 1..$Runs | ForEach-Object { Join-Path $runsArchiveDir "run_$_" }

  # A run exiting non-zero can still leave a debug.log behind, which would
  # otherwise sail through the byte-identical check below having compared a
  # log of a failure. Gate on exit codes FIRST so a run that failed can never
  # be reported as a deterministic success.
  $badRuns = $exitCodes | Where-Object { $_ -ne 0 }
  if ($badRuns) {
    Write-Host "VERDICT: INVALID -- not all runs exited 0 ($($exitCodes -join ', '))"
    exit 1
  }

  # Assert every run directory actually exists and holds artifacts, and that
  # every run produced the SAME count. This is what line 110's old
  # `-ErrorAction SilentlyContinue` used to hide: a misconfigured OutputDir
  # (see tools/mesen/headless_capture.lua CONFIG.OUTPUT_DIR /
  # HB_CAPTURE_OUT) left $OutputDir empty, Move-Item silently moved nothing,
  # and the loop below then iterated zero files and declared victory.
  $expectedCount = $null
  foreach ($rd in $runDirs) {
    if (-not (Test-Path $rd)) { throw "Run directory missing: $rd -- a run produced no artifacts at all." }
    $count = @(Get-ChildItem -Path $rd -Recurse -File).Count
    if ($count -eq 0) { throw "Run directory $rd contains no artifacts. Check OutputDir ($OutputDir) matches CONFIG.OUTPUT_DIR / HB_CAPTURE_OUT in headless_capture.lua." }
    if ($null -eq $expectedCount) { $expectedCount = $count }
    elseif ($count -ne $expectedCount) { throw "Run directory $rd has $count artifact(s), expected $expectedCount (from run_1). A run wrote a partial or different artifact set." }
  }

  $allFiles = @{}
  foreach ($rd in $runDirs) {
    Get-ChildItem -Path $rd -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($rd.Length).TrimStart('\')
      if (-not $allFiles.ContainsKey($rel)) { $allFiles[$rel] = @() }
      $allFiles[$rel] += (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash
    }
  }
  if ($allFiles.Count -eq 0) {
    throw "No artifacts found under $runsArchiveDir -- nothing was compared. Check OutputDir matches CONFIG.OUTPUT_DIR."
  }

  $allMatch = $true
  foreach ($rel in ($allFiles.Keys | Sort-Object)) {
    $hashes = $allFiles[$rel]
    $unique = @($hashes | Select-Object -Unique)
    $status = if ($unique.Count -eq 1) { "IDENTICAL" } else { $allMatch = $false; "MISMATCH ($($unique.Count) variants)" }
    Write-Host ("{0,-40} {1,-10} {2}" -f $rel, $status, $unique[0])
    if ($unique.Count -gt 1) {
      for ($j = 0; $j -lt $hashes.Count; $j++) {
        Write-Host ("    run_{0}: {1}" -f ($j+1), $hashes[$j])
      }
    }
  }
  Write-Host ""
  Write-Host "Compared $($allFiles.Count) artifact(s) x $Runs run(s)."
  if ($allMatch) {
    Write-Host "VERDICT: all artifacts byte-identical across $Runs runs."
  } else {
    Write-Host "VERDICT: NON-DETERMINISTIC -- see mismatches above."
  }
}

Write-Host ""
Write-Host "Exit codes across runs: $($exitCodes -join ', ')"
exit $exitCodes[-1]
