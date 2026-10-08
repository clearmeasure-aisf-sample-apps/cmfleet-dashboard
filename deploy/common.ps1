#Requires -Version 7.4

<#
.SYNOPSIS
    What the steps of the release share: failing a step with one line, and finding the environment's site.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

function Stop-Step {
    # One line that says what failed, then the step ends: Octopus shows the last error as the reason.
    param([Parameter(Mandatory)] [string] $Message)
    Write-Error -Message $Message -ErrorAction Continue
    exit 1
}

function Get-SiteAccount {
    # The storage account that serves the environment's site, found by its tags: its name ends in characters Azure
    # derives from the resource group, so nothing here spells it.
    param([Parameter(Mandatory)] [string] $Environment, [Parameter(Mandatory)] [string] $ResourceGroup)
    $name = $Environment.ToLowerInvariant()
    $account = ([string] (az storage account list --resource-group $ResourceGroup --query "[?tags.system=='cmfleet' && tags.deployable=='dashboard' && tags.environment=='$name'].name | [0]" --only-show-errors --output tsv)).Trim()
    if (-not $account) { Stop-Step "No storage account of the dashboard for $name in $ResourceGroup." }
    return $account
}

function Get-SiteUrl {
    # The address Azure gave the environment's site. Asked each time: nothing stores it.
    param([Parameter(Mandatory)] [string] $Environment, [Parameter(Mandatory)] [string] $ResourceGroup)
    $account = Get-SiteAccount -Environment $Environment -ResourceGroup $ResourceGroup
    $url = ([string] (az storage account show --name $account --resource-group $ResourceGroup --query primaryEndpoints.web --only-show-errors --output tsv)).Trim()
    if (-not $url) { Stop-Step "Azure returned no website address for $account in $ResourceGroup." }
    return $url.TrimEnd('/')
}
