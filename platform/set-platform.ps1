#Requires -Version 7.4

<#
.SYNOPSIS
    Makes the delivery plumbing of cmfleet what this repository says it is: its Octopus space and what is in it, its
    foothold in Azure, and this repository's settings. Run by the operator; safe to run again.

.DESCRIPTION
    cmfleet is a system made by hand, not from the demo-environment-kit's templates (the kit's principle 007: the kit
    specifies delivery, not architecture). This script is the whole of its plumbing, in the order things depend on
    each other:

    1. GitHub: environment "release" (main only), and the subject GitHub issues for it.
    2. Octopus: service account cmfleet-github trusted for that subject, and the space, with that account and the
       operator as its managers.
    3. Azure: platform/azure.bicep (a resource group per tier with the identity Octopus deploys as).
    4. In the space: environments tdd, uat, prod; a lifecycle that deploys to tdd by itself and to the others on
       request; the feed of the steps' container image; the team that signs off; one Azure account per tier; the
       project with its variables and its process: Sign-off (uat and prod), Update deployable, Verify deployable, and
       Run acceptance tests (tdd).
    5. GitHub: the variables the build's release job reads, and the ruleset of main (pull requests, with the checks
       "Build result" and "secret-scan" passed).

    The steps' scripts are not here: they are in the release's package (deploy/), so a release carries the way it is
    deployed.

    Runs as the operator identity of the demo-environment-kit: gh as the machine user, az as the service principal,
    and the Octopus key the kit's library reads. No secret is read, written or printed here.

.PARAMETER KitScripts
    The scripts folder of the operator's checkout of the demo-environment-kit, for its library (Octopus API calls with
    the operator's key).

.PARAMETER Repository
    This repository on GitHub.

.EXAMPLE
    pwsh -NoProfile -File platform/set-platform.ps1
#>
[CmdletBinding()]
param(
    [string] $KitScripts = '/home/aiops/demo-environment-kit/.claude/skills/demo-environment/scripts',
    [string] $Repository = 'clearmeasure-aisf-sample-apps/cmfleet-dashboard'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $KitScripts 'demo-common.ps1')

$octopus = @{ octopus = @{ url = 'https://clearmeasure.octopus.app' } }
$spaceName = 'cmfleet'
$projectName = 'cmfleet-dashboard'
$serviceAccount = 'cmfleet-github'
$environments = [ordered] @{ tdd = 'nonprod'; uat = 'nonprod'; prod = 'prod' }
$first = @($environments.Keys)[0]
$workerImage = 'octopusdeploy/worker-tools:6.6.5-ubuntu.24.04'
$githubIssuer = 'https://token.actions.githubusercontent.com'

function Invoke-Api {
    param([Parameter(Mandatory)] [string] $Path, [string] $Method = 'Get', [object] $Body = $null)
    return Invoke-OctopusApi -Config $octopus -Path $Path -Method $Method -Body $Body
}

function Get-Named {
    # The one item of a collection that has this name, or nothing.
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [string] $Name)
    $separator = if ($Path.Contains('?')) { '&' } else { '?' }
    $found = Invoke-Api -Path "$Path${separator}partialName=$([uri]::EscapeDataString($Name))&take=100"
    return @($found.Items | Where-Object { $_.Name -eq $Name }) | Select-Object -First 1
}

function Test-Declared {
    # Whether what Octopus stores holds everything declared here. Octopus adds ids and defaults of its own to what it
    # stores, so only what is declared is compared. A list has the same length and order; the properties of a step or
    # a package have exactly the declared names, so a property taken out of this script is taken out of Octopus.
    param($Stored, $Declared)
    if ($Declared -is [Collections.IDictionary]) {
        if ($null -eq $Stored) { return $false }
        foreach ($key in $Declared.Keys) {
            $value = if ($Stored -is [Collections.IDictionary]) { $Stored[$key] } else { $Stored.PSObject.Properties[$key]?.Value }
            if ($key -eq 'Properties' -and $Declared[$key] -is [Collections.IDictionary]) {
                $names = @(if ($value -is [Collections.IDictionary]) { $value.Keys } elseif ($null -ne $value) { $value.PSObject.Properties | ForEach-Object { $_.Name } })
                if ($names.Count -ne $Declared[$key].Count) { return $false }
            }
            if (-not (Test-Declared -Stored $value -Declared $Declared[$key])) { return $false }
        }
        return $true
    }
    if ($Declared -is [array]) {
        $list = @($Stored | Where-Object { $null -ne $_ })
        if ($list.Count -ne $Declared.Count) { return $false }
        for ($index = 0; $index -lt $Declared.Count; $index++) {
            if (-not (Test-Declared -Stored $list[$index] -Declared $Declared[$index])) { return $false }
        }
        return $true
    }
    return [string] $Stored -ceq [string] $Declared
}

