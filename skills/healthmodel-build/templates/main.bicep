@minLength(3)
@maxLength(44)
param healthModelName string

param location string

@minLength(3)
@maxLength(260)
param flowEntityName string

param flowDisplayName string

@minLength(3)
@maxLength(260)
param relationshipName string

resource healthModel 'Microsoft.CloudHealth/healthmodels@2026-09-01-preview' = {
  name: healthModelName
  location: location
  properties: {}
}

resource flow 'Microsoft.CloudHealth/healthmodels/entities@2026-09-01-preview' = {
  parent: healthModel
  name: flowEntityName
  properties: {
    displayName: flowDisplayName
  }
}

resource rootToFlow 'Microsoft.CloudHealth/healthmodels/relationships@2026-09-01-preview' = {
  parent: healthModel
  name: relationshipName
  properties: {
    parentEntityName: healthModel.name
    childEntityName: flow.name
  }
}

output healthModelId string = healthModel.id
output flowEntityId string = flow.id
