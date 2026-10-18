<#
.SYNOPSIS
    Download and verify a dsh-github-gate release, and print the install step.

.DESCRIPTION
    This installer does the two things it can do honestly: fetch the published
    tarball and verify it against the sha256 GitHub publishes for that asset. It
    does NOT install, because installing rewrites the Harness profile and the tool
    that owns that (`plugin_manager install_bundle`) asks for approval — that is the
    point at which downloaded code is allowed to run.

    So the script ends by printing the absolute path plus the exact call to make.
    A one-liner that claims to install but only drops a file somewhere would be
    worse than this.

.PARAMETER Version
    Release tag to fetch, e.g. v2.0.0. Defaults to the latest release.

.PARAMETER Dest
    Directory to download into. Defaults to a folder in the temp directory.

.PARAMETER Repo
    owner/name to read releases from. Defaults to this project's repository.

.EXAMPLE
    irm https://raw.githubusercontent.com/1273984347/dsh-github-gate/main/install.ps1 | iex

.EXAMPLE
    ./install.ps1 -Version v2.0.0 -Verbose
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$Dest = (Join-Path $env:TEMP 'dsh-github-gate-install'),
    [string]$Repo = '1273984347/dsh-github-gate'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "  ok  $message" -ForegroundColor Green }

Write-Step "Reading the release for $Repo"

$apiBase = "https://api.github.com/repos/$Repo/releases"
$headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'dsh-github-gate-installer' }

# PowerShell uses the Windows/macOS/Linux trust store, which is exactly why this
# works here and a plain `fetch` from Node may not: on a TLS-intercepting machine
# Node's bundled CA store rejects the proxy's certificate while the OS store trusts it.
$release = if ($Version -ne '') {
    Invoke-RestMethod -Uri "$apiBase/tags/$Version" -Headers $headers
} else {
    Invoke-RestMethod -Uri "$apiBase/latest" -Headers $headers
}

if ($release.prerelease -eq $true -and $Version -eq '') {
    Write-Warning "The latest release is a prerelease ($($release.tag_name))."
}

$asset = $release.assets | Where-Object { $_.name -like '*.tgz' } | Select-Object -First 1
if ($null -eq $asset) {
    throw "Release $($release.tag_name) carries no installable .tgz asset."
}

$expected = if ($null -ne $asset.digest -and $asset.digest -match '^sha256:([0-9a-f]{64})$') { $Matches[1].ToLower() } else { '' }
Write-Ok "release $($release.tag_name), asset $($asset.name) ($($asset.size) bytes)"
if ($expected -eq '') {
    Write-Warning 'This release publishes no sha256 digest, so the download cannot be verified against GitHub.'
}

if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest -Force | Out-Null }
$target = Join-Path $Dest $asset.name

Write-Step "Downloading to $target"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $target -Headers $headers
Write-Ok "downloaded $((Get-Item $target).Length) bytes"

if ($expected -ne '') {
    Write-Step 'Verifying sha256'
    $actual = (Get-FileHash -Path $target -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        Remove-Item $target -Force
        throw "Digest mismatch (expected $expected, got $actual). The download was deleted."
    }
    Write-Ok "sha256 matches the digest GitHub publishes"
}

Write-Host ''
Write-Host 'Not installed — two things remain, and neither belongs to this script:' -ForegroundColor Yellow
Write-Host '  1. install the path above with the Harness plugin manager:'
Write-Host "       plugin_manager { action: ""install_bundle"", target: ""$target"" }"
Write-Host '  2. verify the running generation afterwards (a tool or Config key that only'
Write-Host '     exists in the new version). The plugin manager re-activates the entry; the'
Write-Host '     installed package.json is not proof, because pnpm replaces it first.'
Write-Host ''
Write-Host "Tarball: $target"
