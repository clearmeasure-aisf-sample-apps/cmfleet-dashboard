#Requires -Version 7.4

<#
.SYNOPSIS
    Step "Run acceptance tests": the acceptance suite against the deployed first environment.

.DESCRIPTION
    Runs acceptance/deployed.test.js of the release's package with Node.js against the environment's site. A release
    whose first environment fails here goes no further.

.PARAMETER Environment
    The Octopus environment the tests run against.

.PARAMETER Version
    The release that was deployed.

.PARAMETER ResourceGroup
    The resource group of the environment's tier.

.EXAMPLE
    pwsh -NoProfile -File deploy/acceptance.ps1 -Environment tdd -Version 1.0.12 -ResourceGroup rg-cmfleet-nonprod
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Environment,
    [Parameter(Mandatory)] [string] $Version,
    [Parameter(Mandatory)] [string] $ResourceGroup
)

. (Join-Path $PSScriptRoot 'common.ps1')

$env:SITE_URL = Get-SiteUrl -Environment $Environment -ResourceGroup $ResourceGroup
$env:EXPECT_VERSION = $Version
$env:NO_COLOR = '1'
$tests = Join-Path (Split-Path -Parent $PSScriptRoot) 'acceptance/deployed.test.js'
Write-Host "==> acceptance tests against $env:SITE_URL (Node.js $((node --version).Trim()))"
# The test runner reports on stdout; whatever it writes on stderr is shown as information, and its exit code decides.
$PSNativeCommandUseErrorActionPreference = $false
$output = @(node --test --test-reporter=spec $tests 2>&1 | ForEach-Object { "$_" })
$code = $LASTEXITCODE
$PSNativeCommandUseErrorActionPreference = $true
$output | Where-Object { $_.Trim() } | ForEach-Object { Write-Host "  $_" }
if ($code -ne 0) { Stop-Step "The acceptance tests failed against $env:SITE_URL; their output is above." }
Write-Highlight "PASS acceptance tests against $env:SITE_URL"
