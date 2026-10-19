// synthetic fictional fixture; not captured from Azure
param location string = 'westeurope'

resource model 'Microsoft.CloudHealth/healthmodels@2026-09-01-preview' = {
  name: 'catalog-health-model'
  location: location
  tags: {
    owner: 'platform'
    tier: 'standard'
  }
  identity: {
    type: 'SystemAssigned'
  }
}

resource latencyDefinition 'Microsoft.CloudHealth/healthmodels/signaldefinitions@2026-09-01-preview' = {
  parent: model
  name: 'latency-def'
  properties: {
    signalKind: 'AzureResourceMetric'
    metricName: 'HttpResponseTime'
    aggregationType: 'Average'
    evaluationRules: {
      degradedRule: { operator: 'GreaterThan', threshold: 800 }
    }
  }
}

resource gateway 'Microsoft.CloudHealth/healthmodels/entities@2026-09-01-preview' = {
  parent: model
  name: 'gateway'
  properties: {
    displayName: 'gateway'
    impact: 'Standard'
    canvasPosition: { x: 20, y: 40 }
  }
}

resource api 'Microsoft.CloudHealth/healthmodels/entities@2026-09-01-preview' = {
  parent: model
  name: 'api'
  properties: {
    displayName: 'api'
    impact: 'Standard'
    canvasPosition: { x: 180, y: 40 }
    signalGroups: {
      azureResource: {
        azureResourceId: '/subscriptions/00000000-0000-4000-8000-00000000000a/resourceGroups/rg-shared/providers/Microsoft.Web/sites/api'
        authenticationSetting: 'model-identity'
        signalAssignments: [
          { signalDefinitions: [ latencyDefinition.name ] }
        ]
      }
      signalAggregationGroups: [
        { name: 'api-latency-group', aggregationType: 'WorstOf', members: [ 'latency' ] }
      ]
    }
  }
}

resource db 'Microsoft.CloudHealth/healthmodels/entities@2026-09-01-preview' = {
  parent: model
  name: 'db'
  properties: {
    displayName: 'db'
    impact: 'Standard'
    canvasPosition: { x: 340, y: 40 }
    signalGroups: {
      azureResource: {
        azureResourceId: '/subscriptions/00000000-0000-4000-8000-00000000000a/resourceGroups/rg-shared/providers/Microsoft.Sql/servers/db'
        authenticationSetting: 'model-identity'
      }
    }
  }
}

resource rel_gateway_api 'Microsoft.CloudHealth/healthmodels/relationships@2026-09-01-preview' = {
  parent: model
  name: 'gateway-api'
  properties: {
    parentEntityName: 'gateway'
    childEntityName: 'api'
  }
}
resource rel_api_db 'Microsoft.CloudHealth/healthmodels/relationships@2026-09-01-preview' = {
  parent: model
  name: 'api-db'
  properties: {
    parentEntityName: 'api'
    childEntityName: 'db'
  }
}
