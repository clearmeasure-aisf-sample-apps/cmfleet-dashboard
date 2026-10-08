#Requires -Version 7.4

<#
.SYNOPSIS
    Step "Update deployable": makes the environment's site what this release says it is, and puts the release on it.

.DESCRIPTION
    Runs in the release's extracted package, signed in to Azure as the tier's deploy identity.
    1. Applies deploy/site.json to the environment's resource group: the pipeline creates the environment, nobody
       does by hand.
    2. Switches the account's static website on (index.html, and 404.html for an address that is not there).
    3. Writes the folder site/ into the account's $web container as that identity, with no key, and removes what the
       release no longer holds. Every file is served with Cache-Control: no-cache, so a reader gets this release.
    4. Removes the Static Web App the environment used to be, where one is left.

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

function Invoke-Storage {
    # One Azure CLI call against the account's data, as the signed-in identity. The CLI reports progress on stderr,
    # which Octopus would log as errors: what it writes is captured, and its exit code decides. A new account takes
    # the identity's role on the resource group a moment to honour, so a refusal is asked again for five minutes.
    param([Parameter(Mandatory)] [string] $What, [Parameter(Mandatory)] [string[]] $Arguments)
    $deadline = (Get-Date).AddMinutes(5)
    while ($true) {
        $PSNativeCommandUseErrorActionPreference = $false
        $output = @(az storage @Arguments --auth-mode login --only-show-errors 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
        $PSNativeCommandUseErrorActionPreference = $true
        if ($code -eq 0) { return $output }
        $refused = @($output | Where-Object { $_ -match 'AuthorizationPermissionMismatch|AuthorizationFailure|not authorized to perform this operation' }).Count -gt 0
        if (-not $refused -or (Get-Date) -gt $deadline) {
            $output | Where-Object { $_.Trim() } | ForEach-Object { Write-Host "  $_" }
            Stop-Step "Azure CLI ended with exit code $code while it tried to ${What}; its output is above."
        }
        Write-Host "Azure does not let this identity $What yet; asking again"
        Start-Sleep -Seconds 20
    }
}

$environmentName = $Environment.ToLowerInvariant()
$root = Split-Path -Parent $PSScriptRoot
$site = Join-Path $root 'site'
$served = (Get-Content -LiteralPath (Join-Path $site 'version.json') -Raw | ConvertFrom-Json).version
if ($served -ne $Version) { Stop-Step "The package holds version $served, not the release $Version." }

Write-Host "==> the site of $environmentName in $ResourceGroup"
$outputs = az deployment group create --resource-group $ResourceGroup --name "cmfleet-dashboard-$environmentName" --template-file (Join-Path $PSScriptRoot 'site.json') --parameters "environmentName=$environmentName" --query properties.outputs --only-show-errors --output json | ConvertFrom-Json
$account = [string] $outputs.accountName.value
$url = ([string] $outputs.url.value).TrimEnd('/')
Invoke-Storage -What "switch the website of $account on" -Arguments @('blob', 'service-properties', 'update', '--account-name', $account, '--static-website', 'true', '--index-document', 'index.html', '--404-document', '404.html', '--output', 'none') | Out-Null
Write-Host "PASS $account serves a website at $url"

Write-Host "==> $Version into $account"
Invoke-Storage -What "write the site into $account" -Arguments @('blob', 'upload-batch', '--account-name', $account, '--destination', '$web', '--source', $site, '--overwrite', 'true', '--content-cache-control', 'no-cache', '--no-progress', '--output', 'none') | Out-Null
$files = @(Get-ChildItem -LiteralPath $site -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath($site, $_.FullName).Replace('\', '/') })
$blobs = @((Invoke-Storage -What "list the files of $account" -Arguments @('blob', 'list', '--account-name', $account, '--container-name', '$web', '--query', '[].name', '--output', 'json')) -join "`n" | ConvertFrom-Json)
$left = @($blobs | Where-Object { $files -cnotcontains $_ })
foreach ($name in $left) {
    Invoke-Storage -What "remove $name from $account" -Arguments @('blob', 'delete', '--account-name', $account, '--container-name', '$web', '--name', $name, '--output', 'none') | Out-Null
}
Write-Host "PASS $Version is in ${account}: $($files.Count) files written$(if ($left.Count -gt 0) { ", $($left.Count) of an earlier release removed" })"

# Until 2026-10-08 an environment was a Static Web App on the Free plan. What is left of it is removed, so that the
# environment is what this release says and nothing more, and the subscription has its Free site back.
$former = "swa-cmfleet-$environmentName-dashboard"
function Test-FormerSite {
    return [bool] ([string] (az staticwebapp list --resource-group $ResourceGroup --query "[?name=='$former'].name | [0]" --only-show-errors --output tsv)).Trim()
}
if (Test-FormerSite) {
    Write-Host "==> the former site $former"
    # Not waited for by the CLI: it follows the removal at an address of the subscription, which an identity that
    # holds its role on one resource group may not read. The resource group's own list says when the site is gone.
    az staticwebapp delete --name $former --resource-group $ResourceGroup --yes --no-wait --only-show-errors --output none
    $deadline = (Get-Date).AddMinutes(10)
    while (Test-FormerSite) {
        if ((Get-Date) -gt $deadline) { Stop-Step "$former is still in $ResourceGroup ten minutes after its removal was asked for." }
        Start-Sleep -Seconds 15
    }
    Write-Host "PASS $former removed"
}
