#Requires -Version 7.4

<#
.SYNOPSIS
    Step "Update deployable": makes the environment's site what this release says it is, and puts the release on it.

.DESCRIPTION
    Runs in the release's extracted package, signed in to Azure as the tier's deploy identity.
    1. Applies deploy/site.json to the environment's resource group: the pipeline creates the environment, nobody
       does by hand.
    2. Reads the site's deployment token, keeps it in a variable and in the CLI's environment only, and deploys the
       folder site/ with the Static Web Apps CLI.

.PARAMETER Environment
    The Octopus environment: tdd, uat or prod.

.PARAMETER Version
    The release being deployed.

.PARAMETER ResourceGroup
    The resource group of the environment's tier.

.EXAMPLE
    pwsh -NoProfile -File deploy/deploy.ps1 -Environment tdd -Version 1.0.12 -ResourceGroup rg-cmfleet-nonprod
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Environment,
    [Parameter(Mandatory)] [string] $Version,
    [Parameter(Mandatory)] [string] $ResourceGroup
)

. (Join-Path $PSScriptRoot 'common.ps1')

$swaCliVersion = '2.0.10'
$environmentName = $Environment.ToLowerInvariant()
$root = Split-Path -Parent $PSScriptRoot
$served = (Get-Content -LiteralPath (Join-Path $root 'site/version.json') -Raw | ConvertFrom-Json).version
if ($served -ne $Version) { Stop-Step "The package holds version $served, not the release $Version." }

Write-Host "==> the site of $environmentName in $ResourceGroup"
$outputs = az deployment group create --resource-group $ResourceGroup --name "cmfleet-dashboard-$environmentName" --template-file (Join-Path $PSScriptRoot 'site.json') --parameters "environmentName=$environmentName" --query properties.outputs --only-show-errors --output json | ConvertFrom-Json
$siteName = [string] $outputs.siteName.value
$url = [string] $outputs.url.value
Write-Host "PASS $siteName at $url"

# The deployment token: read now, kept in this variable only, handed to the CLI through its environment (never an
# argument, which a process list shows), and removed from the environment when the CLI has ended.
$token = ([string] (az staticwebapp secrets list --name $siteName --resource-group $ResourceGroup --query properties.apiKey --only-show-errors --output tsv)).Trim()
if (-not $token) { Stop-Step "Azure returned no deployment token for $siteName." }

# The CLI (and npx before it) reports its progress on stderr, which Octopus would log as errors: what it writes is
# captured and shown as information, and its exit code decides. It takes its working directory as the app's location
# and searches it, so it runs in a folder of its own that holds nothing but the site.
Write-Host "==> $Version onto $siteName with the Static Web Apps CLI $swaCliVersion (Node.js $((node --version).Trim()))"
$env:NO_COLOR = '1'
$env:npm_config_update_notifier = 'false'
$stage = Join-Path ([IO.Path]::GetTempPath()) "site-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'site') -Destination (Join-Path $stage 'site') -Recurse
Push-Location -LiteralPath $stage
try {
    $env:SWA_CLI_DEPLOYMENT_TOKEN = $token
    $PSNativeCommandUseErrorActionPreference = $false
    $output = @(npx --yes "@azure/static-web-apps-cli@$swaCliVersion" deploy ./site --env production 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
}
finally {
    $PSNativeCommandUseErrorActionPreference = $true
    Remove-Item -LiteralPath Env:SWA_CLI_DEPLOYMENT_TOKEN -ErrorAction SilentlyContinue
    Pop-Location
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
# Colour codes out, and the token too, should a tool ever echo it.
$lines = @($output | ForEach-Object { ($_ -replace '\x1b\[[0-9;?]*[ -/]*[@-~]', '').Replace($token, '***').TrimEnd() } | Where-Object { $_ })
$token = $null
$lines | ForEach-Object { Write-Host "  $_" }
if ($code -ne 0) { Stop-Step "The Static Web Apps CLI ended with exit code $code while deploying $Version to ${siteName}; its output is above." }
Write-Host "PASS $Version handed to $siteName"
