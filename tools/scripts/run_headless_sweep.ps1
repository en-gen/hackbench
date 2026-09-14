<#
.SYNOPSIS
    27-level acceptance sweep for headless_capture.lua's rewritten
    verification layer (write-callback on Layer1DataPtr instead of
    poll+debounce). See docs/ideas/emulator-oracle-testing.md and
    tools/mesen/README.md.

.DESCRIPTION
    Runs tools/scripts/run_headless_capture.ps1 once per level in $Levels,
    each into its own subdirectory of $SweepDir (all under THIS worktree --
    never the main checkout), and prints a table of exit codes. The six
    levels that false-failed under the old poll+debounce design ($013, $01F,
    $0DB, $101, $1DA, $1DB) are included and flagged in the table -- they are
    the whole reason this rewrite exists, so tuning the sweep to omit them
    would repeat the original mistake (tuning verification to level $105
    alone).

    All arguments to the inner script are passed as fully-resolved absolute
    paths deliberately -- relative paths resolve against .NET's
    Environment.CurrentDirectory, which does not reliably track PowerShell's
    Set-Location in every host this runs under, and a relative -OutputDir
    silently writing into the wrong checkout is exactly the kind of
    pollution tools/mesen/README.md and the task's hard constraints forbid.

.EXAMPLE
    ./run_headless_sweep.ps1
#>
param(
  [string]$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path,
  [string]$MesenExe   = "C:/Projects/hackbench/tools/mesen/Mesen.exe",
  [string]$Rom        = "C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc",
  [string]$LuaScript  = $(Join-Path $PSScriptRoot "../mesen/headless_capture.lua"),
  [string]$SramPath   = "C:/Projects/hackbench/tools/mesen/Saves/Super Mario World (USA).vanilla.srm",
  [string]$SweepDir   = $(Join-Path $PSScriptRoot "../mesen/sweep_output"),
  [int]$TimeoutSec    = 90
)

$ErrorActionPreference = "Stop"
$LuaScript = (Resolve-Path $LuaScript).Path
$SweepDir  = [System.IO.Path]::GetFullPath($SweepDir)
$runner    = (Resolve-Path (Join-Path $PSScriptRoot "run_headless_capture.ps1")).Path

# The 27-level acceptance set. Must include all six levels that false-failed
# under the old poll+debounce design (marked below) -- the whole point of
# this sweep is to prove the rewrite fixes them without regressing anything
# else, not to tune against a single convenient level again.
$PreviouslyFailing = @(0x013, 0x01F, 0x0DB, 0x101, 0x1DA, 0x1DB)
$Levels = @(
  0x001, 0x013, 0x01F, 0x024, 0x025, 0x050, 0x07F, 0x0A0, 0x0C0, 0x0D0, 0x0DA, 0x0DB,
  0x101, 0x102, 0x105, 0x110, 0x120, 0x140, 0x160, 0x180, 0x1A0, 0x1C0, 0x1CF, 0x1D0, 0x1D9, 0x1DA, 0x1DB
)
if ($Levels.Count -ne 27) { throw "Expected 27 levels, got $($Levels.Count)" }

$results = @()
foreach ($lvl in $Levels) {
  $hex = "{0:x3}" -f $lvl
  Write-Host ""
  Write-Host "=== Sweep: level `$$hex ==="
  $outDir = Join-Path $SweepDir $hex
  & $runner -MesenExe $MesenExe -Rom $Rom -LuaScript $LuaScript -SramPath $SramPath `
            -OutputDir $outDir -LevelId ("0x{0}" -f $hex) -TimeoutSec $TimeoutSec | Out-Null
  $code = $LASTEXITCODE
  $logPath = Join-Path $outDir "debug.log"
  $lastLine = if (Test-Path $logPath) { (Get-Content $logPath -Tail 1) } else { "<no debug.log>" }
  $flagged = $PreviouslyFailing -contains $lvl
  $results += [pscustomobject]@{
    Level             = "`$$hex"
    ExitCode          = $code
    PreviouslyFailing = $flagged
    LastLogLine       = $lastLine
  }
  Write-Host ("  exit={0}  previously_failing={1}" -f $code, $flagged)
}

Write-Host ""
Write-Host "=== 27-level sweep results ==="
$results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

$reachableBad = $results | Where-Object { $_.ExitCode -ne 0 }
Write-Host ""
if ($reachableBad.Count -eq 0) {
  Write-Host "VERDICT: all $($results.Count) reachable levels exited 0."
} else {
  Write-Host "VERDICT: FAILED -- $($reachableBad.Count) level(s) did not exit 0:"
  $reachableBad | ForEach-Object { Write-Host ("  {0}: exit {1}" -f $_.Level, $_.ExitCode) }
}

$stillFailing = $results | Where-Object { $_.PreviouslyFailing -and $_.ExitCode -ne 0 }
if ($stillFailing.Count -gt 0) {
  Write-Host "REGRESSION: previously-failing level(s) still failing: $($stillFailing.Level -join ', ')"
  exit 1
}

exit ($(if ($reachableBad.Count -eq 0) { 0 } else { 1 }))
