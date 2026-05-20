param location string = 'swedencentral'

resource m 'Microsoft.CloudHealth/healthModels@2026-01-01-preview' = {
  name: 'hm-validate'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {}
}