function Set-Named {
    # Creates the item, or brings the one that exists to these values. Returns it.
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [hashtable] $Body, [string] $FindPath = '')
    $existing = Get-Named -Path $(if ($FindPath) { $FindPath } else { $Path }) -Name ([string] $Body.Name)
    if (-not $existing) {
        $created = Invoke-Api -Path $Path -Method Post -Body $Body
        Write-Host "PASS created $($Body.Name) ($($created.Id))"
        return $created
    }
    $changed = $false
    foreach ($key in $Body.Keys) {
        if (-not (Test-Declared -Stored $existing.$key -Declared $Body[$key])) {
            $existing.$key = $Body[$key]
            $changed = $true
        }
    }
    if ($changed) {
        $existing = Invoke-Api -Path "$($Path.Split('?')[0])/$($existing.Id)" -Method Put -Body $existing
        Write-Host "PASS updated $($Body.Name) ($($existing.Id))"
    }
    else {
        Write-Host "PASS $($Body.Name) is as declared ($($existing.Id))"
    }
    return $existing
}

Write-Host "==> GitHub: $Repository"
'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | gh api --method PUT "repos/$Repository/environments/release" --input - --silent
if (@(gh api "repos/$Repository/environments/release/deployment-branch-policies" --jq '.branch_policies[].name') -notcontains 'main') {
    gh api --method POST "repos/$Repository/environments/release/deployment-branch-policies" -f name=main -f type=branch --silent
}
$subject = "$(Get-GitHubSubjectPrefix -FullName $Repository):environment:release"
Write-Host "PASS environment release (main only); its subject is $subject"

Write-Host "==> Octopus: service account $serviceAccount and space $spaceName"
$users = Invoke-Api -Path "/api/users?filter=$([uri]::EscapeDataString($serviceAccount))&take=100"
$account = @($users.Items | Where-Object { $_.Username -eq $serviceAccount }) | Select-Object -First 1
if (-not $account) {
    $account = Invoke-Api -Path '/api/users' -Method Post -Body @{ Username = $serviceAccount; DisplayName = 'cmfleet (GitHub Actions)'; IsService = $true; IsActive = $true }
}
$identities = Invoke-Api -Path "/api/serviceaccounts/$($account.Id)/oidcidentities/v1?skip=0&take=100"
if (-not @($identities.OidcIdentities | Where-Object { $_.Subject -eq $subject -and $_.Issuer -eq $githubIssuer })) {
    Invoke-Api -Path "/api/serviceaccounts/$($account.Id)/oidcidentities/create/v1" -Method Post -Body @{ ServiceAccountId = $account.Id; Name = 'cmfleet-dashboard-release'; Issuer = $githubIssuer; Subject = $subject } | Out-Null
    $identities = Invoke-Api -Path "/api/serviceaccounts/$($account.Id)/oidcidentities/v1?skip=0&take=100"
}
if (-not $identities.ExternalId) { throw "Octopus returned no ExternalId for $serviceAccount." }
Write-Host "PASS $serviceAccount ($($account.Id)) is trusted for $subject"

