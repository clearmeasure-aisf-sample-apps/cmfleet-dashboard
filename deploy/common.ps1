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

function Get-SiteName {
    param([Parameter(Mandatory)] [string] $Environment)
    return "swa-cmfleet-$($Environment.ToLowerInvariant())-dashboard"
}

function Get-SiteUrl {
    # The address Azure gave the environment's site. Asked each time: nothing stores it.
    param([Parameter(Mandatory)] [string] $Environment, [Parameter(Mandatory)] [string] $ResourceGroup)
    $hostname = ([string] (az staticwebapp show --name (Get-SiteName -Environment $Environment) --resource-group $ResourceGroup --query defaultHostname --only-show-errors --output tsv)).Trim()
    if (-not $hostname) { Stop-Step "Azure returned no address for $(Get-SiteName -Environment $Environment) in $ResourceGroup." }
    return "https://$hostname"
}
