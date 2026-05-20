# Bicep validator templates

These templates are **not deployed**. They exist so `az bicep build` can validate
sparse design files (`.healthmodel/03-design/**/*.json`) against the
`Microsoft.CloudHealth@2026-01-01-preview` schema, offline, before any `az rest`
PUT touches Azure.

Each template loads a body JSON via `loadJsonContent('body.json')`. The
`scripts/validate.sh` script writes the design file into a tempdir as
`body.json` next to the matching template, then runs `az bicep build`.

| Template | Validates |
|---|---|
| `health-model.bicep` | Root model resource (location, identity, empty properties) |
| `auth.bicep` | `authenticationSettings` body |
| `signal-arm.bicep` | `signalDefinitions` with `signalKind: AzureResourceMetric` |
| `signal-prom.bicep` | `signalDefinitions` with `signalKind: PrometheusMetricsQuery` |
| `signal-log.bicep` | `signalDefinitions` with `signalKind: LogAnalyticsQuery` |
| `entity.bicep` | `entities` body (incl. signalGroups) |
| `relationship.bicep` | `relationships` body |

API version is pinned to `2026-01-01-preview`. Bump in lockstep across all
templates if Microsoft moves it forward.