$operator = Invoke-Api -Path '/api/users/me'
$managers = @($account.Id, $operator.Id) | Select-Object -Unique
$space = Get-Named -Path '/api/spaces' -Name $spaceName
if (-not $space) {
    $space = Invoke-Api -Path '/api/spaces' -Method Post -Body @{
        Name                     = $spaceName
        Description              = "The fleet's own system: the fleet health dashboard, managed from $Repository (platform/)."
        SpaceManagersTeams       = @()
        SpaceManagersTeamMembers = @($managers)
        IsDefault                = $false
        TaskQueueStopped         = $false
    }
    Write-Host "PASS created space $($space.Id) ($($space.Slug))"
}
elseif (@($managers | Where-Object { @($space.SpaceManagersTeamMembers) -notcontains $_ }).Count -gt 0) {
    $space.SpaceManagersTeamMembers = @(@($space.SpaceManagersTeamMembers) + $managers | Select-Object -Unique)
    $space = Invoke-Api -Path "/api/spaces/$($space.Id)" -Method Put -Body $space
    Write-Host "PASS space $($space.Id): managers added"
}
else {
    Write-Host "PASS space $($space.Id) ($($space.Slug)) is as declared"
}
$s = "/api/$($space.Id)"

Write-Host '==> Azure: a resource group and a deploy identity per tier'
$env:AZURE_BICEP_CHECK_VERSION = 'false'
$outputs = az deployment sub create --name cmfleet-platform --location centralus --template-file (Join-Path $PSScriptRoot 'azure.bicep') --parameters "octopusIssuer=$($octopus.octopus.url)" "octopusSpaceSlug=$($space.Slug)" "octopusProject=$projectName" --query properties.outputs.deploy.value --only-show-errors --output json | ConvertFrom-Json
$azure = az account show --query '{tenantId: tenantId, subscriptionId: id}' --output json | ConvertFrom-Json
foreach ($tier in $outputs) { Write-Host "PASS $($tier.resourceGroup): id-cmfleet-deploy-$($tier.tier) for $($tier.environments -join ', ')" }

Write-Host '==> In the space: environments, lifecycle, feed, team, accounts'
$environmentIds = [ordered] @{}
foreach ($name in $environments.Keys) {
    $environmentIds[$name] = [string] (Set-Named -Path "$s/environments" -Body @{ Name = $name; Description = "$name of the fleet health dashboard ($($environments[$name]))" }).Id
}
$lifecycle = Set-Named -Path "$s/lifecycles" -Body @{
    Name        = 'cmfleet-lifecycle'
    Description = "A release goes to $first by itself, and to each later environment on request, after a sign-off."
    Phases      = @($environments.Keys | ForEach-Object {
            @{
                Name                               = $_
                AutomaticDeploymentTargets         = @(if ($_ -eq $first) { $environmentIds[$_] })
                OptionalDeploymentTargets          = @(if ($_ -ne $first) { $environmentIds[$_] })
                MinimumEnvironmentsBeforePromotion = 0
                IsOptionalPhase                    = $false
            }
        })
}
$feed = Set-Named -Path "$s/feeds" -Body @{ Name = 'docker-hub'; FeedType = 'Docker'; FeedUri = 'https://index.docker.io'; ApiVersion = 'v2' }
$builtIn = @((Invoke-Api -Path "$s/feeds?feedType=BuiltIn&take=10").Items | Where-Object { $_.FeedType -eq 'BuiltIn' }) | Select-Object -First 1
$pool = Get-Named -Path "$s/workerpools" -Name 'Hosted Ubuntu'
if (-not $builtIn -or -not $pool) { throw "The space has no built-in feed or no worker pool 'Hosted Ubuntu' (Octopus Cloud provides both)." }

$team = Set-Named -Path '/api/teams' -FindPath "/api/teams?spaces=$($space.Id)&includeSystem=false" -Body @{
    Name          = 'cmfleet approvers'
    Description   = 'Who signs off a promotion of the fleet health dashboard. The operator signs off scripted promotions, with a reason.'
    SpaceId       = [string] $space.Id
    MemberUserIds = @([string] $operator.Id)
    ExternalSecurityGroups = @()
}
if (-not @((Invoke-Api -Path "/api/teams/$($team.Id)/scopeduserroles?take=20").Items | Where-Object { $_.UserRoleId -eq 'userroles-projectviewer' })) {
    Invoke-Api -Path '/api/scopeduserroles' -Method Post -Body @{ TeamId = $team.Id; UserRoleId = 'userroles-projectviewer'; SpaceId = $space.Id } | Out-Null
    Write-Host 'PASS cmfleet approvers may view the projects of the space'
}

