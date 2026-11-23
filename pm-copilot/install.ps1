#!/usr/bin/env pwsh
# Install PM Copilot into the current DSH desktop profile.
#
# The plugin is a bundle: this script does not hand-edit the profile. It asks the
# plugin manager to install the package directory as a bundle, which appends the
# profile's bundle list and dependency, and activates the row. Nothing outside
# `$DSH_PROFILE_DIR` and the package directory is touched.
#
# Usage (from anywhere):
#   pwsh -File install.ps1 [-PackageDir <dir>] [-Dsh <dsh-executable>] [-Profile <name>]
#
# Everything is optional: with no arguments it installs the checkout this script
# lives in, into the profile the environment reports.

param(
    [string]$PackageDir = $PSScriptRoot,
    [string]$Profile = $env:DSH_PROFILE,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) { Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "   $Text" -ForegroundColor Yellow }

Write-Step 'PM Copilot installation'

# 1. Verify the package directory really is the plugin.
$manifestPath = Join-Path $PackageDir 'package.json'
if (-not (Test-Path $manifestPath)) { throw "package.json not found in $PackageDir" }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.name -ne '@local/dsh-pm-copilot') {
    throw "expected @local/dsh-pm-copilot in $manifestPath, found $($manifest.name)"
}
Write-Ok "package: $($manifest.name)@$($manifest.version)"

# 2. Verify the files the bundle needs exist. A missing client artifact or
#    patch would fail activation loudly later, so fail here with the reason.
foreach ($required in @($manifest.main, 'cordis.patch.yml', 'client.js', 'icon.svg', 'locale\zh.json', 'locale\en.json')) {
    if ($null -eq $required) { continue }
    $target = Join-Path $PackageDir $required
    if (-not (Test-Path $target)) { throw "required file missing: $required" }
}
Write-Ok 'required files present (host entry, patch, client artifact, icon, locales)'

# 3. Report the target profile.
if ([string]::IsNullOrWhiteSpace($Profile)) {
    Write-Warn 'DSH_PROFILE is not set: no profile detected in this shell.'
    Write-Warn 'Install from the DSH app, or run this script from a DSH-spawned shell.'
    if (-not $DryRun) { throw 'cannot install without a profile; pass -Profile <name>' }
} else {
    Write-Ok "profile: $Profile"
}

# 4. A dry run stops after the checks.
if ($DryRun) {
    Write-Step 'Dry run: nothing was installed'
    exit 0
}

# 5. Install through the plugin manager. Prefer the agent tool when the script
#    runs inside an agent session (the tool performs the profile edits); the
#    CLI path is the manual fallback printed at the end.
Write-Step 'Installing through the DSH plugin manager'

$installed = $false
try {
    # `dsh` on PATH is not guaranteed for a Desktop install; resolve the module
    # instead of guessing a path.
    $dshArgs = @('plugin', '--profile', $Profile, 'add', "link:$PackageDir")
    $dsh = Get-Command dsh -ErrorAction SilentlyContinue
    if ($null -ne $dsh) {
        & $dsh.Source @dshArgs
        if ($LASTEXITCODE -eq 0) { $installed = $true }
    }
} catch {
    Write-Warn "CLI install unavailable: $($_.Exception.Message)"
}

if (-not $installed) {
    Write-Step 'Install from the app instead (one step)'
    Write-Host @'
   Open DSH > Plugins > Add plugin > choose this directory:

       PACKAGE_DIR

   In an agent session you can also ask the agent to install the bundle at that
   path; the plugin manager performs the same profile edits.

   This script cannot perform the profile edit itself: writing the profile's
   package.json / cordis.patch.yml by hand is not a supported path, and the
   plugin manager is the only supported installer.
'@.Replace('PACKAGE_DIR', $PackageDir)
    exit 2
}

Write-Step 'Next steps'
Write-Host @'
   1. Start a conversation with the 小黄 Agent preset.
   2. The cockpit entry ("驾驶舱") appears in the left sidebar for that session only.
   3. Open it; the first task you create lands in <workspace>/.pm-copilot/.
   4. Restart DSH if the new row is reported as restart-required.
'@
exit 0
