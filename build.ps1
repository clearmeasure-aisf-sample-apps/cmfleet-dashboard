#Requires -Version 7.4

<#
.SYNOPSIS
    The private build: everything the integration build does, in one command, before a commit.

.DESCRIPTION
    1. Static analysis: eslint over the JavaScript and PSScriptAnalyzer over the PowerShell, warnings as errors.
    2. Unit tests of the model, with coverage (at least 90 percent of its lines).
    3. The site (dist/site) and the release's content beside it (dist/deploy, dist/acceptance).
    4. Integration tests: the built site in a browser, with data the tests chose.
    5. The build's facts (dist/site/build.json: version, commit, lines of code, tests, coverage, complexity, analyzer).
    6. The package out/cmfleet-dashboard.<version>.zip, which is what Octopus releases.

    The integration build (.github/workflows/build.yml) calls this script and nothing else, so a build that passes
    here passes there. The third level of testing, acceptance, runs against the deployed first environment
    (deploy/acceptance.ps1, a step of the Octopus process).

    Needs Node.js 22 or later, the PowerShell module PSScriptAnalyzer and a Chromium for Playwright: `npx playwright install chromium`, or CHROMIUM_PATH
    naming one that is installed.

.PARAMETER Version
    The version to stamp and to name the package with. The integration build passes MAJOR.MINOR.<run number>.

.PARAMETER Commit
    The commit the build is of. Read from git when not given.

.PARAMETER RepositoryUrl
    The repository's address, for the link to the commit in the build's facts.

.PARAMETER BuildUrl
    The address of the build run, for the build's facts.

.EXAMPLE
    pwsh -NoProfile -File build.ps1
#>
[CmdletBinding()]
param(
    [string] $Version = '0.0.0-local',
    [string] $Commit = '',
    [string] $RepositoryUrl = 'https://github.com/clearmeasure-aisf-sample-apps/cmfleet-dashboard',
    [string] $BuildUrl = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

Push-Location -LiteralPath $PSScriptRoot
try {
    if (-not $Commit) { $Commit = (git rev-parse HEAD).Trim() }

    Write-Host '==> tools'
    npm ci --no-audit --no-fund
    Remove-Item -LiteralPath dist, out -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path dist, out | Out-Null

    Write-Host '==> static analysis'
    npx eslint --max-warnings 0 .
    Write-Host 'PASS eslint: no problem'
    $scripts = @(Get-ChildItem -Path build.ps1, deploy, platform -Filter *.ps1 -Recurse -File)
    $problems = @(foreach ($script in $scripts) {
            $tokens = $null
            $errors = $null
            # The analyzer does not report parse errors: the parser must find none.
            [void] [System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref] $tokens, [ref] $errors)
            $errors | ForEach-Object { "$($script.Name):$($_.Extent.StartLineNumber) $($_.Message)" }
            Invoke-ScriptAnalyzer -Path $script.FullName -Settings ./PSScriptAnalyzerSettings.psd1 | ForEach-Object { "$($_.ScriptName):$($_.Line) $($_.RuleName): $($_.Message)" }
        })
    if ($problems.Count -gt 0) {
        $problems | ForEach-Object { Write-Host "FAIL $_" }
        throw "PSScriptAnalyzer: $($problems.Count) problem(s) in $($scripts.Count) scripts"
    }
    Write-Host "PASS PSScriptAnalyzer: $($scripts.Count) scripts, no problem"

    Write-Host '==> unit tests'
    node --test --experimental-test-coverage --test-coverage-lines=90 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=out/lcov.info test/unit/
    Write-Host 'PASS unit tests'

    Write-Host '==> site'
    Copy-Item -LiteralPath src -Destination dist/site -Recurse
    Copy-Item -LiteralPath deploy -Destination dist/deploy -Recurse
    Copy-Item -LiteralPath test/acceptance -Destination dist/acceptance -Recurse
    Set-Content -LiteralPath dist/site/version.json -Value (@{ version = $Version } | ConvertTo-Json)
    Write-Host "PASS dist/site: $(@(Get-ChildItem -LiteralPath dist/site -File -Recurse).Count) files"

    Write-Host '==> integration tests'
    $env:SITE = 'dist/site'
    node --test test/integration/
    Write-Host 'PASS integration tests'

    Write-Host '==> build facts'
    $env:VERSION = $Version
    $env:COMMIT = $Commit
    $env:REPOSITORY_URL = $RepositoryUrl
    $env:BUILD_URL = $BuildUrl
    node tools/metrics.js dist/site/build.json

    Write-Host '==> package'
    $package = "out/cmfleet-dashboard.$Version.zip"
    Compress-Archive -Path dist/* -DestinationPath $package
    Write-Host "PASS ${package}: $([math]::Round((Get-Item -LiteralPath $package).Length / 1KB)) KB"
}
finally {
    Pop-Location
}