$accountIds = @{}
foreach ($tier in $outputs) {
    $accountIds[[string] $tier.tier] = [string] (Set-Named -Path "$s/accounts" -Body @{
            Name                            = "azure-cmfleet-$($tier.tier)"
            Description                     = "id-cmfleet-deploy-$($tier.tier): creates and updates the sites of $($tier.environments -join ' and ')."
            AccountType                     = 'AzureOidc'
            SubscriptionNumber              = [string] $azure.subscriptionId
            ClientId                        = [string] $tier.clientId
            TenantId                        = [string] $azure.tenantId
            Audience                        = 'api://AzureADTokenExchange'
            DeploymentSubjectKeys           = @('space', 'project', 'environment')
            HealthCheckSubjectKeys          = @()
            AccountTestSubjectKeys          = @()
            TenantedDeploymentParticipation = 'Untenanted'
            EnvironmentIds                  = @($tier.environments | ForEach-Object { $environmentIds[[string] $_] })
        }).Id
}

Write-Host "==> Project $projectName"
$group = Set-Named -Path "$s/projectgroups" -Body @{ Name = 'cmfleet'; Description = "The fleet's own system." }
$project = Set-Named -Path "$s/projects" -Body @{
    Name           = $projectName
    Description    = "The fleet health dashboard, released from $Repository. Its steps run the scripts of the release's own package (deploy/)."
    ProjectGroupId = [string] $group.Id
    LifecycleId    = [string] $lifecycle.Id
}

$variables = Invoke-Api -Path "$s/variables/$($project.VariableSetId)"
$wanted = @(
    foreach ($name in $environments.Keys) {
        @{ Name = 'Azure.Account'; Value = $accountIds[$environments[$name]]; Type = 'AzureAccount'; Scope = @{ Environment = @($environmentIds[$name]) } }
        @{ Name = 'Azure.ResourceGroup'; Value = "rg-cmfleet-$($environments[$name])"; Type = 'String'; Scope = @{ Environment = @($environmentIds[$name]) } }
    }
    # One deployment per environment at a time, whichever release it is of.
    @{ Name = 'Octopus.Task.ConcurrencyTag'; Value = '#{Octopus.Environment.Id}'; Type = 'String'; Scope = @{} }
)
$shape = { param($list) ConvertTo-Json -Compress -Depth 6 -InputObject @($list | ForEach-Object { "$($_.Name)|$($_.Value)|$($_.Type)|$(@($_.Scope['Environment']) -join ',')" } | Sort-Object) }
$current = @($variables.Variables | ForEach-Object { @{ Name = $_.Name; Value = $_.Value; Type = $_.Type; Scope = @{ Environment = @($_.Scope.PSObject.Properties['Environment']?.Value) } } })
if ((& $shape $current) -ne (& $shape $wanted)) {
    $variables.Variables = @($wanted | ForEach-Object { @{ Name = $_.Name; Value = $_.Value; Type = $_.Type; IsSensitive = $false; IsEditable = $true; Scope = $_.Scope } })
    Invoke-Api -Path "$s/variables/$($project.VariableSetId)" -Method Put -Body $variables | Out-Null
    Write-Host "PASS variables set ($($wanted.Count))"
}
else {
    Write-Host "PASS variables are as declared ($($wanted.Count))"
}

