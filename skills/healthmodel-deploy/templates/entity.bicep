resource e 'Microsoft.CloudHealth/healthModels/entities@2026-01-01-preview' = {
  name: 'hm-validate/e-validate'
  properties: loadJsonContent('body.json')
}
