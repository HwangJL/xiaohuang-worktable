#!/usr/bin/env pwsh
# Remove PM Copilot from the DSH desktop profile WITHOUT deleting any work.
#
# Removal deletes the bundle row and its dependency. It deliberately leaves
# everything the plugin produced:
#
#   <workspace>/.pm-copilot/   the cockpit index, audit log, PRD versions, quality reports
#   <workspace>/kb/            the knowledge base the cockpit wrote pages into
#   <workspace>/docs, prd/     any extra roots the user declared in roots.json
#
# Those are the user's own project files: uninstalling a plugin must never remove
# them. Delete them yourself only if you really want that.
#
# Usage:
#   pwsh -File uninstall.ps1 [-Profile <name>] [-Workspace <dir>] [-Purge] [-DryRun]
#
#   -Purge   also deletes <workspace>/.pm-copilot (asks for confirmation first).
#            It NEVER deletes kb/.

param(
    [string]$Profile = $env:DSH_PROFILE,
    [string]$Workspace = '',
    [switch]$Purge,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) { Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "   $Text" -ForegroundColor Yellow }

$PackageName = '@local/dsh-pm-copilot'

Write-Step 'PM Copilot uninstall'

if ([string]::IsNullOrWhiteSpace($Profile)) {
    Write-Warn 'DSH_PROFILE is not set: pass -Profile <name> to name the profile.'
    if (-not $DryRun) { throw 'cannot uninstall without a profile' }
}

if (-not $DryRun) {
    $dsh = Get-Command dsh -ErrorAction SilentlyContinue
    $removed = $false
    if ($null -ne $dsh) {
        try {
            & $dsh.Source plugin --profile $Profile remove $PackageName
            $removed = $LASTEXITCODE -eq 0
        } catch {
            Write-Warn "CLI removal unavailable: $($_.Exception.Message)"
        }
    }
    if (-not $removed) {
        Write-Step 'Remove from the app instead (one step)'
        Write-Host @'
   Open DSH > Plugins, find "PM Copilot (产品经理驾驶舱)", and remove/disable it.

   This script does not edit the profile by hand on purpose: the plugin manager
   owns those files, and a hand edit can corrupt other plugins' rows.
'@
        exit 2
    }
    Write-Ok "bundle row $PackageName removed"
} else {
    Write-Host "   dry run: would remove bundle row $PackageName from profile $Profile"
}

# Report what was kept, so the user can see nothing of their work vanished.
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = (Get-Location).Path
}
$dataRoot = Join-Path $Workspace '.pm-copilot'
$kbRoot = Join-Path $Workspace 'kb'

Write-Step 'Work that was kept'
if (Test-Path $dataRoot) {
    $stateFile = Join-Path $dataRoot 'state.json'
    if (Test-Path $stateFile) {
        $state = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Ok ("cockpit state: {0} tasks, {1} decisions, {2} PRDs, {3} quality issues" -f `
            @($state.tasks).Count, @($state.decisions).Count, @($state.prds).Count, @($state.quality.issues).Count)
    }
    Write-Ok "kept: $dataRoot"
} else {
    Write-Warn "no cockpit data at $dataRoot (nothing to keep)"
}
if (Test-Path $kbRoot) { Write-Ok "kept: $kbRoot" } else { Write-Warn "no knowledge base at $kbRoot" }

if ($Purge) {
    if (-not (Test-Path $dataRoot)) { Write-Warn 'nothing to purge'; exit 0 }
    if ($DryRun) {
        Write-Host "   dry run: would delete $dataRoot"
        exit 0
    }
    Write-Warn "About to DELETE the cockpit index at $dataRoot"
    Write-Warn 'The knowledge base (kb/) and every project file stay untouched.'
    $answer = Read-Host 'Type YES to delete the cockpit index'
    if ($answer -ne 'YES') {
        Write-Warn 'aborted: nothing was deleted'
        exit 1
    }
    Remove-Item -LiteralPath $dataRoot -Recurse -Force
    Write-Ok "deleted: $dataRoot"
} else {
    Write-Warn 'cockpit data was kept (add -Purge to delete only the .pm-copilot index)'
}

Write-Step 'Done'
exit 0
