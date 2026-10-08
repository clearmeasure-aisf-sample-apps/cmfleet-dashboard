#Requires -Version 7.4

<#
.SYNOPSIS
    Promotes a release of the fleet health dashboard to an environment, signs it off with a reason, and waits for it.

.DESCRIPTION
    A release reaches tdd by itself. uat and prod are promotions, and each stops at the step Sign-off until a member
    of the team "cmfleet approvers" proceeds with a note. This script does what that person does in Octopus: it starts
    the deployment, takes the sign-off, records the reason, and waits for the result. The reason is kept with the
    deployment.

    Runs as the operator identity of the demo-environment-kit (its library reads the Octopus key).

.PARAMETER Environment
    uat or prod.

.PARAMETER Reason
    Why the release may go on: what was checked in the earlier environment.

.PARAMETER Version
    The release. The newest one when not given.

.PARAMETER KitScripts
    The scripts folder of the operator's checkout of the demo-environment-kit, for its library.

.EXAMPLE
    pwsh -NoProfile -File platform/promote.ps1 -Environment uat -Reason "tdd is healthy and its acceptance tests passed"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateSet('uat', 'prod')] [string] $Environment,
    [Parameter(Mandatory)] [string] $Reason,
    [string] $Version = '',
    [string] $KitScripts = '/home/aiops/demo-environment-kit/.claude/skills/demo-environment/scripts'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $KitScripts 'demo-common.ps1')

$octopus = @{ octopus = @{ url = 'https://clearmeasure.octopus.app' } }
function Invoke-Api {
    param([Parameter(Mandatory)] [string] $Path, [string] $Method = 'Get', [object] $Body = $null)
    return Invoke-OctopusApi -Config $octopus -Path $Path -Method $Method -Body $Body
}

$space = @((Invoke-Api -Path '/api/spaces?partialName=cmfleet&take=100').Items | Where-Object { $_.Name -eq 'cmfleet' }) | Select-Object -First 1
if (-not $space) { throw 'Space cmfleet does not exist: run platform/set-platform.ps1 first.' }
$s = "/api/$($space.Id)"
$project = Invoke-Api -Path "$s/projects/cmfleet-dashboard"
$releases = @((Invoke-Api -Path "$s/projects/$($project.Id)/releases?take=30").Items)
$release = if ($Version) { $releases | Where-Object { $_.Version -eq $Version } | Select-Object -First 1 } else { $releases | Select-Object -First 1 }
if (-not $release) { throw "No release $Version of cmfleet-dashboard found." }
$target = @((Invoke-Api -Path "$s/environments?partialName=$Environment&take=100").Items | Where-Object { $_.Name -eq $Environment }) | Select-Object -First 1

Write-Host "==> cmfleet-dashboard $($release.Version) to $Environment"
$deployment = Invoke-Api -Path "$s/deployments" -Method Post -Body @{ ReleaseId = $release.Id; EnvironmentId = $target.Id; Comments = $Reason }
Write-Host "PASS started $($deployment.TaskId)"

# The sign-off is the first step: it appears soon after the task starts. The task may first queue behind another
# deployment to the same environment.
$deadline = (Get-Date).AddMinutes(30)
$interruption = $null
while (-not $interruption -and (Get-Date) -lt $deadline) {
    $interruption = @((Invoke-Api -Path "$s/interruptions?regarding=$($deployment.TaskId)&pendingOnly=true").Items | Where-Object { $_.Type -eq 'ManualIntervention' }) | Select-Object -First 1
    if ($interruption) { break }
    if ((Invoke-Api -Path "/api/tasks/$($deployment.TaskId)").IsCompleted) { break }
    Start-Sleep -Seconds 10
}
if (-not $interruption) { throw "The deployment $($deployment.TaskId) did not stop at its sign-off." }
Invoke-Api -Path "$s/interruptions/$($interruption.Id)/responsible" -Method Put | Out-Null
Invoke-Api -Path "$s/interruptions/$($interruption.Id)/submit" -Method Post -Body @{ Notes = $Reason; Result = 'Proceed' } | Out-Null
Write-Host "PASS signed off: $Reason"

# The fleet's wall marks this deployment from deployments.json, and nothing starts workflow deployments for a
# promotion but its schedule, which GitHub runs every twenty to thirty minutes. Started here, after the sign-off, the
# run finds the deployment executing and follows it to its end (the kit's decision 0023). Best effort: a GitHub that
# refuses does not stop the promotion.
$PSNativeCommandUseErrorActionPreference = $false
$answer = @(gh workflow run deployments.yml --repo clearmeasure-aisf-sample-apps/cmfleet-dashboard 2>&1 | ForEach-Object { [string] $_ })
$started = $LASTEXITCODE -eq 0
$PSNativeCommandUseErrorActionPreference = $true
if ($started) { Write-Host 'PASS workflow deployments started: the wall shows this promotion within minutes' }
else { Write-Host "SKIP workflow deployments was not started ($(@($answer | Where-Object { $_ }) | Select-Object -First 1)): the wall shows this promotion at the next scheduled run" }

$deadline = (Get-Date).AddMinutes(30)
do {
    Start-Sleep -Seconds 15
    $task = Invoke-Api -Path "/api/tasks/$($deployment.TaskId)"
} while (-not $task.IsCompleted -and (Get-Date) -lt $deadline)
$link = "$($octopus.octopus.url)/app#/$($space.Id)/tasks/$($task.Id)"
if ($task.State -ne 'Success' -or $task.HasWarningsOrErrors) {
    Write-Host "FAIL $($release.Version) in ${Environment}: $($task.State)$(if ($task.HasWarningsOrErrors) { ', with warnings or errors in its log' }) ($link)"
    exit 1
}
Write-Host "PASS $($release.Version) is in $Environment ($link)"
