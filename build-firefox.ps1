# OG-E: Build Firefox .zip for AMO submission
# Usage: open PowerShell in this folder and run:
#   .\build-firefox.ps1
#
# Produces: dist\oge-firefox-<version>.zip
# The zip contains manifest.firefox.json renamed to manifest.json + all runtime files.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# Read version from the firefox manifest
$manifestPath = Join-Path $here 'manifest.firefox.json'
if (-not (Test-Path $manifestPath)) {
    throw "manifest.firefox.json not found in $here"
}
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
Write-Host "Building OG-E Firefox package, version $version" -ForegroundColor Cyan

# Files that go into the package (everything the extension needs at runtime)
$includeFiles = @(
    'mobile.js',
    'content.js',
    'sync.js',
    'colonize.js',
    'fleet-redirect.js',
    'settings.js',
    'histogram.html',
    'histogram.js'
)

$includeIcons = @(
    'icons\icon16.png',
    'icons\icon48.png',
    'icons\icon128.png'
)

# Sanity check
foreach ($f in $includeFiles + $includeIcons) {
    if (-not (Test-Path (Join-Path $here $f))) {
        throw "Missing required file: $f"
    }
}

# Stage in a temp folder so we can rename manifest.firefox.json -> manifest.json
$staging = Join-Path $here ('build-staging-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging 'icons') | Out-Null

try {
    # Manifest (renamed)
    Copy-Item $manifestPath (Join-Path $staging 'manifest.json')

    # Runtime files
    foreach ($f in $includeFiles) {
        Copy-Item (Join-Path $here $f) (Join-Path $staging $f)
    }

    # Icons
    foreach ($f in $includeIcons) {
        Copy-Item (Join-Path $here $f) (Join-Path $staging $f)
    }

    # Output
    $distDir = Join-Path $here 'dist'
    if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
    $outZip = Join-Path $distDir ("oge-firefox-$version.zip")
    if (Test-Path $outZip) { Remove-Item $outZip -Force }

    # Build the zip MANUALLY with forward-slash entry names. We can't use
    # ZipFile::CreateFromDirectory because on Windows it writes paths with
    # backslashes, which AMO rejects ("Invalid file name in archive: icons\..").
    # ZIP spec requires forward slashes, regardless of host OS.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $zipStream = [System.IO.File]::Open($outZip, [System.IO.FileMode]::Create)
    try {
        $zip = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            $stagingFull = (Resolve-Path $staging).Path
            $stagingPrefix = $stagingFull.TrimEnd('\') + '\'
            Get-ChildItem $staging -Recurse -File | ForEach-Object {
                $relPath = $_.FullName.Substring($stagingPrefix.Length).Replace('\', '/')
                $entry = $zip.CreateEntry($relPath, [System.IO.Compression.CompressionLevel]::Optimal)
                $entryStream = $entry.Open()
                try {
                    $fileBytes = [System.IO.File]::ReadAllBytes($_.FullName)
                    $entryStream.Write($fileBytes, 0, $fileBytes.Length)
                } finally {
                    $entryStream.Dispose()
                }
            }
        } finally {
            $zip.Dispose()
        }
    } finally {
        $zipStream.Dispose()
    }

    Write-Host "Built: $outZip" -ForegroundColor Green
    $size = (Get-Item $outZip).Length
    Write-Host ("Size: {0:N1} KB" -f ($size / 1024)) -ForegroundColor Green
    Write-Host ""
    Write-Host "Files in package:" -ForegroundColor Cyan
    $readZip = [System.IO.Compression.ZipFile]::OpenRead($outZip)
    try {
        $readZip.Entries | ForEach-Object {
            Write-Host ("  {0,8}  {1}" -f $_.Length, $_.FullName)
        }
    } finally {
        $readZip.Dispose()
    }
} finally {
    Remove-Item $staging -Recurse -Force
}
