#Requires -Version 7.4

<#
.SYNOPSIS
    Tests of what the deploy scripts share (deploy/common.ps1), with an Azure CLI that answers what the test says.

.DESCRIPTION
    The scripts run in Octopus against Azure, where a mistake costs a failed deployment. What can be known without
    Azure is tested here: above all what a function does when the CLI prints nothing, which is how a resource that
    is not there looks.

.EXAMPLE
    pwsh -NoProfile -File test/deploy/common.test.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$common = Join-Path $PSScriptRoot '../../deploy/common.ps1'
$failed = 0

function Assert-Equal {
    param([Parameter(Mandatory)] [string] $What, $Expected, $Actual)
    if ("$Expected" -ceq "$Actual") { Write-Host "PASS $What" }
    else { Write-Host "FAIL ${What}: expected '$Expected', got '$Actual'"; $script:failed++ }
}

function Invoke-WithAz {
    # Runs a piece of script in a process of its own, where az is a function that prints the given lines. A process
    # of its own, because a step that fails ends its process.
    param([string[]] $AzPrints = @(), [Parameter(Mandatory)] [string] $Script)
    $lines = ($AzPrints | ForEach-Object { "'$($_.Replace("'", "''"))'" }) -join ', '
    $body = ". '$common'; function az { @($lines) }; $Script"
    $PSNativeCommandUseErrorActionPreference = $false
    $output = @(pwsh -NoProfile -Command $body 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    $PSNativeCommandUseErrorActionPreference = $true
    return @{ Code = $code; Text = ($output -join "`n") }
}

$none = Invoke-WithAz -Script 'Test-StaticSite -Name swa-x -ResourceGroup rg-x'
Assert-Equal 'a site the group does not list is not there' 'False' $none.Text
Assert-Equal 'and asking is not a failure' 0 $none.Code

$there = Invoke-WithAz -AzPrints 'swa-x' -Script 'Test-StaticSite -Name swa-x -ResourceGroup rg-x'
Assert-Equal 'a site the group lists is there' 'True' $there.Text

$account = Invoke-WithAz -AzPrints 'stcmfleettddabc123' -Script 'Get-SiteAccount -Environment TDD -ResourceGroup rg-x'
Assert-Equal 'the account of an environment is the one the group lists' 'stcmfleettddabc123' $account.Text

$missing = Invoke-WithAz -Script 'Get-SiteAccount -Environment tdd -ResourceGroup rg-x'
Assert-Equal 'an environment with no account fails the step' 1 $missing.Code
Assert-Equal 'and says which account is missing' 'True' ($missing.Text -match 'No storage account of the dashboard for tdd in rg-x\.')

$url = Invoke-WithAz -AzPrints 'https://stcmfleettddabc123.z19.web.core.windows.net/' -Script 'Get-SiteUrl -Environment tdd -ResourceGroup rg-x'
Assert-Equal 'the address of an environment has no trailing slash' 'https://stcmfleettddabc123.z19.web.core.windows.net' $url.Text

if ($failed -gt 0) { throw "$failed test(s) of the deploy scripts failed" }
