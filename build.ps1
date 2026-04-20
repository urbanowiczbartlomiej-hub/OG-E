# Build ZIP packages for Chrome and Firefox
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Add-Type -AssemblyName System.IO.Compression.FileSystem

$files = @("content.js", "fleet-redirect.js", "colonize.js", "mobile.js", "settings.js", "sync.js", "histogram.html", "histogram.js", "README.txt", "icons/icon16.png", "icons/icon48.png")

if (Test-Path dist) { Remove-Item dist -Recurse -Force }
New-Item -ItemType Directory -Path dist | Out-Null

function New-Zip($zipPath, $manifestSource) {
    $fullZipPath = (Join-Path $PWD $zipPath)
    if (Test-Path $fullZipPath) { Remove-Item $fullZipPath }
    $zip = [System.IO.Compression.ZipFile]::Open($fullZipPath, 'Create')
    try {
        # Add manifest
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Resolve-Path $manifestSource), "manifest.json") | Out-Null
        # Add shared files
        foreach ($f in $files) {
            $entryName = $f -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Resolve-Path $f), $entryName) | Out-Null
        }
    } finally {
        $zip.Dispose()
    }
}

New-Zip "dist/oge-chrome.zip" "manifest.json"
New-Zip "dist/oge-firefox.zip" "manifest.firefox.json"

Write-Host "Done:"
Get-ChildItem dist | Format-Table Name, Length
