resource r 'Microsoft.CloudHealth/healthModels/relationships@2026-01-01-preview' = {
  name: 'hm-validate/r-validate'
  properties: loadJsonContent('body.json')
}