# The process. Every script step runs a file of the release's package as the tier's deploy identity, in the same
# container on the hosted Ubuntu workers. The names are the fleet's: "Update deployable" followed by "Verify
# deployable" is the health check after a deployment that its policy looks for, and "Sign-off" the manual step.
function New-ScriptStep {
    param([Parameter(Mandatory)] [string] $Name, [Parameter(Mandatory)] [string] $File, [string[]] $Environments = @())
    $action = @{
        Name                 = $Name
        ActionType           = 'Octopus.AzurePowerShell'
        WorkerPoolId         = [string] $pool.Id
        Container            = @{ Image = $workerImage; FeedId = [string] $feed.Id }
        Environments         = @($Environments)
        ExcludedEnvironments = @()
        Channels             = @()
        Packages             = @(@{ Name = ''; PackageId = $projectName; FeedId = [string] $builtIn.Id; AcquisitionLocation = 'Server'; Properties = @{ SelectionMode = 'immediate' } })
        Properties           = @{
            'Octopus.Action.Azure.AccountId'           = '#{Azure.Account}'
            'Octopus.Action.RunOnServer'               = 'true'
            'Octopus.Action.Script.ScriptSource'       = 'Package'
            'Octopus.Action.Script.ScriptFileName'     = $File
            'Octopus.Action.Script.ScriptParameters'   = '-Environment "#{Octopus.Environment.Name}" -Version "#{Octopus.Release.Number}" -ResourceGroup "#{Azure.ResourceGroup}"'
            'Octopus.Action.Package.PackageId'         = $projectName
            'Octopus.Action.Package.FeedId'            = [string] $builtIn.Id
            'Octopus.Action.Package.DownloadOnTentacle' = 'False'
            'OctopusUseBundledTooling'                 = 'False'
        }
    }
    return @{ Name = $Name; Condition = 'Success'; StartTrigger = 'StartAfterPrevious'; PackageRequirement = 'LetOctopusDecide'; Properties = @{}; Actions = @($action) }
}
$steps = @(
    @{
        Name = 'Sign-off'; Condition = 'Success'; StartTrigger = 'StartAfterPrevious'; PackageRequirement = 'LetOctopusDecide'; Properties = @{}
        Actions = @(@{
                Name                 = 'Sign-off'
                ActionType           = 'Octopus.Manual'
                Environments         = @()
                ExcludedEnvironments = @($environmentIds[$first])
                Channels             = @()
                Packages             = @()
                Properties           = @{
                    'Octopus.Action.RunOnServer'                       = 'false'
                    'Octopus.Action.Manual.Instructions'               = 'Sign off #{Octopus.Project.Name} #{Octopus.Release.Number} for #{Octopus.Environment.Name}: check the earlier environments, then Proceed with a note, or Abort.'
                    'Octopus.Action.Manual.ResponsibleTeamIds'         = [string] $team.Id
                    'Octopus.Action.Manual.BlockConcurrentDeployments' = 'False'
                }
            })
    }
    (New-ScriptStep -Name 'Update deployable' -File 'deploy/deploy.ps1')
    (New-ScriptStep -Name 'Verify deployable' -File 'deploy/verify.ps1')
    (New-ScriptStep -Name 'Run acceptance tests' -File 'deploy/acceptance.ps1' -Environments @($environmentIds[$first]))
)
$process = Invoke-Api -Path "$s/deploymentprocesses/$($project.DeploymentProcessId)"
if (-not (Test-Declared -Stored @($process.Steps) -Declared $steps)) {
    $process.Steps = $steps
    Invoke-Api -Path "$s/deploymentprocesses/$($project.DeploymentProcessId)" -Method Put -Body $process | Out-Null
    Write-Host "PASS process set: $(@($steps | ForEach-Object { $_.Name }) -join ', ')"
}
else {
    Write-Host "PASS process is as declared: $(@($steps | ForEach-Object { $_.Name }) -join ', ')"
}

Write-Host "==> GitHub: the variables the release job reads"
$repositoryVariables = [ordered] @{
    OCTOPUS_URL                = [string] $octopus.octopus.url
    OCTOPUS_SPACE_NAME         = $spaceName
    OCTOPUS_SERVICE_ACCOUNT_ID = [string] $identities.ExternalId
}
foreach ($name in $repositoryVariables.Keys) { gh variable set $name --repo $Repository --body $repositoryVariables[$name] }
Write-Host "PASS $($repositoryVariables.Keys -join ', ')"
# main changes by pull request, with the build and the secret scan passed; organization owners may bypass.
New-GitHubRuleset -FullName $Repository -RequiredCheck 'Build result', 'secret-scan'
Write-Host "PASS cmfleet: space $($space.Id) ($($space.Slug)), project $($project.Id)"
