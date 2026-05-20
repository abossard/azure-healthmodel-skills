resource sd 'Microsoft.CloudHealth/healthModels/signalDefinitions@2026-01-01-preview' = {
  name: 'hm-validate/sd-validate'
  properties: loadJsonContent('body.json')
}
