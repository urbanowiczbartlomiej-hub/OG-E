# OG-E: Check GitHub API rate limit
# Usage:
#   .\check-rate-limit.ps1                  → prompts for token (hidden input)
#   .\check-rate-limit.ps1 -Token ghp_xxx   → pass token directly
#
# The /rate_limit endpoint itself does NOT count against your quota,
# so you can run this freely.

param(
    [string]$Token = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Token) {
    $secure = Read-Host -Prompt "Paste GitHub token (input hidden)" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $Token = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$Token = $Token.Trim()
if (-not $Token) { throw "No token provided." }

$headers = @{
    'Authorization' = "Bearer $Token"
    'Accept' = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent' = 'OG-E-rate-check'
}

try {
    $response = Invoke-RestMethod -Uri 'https://api.github.com/rate_limit' -Headers $headers -Method Get
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Host $reader.ReadToEnd() -ForegroundColor Red
    }
    exit 1
}

function Show-Bucket($name, $bucket) {
    if (-not $bucket) { return }
    $used = $bucket.used
    $limit = $bucket.limit
    $remaining = $bucket.remaining
    $resetEpoch = [int64]$bucket.reset
    $resetLocal = [DateTimeOffset]::FromUnixTimeSeconds($resetEpoch).LocalDateTime
    $now = Get-Date
    $minutesUntilReset = [math]::Round(($resetLocal - $now).TotalMinutes, 1)
    $pct = if ($limit -gt 0) { [math]::Round(($used / $limit) * 100, 1) } else { 0 }

    $color = 'Green'
    if ($pct -gt 80) { $color = 'Red' }
    elseif ($pct -gt 50) { $color = 'Yellow' }

    Write-Host ""
    Write-Host ("  [$name]") -ForegroundColor Cyan
    Write-Host ("    Used:      $used / $limit ($pct`%)") -ForegroundColor $color
    Write-Host ("    Remaining: $remaining")
    Write-Host ("    Resets at: $($resetLocal.ToString('HH:mm:ss')) (in $minutesUntilReset min)")
}

Write-Host "`nGitHub API rate limit status" -ForegroundColor White
Write-Host "===============================" -ForegroundColor DarkGray

$res = $response.resources
Show-Bucket 'core (REST API — your sync uses this)' $res.core
Show-Bucket 'search' $res.search
Show-Bucket 'graphql' $res.graphql
Show-Bucket 'integration_manifest' $res.integration_manifest
Show-Bucket 'code_search' $res.code_search

Write-Host ""
Write-Host "Tip: 'core' is what OG-E sync hits. If it's low, wait until reset." -ForegroundColor DarkGray
Write-Host "     /rate_limit calls don't count against the quota." -ForegroundColor DarkGray
Write-Host ""
