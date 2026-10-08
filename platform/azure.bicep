// The foothold of cmfleet in Azure, applied once by the operator (platform/set-platform.ps1) and safe to apply again:
// one resource group per tier and, in each, the identity Octopus deploys as. Nothing else: the sites themselves are
// created by the release (deploy/site.json), not here.
// The identity is trusted for exactly one subject per environment: this space, this project, that environment.
// Its roles are Contributor and Storage Blob Data Contributor on its own resource group: it creates the site's
// storage account and writes the site's files, and can grant nothing to anyone.
targetScope = 'subscription'

@description('Where the resource groups and the sites are.')
param location string = 'centralus'

@description('The Octopus server, without a trailing slash: the issuer of the tokens the deploy identities trust.')
param octopusIssuer string

@description('The slug of the Octopus space, as it appears in the subject of a deployment\'s token.')
param octopusSpaceSlug string

@description('The Octopus project that deploys the dashboard.')
param octopusProject string = 'cmfleet-dashboard'

var tiers = [
  { name: 'nonprod', environments: ['tdd', 'uat'] }
  { name: 'prod', environments: ['prod'] }
]

resource groups 'Microsoft.Resources/resourceGroups@2024-03-01' = [
  for tier in tiers: {
    name: 'rg-cmfleet-${tier.name}'
    location: location
    tags: { system: 'cmfleet', tier: tier.name, purpose: 'fleet health dashboard (cmfleet-dashboard, platform/)' }
  }
]

module identities 'modules/tier.bicep' = [
  for (tier, i) in tiers: {
    name: 'cmfleet-deploy-${tier.name}'
    scope: groups[i]
    params: {
      location: location
      tier: tier.name
      octopusIssuer: octopusIssuer
      subjects: [for environment in tier.environments: 'space:${octopusSpaceSlug}:project:${octopusProject}:environment:${environment}']
    }
  }
]

output deploy array = [
  for (tier, i) in tiers: {
    tier: tier.name
    resourceGroup: groups[i].name
    environments: tier.environments
    clientId: identities[i].outputs.clientId
  }
]
