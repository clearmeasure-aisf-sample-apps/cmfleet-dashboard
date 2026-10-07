#Requires -Version 7.4

<#
.SYNOPSIS
    Step "Verify deployable": the health check after every deployment, in every environment.

.DESCRIPTION
    Asks the environment's site until its health address answers ok and its build facts are of this release: a
    deployment takes the platform a moment to publish everywhere. Fails after ten minutes, with what it last answered.

.PARAMETER Environment
    The Octopus environment: tdd, uat or prod.

.PARAMETER Version
    The release that was deployed.

.PARAMETER ResourceGroup
    The resource group of the environment's tier.

.EXAMPLE
    pwsh -NoProfile -File deploy/verify.ps1 -Environment tdd -Version 1.0.12 -ResourceGroup rg-cmfleet-nonprod
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Environment,
    [Parameter(Mandatory)] [string] $Version,
    [Parameter(Mandatory)] [string] $ResourceGroup
)

. (Join-Path $PSScriptRoot 'common.ps1')

function Read-Answer {
    # What an address answers, in a few words: the JSON it served, or why there is none.
    param([Parameter(Mandatory)] [string] $Uri)
    try {
        $answer = Invoke-WebRequest -Uri $Uri -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 60 -SkipHttpErrorCheck
        if ([int] $answer.StatusCode -ne 200) { return @{ Said = "HTTP $([int] $answer.StatusCode)" } }
        $text = if ($answer.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($answer.Content) } else { [string] $answer.Content }
        return @{ Said = 'HTTP 200'; Json = ($text | ConvertFrom-Json -AsHashtable) }
    }
    catch {
        return @{ Said = $_.Exception.Message }
    }
}

$url = Get-SiteUrl -Environment $Environment -ResourceGroup $ResourceGroup
$deadline = (Get-Date).AddMinutes(10)
while ($true) {
    $health = Read-Answer -Uri "$url/health.json"
    $build = Read-Answer -Uri "$url/build.json"
    $healthy = $health.ContainsKey('Json') -and [string] $health.Json['status'] -eq 'ok'
    $served = if ($build.ContainsKey('Json')) { [string] $build.Json['version'] } else { $build.Said }
    if ($healthy -and $served -eq $Version) { break }
    if ((Get-Date) -gt $deadline) {
        Stop-Step "$url is not healthy with release $Version after 10 minutes: health.json answered '$($health.Said)', build.json serves '$served'."
    }
    Write-Host "$url/health.json answered '$($health.Said)', build.json serves '$served', not $Version yet; retrying"
    Start-Sleep -Seconds 15
}
Write-Highlight "PASS $url is healthy and serves release $Version"
