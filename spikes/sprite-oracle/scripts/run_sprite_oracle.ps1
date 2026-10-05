<#
.SYNOPSIS
  Runs the sprite routine oracle (spikes/sprite-oracle/mesen/sprite_routine_trace.lua, or
  sprite_spawn_extract.lua with -Mode spawn) under Mesen, one launch at a
  time, hidden. Output is ROM-derived: -OutRoot must be outside every git repo.

.EXAMPLE
  ./run_sprite_oracle.ps1 -Mode level -Maps 105,106 -K 3
  ./run_sprite_oracle.ps1 -Mode spawn -Ids 0,5,1f,4d,4f
  HB_MESEN, HB_ROM, HB_MESEN_SAVES (Mesen 2.x path; ROM path; saves dir); HB_FIXTURES
  is the fixtures root (…/hackbench-tools/fixtures).
#>
param(
  [ValidateSet("level", "spawn")][string]$Mode = "level",
  [string[]]$Maps = @(),          # level mode: hex map ids
  [string[]]$Ids = @(),           # spawn mode: hex sprite ids; empty = $00-$C8
  [int]$K = 0,                    # frames; default 3 (level) / 16 (spawn)
  [string]$SpawnLevel = "0bd",
  [string]$MesenExe = "", [string]$Rom = "", [string]$SavesDir = "", [string]$OutRoot = "",
  [int]$TimeoutSec = 300
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "config.ps1")
$MesenExe = Resolve-Configured $MesenExe "HB_MESEN" "Mesen" "MesenExe"
$Rom = Resolve-Configured $Rom "HB_ROM" "The ROM" "Rom"
$fixtures = Resolve-Configured $OutRoot "HB_FIXTURES" "The fixtures root" "OutRoot"
$sram = Resolve-SaveFile $SavesDir $Rom
if ($K -le 0) { $K = if ($Mode -eq "level") { 3 } else { 16 } }
$sha = (Get-FileHash -Path $Rom -Algorithm SHA1).Hash.ToLower().Substring(0, 8)
$sub = if ($Mode -eq "level") { "sprite-trace" } else { "sprite-spawn" }
$lua = Join-Path $PSScriptRoot ("../mesen/" + $(if ($Mode -eq "level") { "sprite_routine_trace.lua" } else { "sprite_spawn_extract.lua" }))
$lua = (Resolve-Path $lua).Path
$root = Join-Path (Resolve-FullPath $fixtures) "$sub/$sha"
# ROM-derived bytes never go in a git checkout.
$probe = $root
while ($probe -and -not (Test-Path (Join-Path $probe ".git"))) { $probe = Split-Path $probe -Parent }
if ($probe) { throw "OutRoot $root is inside a git repo ($probe)." }

$items = if ($Mode -eq "level") { $Maps | ForEach-Object { ConvertTo-MapName $_ } } else {
  if ($Ids.Count -eq 0) { 0..200 | ForEach-Object { "{0:x2}" -f $_ } } else { $Ids | ForEach-Object { "{0:x2}" -f [Convert]::ToInt32(($_ -replace '^(0x|\$)', ''), 16) } }
}
$spawnIds = @()
if ($Mode -eq "spawn") {
  # Spawn runs one Mesen launch for all requested ids (a savestate per id);
  # the Lua cannot create folders (a process started from Mesen opens a
  # window), so every id's folder is made here first.
  $spawnIds = @($items)
  $items = @("batch")
}
$guard = Backup-SaveFile $sram
$results = @()
try {
  foreach ($item in $items) {
    $target = Join-Path $root $(if ($Mode -eq "level") { $item } else { "_run" })
    $staging = "$target.staging"
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    if (Test-Path $sram) { Remove-Item $sram -Force }
    foreach ($sid in $spawnIds) { New-Item -ItemType Directory -Path (Join-Path $staging $sid) -Force | Out-Null }
    $env:HB_MODE = $Mode; $env:HB_CAPTURE_OUT = $staging; $env:HB_K_FRAMES = "$K"
    $env:HB_ORACLE_LIB = (Resolve-Path (Join-Path $PSScriptRoot "../mesen/sprite_routine_trace.lua")).Path
    if ($Mode -eq "level") { $env:HB_LEVEL_ID = "0x$item" }
    else {
      $env:HB_SPAWN_LEVEL = "0x$SpawnLevel"
      $env:HB_SPAWN_IDS = ($spawnIds -join ",")
    }
    $mesenArgs = @("--testrunner", $lua, $Rom, "--snes.rampoweronstate=AllZeros", "--snes.disableframeskipping=true")
    $t0 = Get-Date
    $proc = [System.Diagnostics.Process]::Start((New-HiddenStartInfo $MesenExe $mesenArgs))
    while (-not $proc.WaitForExit(200) -and ((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) { }
    if ($proc.HasExited) { $code = $proc.ExitCode } else { Stop-Hidden $proc; $code = 124 }
    $secs = [int]((Get-Date) - $t0).TotalSeconds
    $marker = if ($Mode -eq "level") { "meta.json" } else { "baseline_wram.bin" }
    if ($code -eq 0 -and (Test-Path (Join-Path $staging $marker))) {
      if (Test-Path $target) { Remove-Item $target -Recurse -Force }
      Move-Item $staging $target
      if ($Mode -eq "spawn") {
        Get-ChildItem $target -Directory | ForEach-Object {
          $dst = Join-Path $root $_.Name
          if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
          Move-Item $_.FullName $dst
        }
        Get-ChildItem $target -File | ForEach-Object { Move-Item $_.FullName (Join-Path $root $_.Name) -Force }
        Remove-Item $target -Recurse -Force
      }
    }
    Write-Host ("{0} {1}: exit {2} in {3}s" -f $Mode, $item, $code, $secs)
    $results += $code
    if ($code -ne 0) { Write-Warning "failed; log kept in $staging" }
  }
}
finally { Restore-SaveFile $guard }
if ($results | Where-Object { $_ -ne 0 }) { exit 1 }
