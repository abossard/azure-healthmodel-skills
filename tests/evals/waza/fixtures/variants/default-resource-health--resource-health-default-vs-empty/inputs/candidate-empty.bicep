// synthetic fictional fixture; not captured from Azure
resource api 'Microsoft.CloudHealth/healthmodels/entities@2026-09-01-preview' = {
  name: 'catalog-health-model/api'
  properties: {
    signalGroups: {
      azureResource: {
        azureResourceId: '/subscriptions/00000000-0000-4000-8000-00000000000a/resourceGroups/rg-shared/providers/Microsoft.Web/sites/api'
        authenticationSetting: 'model-identity'
        resourceHealth: {}
      }
    }
  }
}
