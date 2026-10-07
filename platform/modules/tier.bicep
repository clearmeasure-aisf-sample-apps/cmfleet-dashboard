// One tier's deploy identity: id-cmfleet-deploy-<tier>, trusted for the tier's environments, Contributor on its group.
targetScope = 'resourceGroup'

param location string
param tier string
param octopusIssuer string
param subjects array

var contributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')

resource deploy 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-cmfleet-deploy-${tier}'
  location: location
  tags: { system: 'cmfleet', tier: tier }
}

// One federated credential at a time: Azure refuses concurrent writes to the credentials of one identity.
@batchSize(1)
resource credentials 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = [
  for (subject, i) in subjects: {
    parent: deploy
    name: 'octopus-${i}'
    properties: {
      issuer: octopusIssuer
      subject: subject
      audiences: ['api://AzureADTokenExchange']
    }
  }
]

resource role 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deploy.id, 'contributor')
  properties: {
    principalId: deploy.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: contributor
  }
}

output clientId string = deploy.properties.clientId
