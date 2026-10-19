# Operation checks

Read only what is needed for the approved operation.

## Execution tooling

- Native CLI first: preview extension `health-models`, command group `az monitor health-models`. Inspect installed `--help` before use.
- `az rest` fallback only when native CLI coverage is missing. Use existing auth, documented URL, method, API version, and body. Set custom audience with `--resource` when required.
- Keep the existing project format and selected provider. For Bicep/ARM, validate against the [ARM reference](https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/healthmodels). For Terraform AzAPI, use reviewed `plan`/`apply` targets and expected effects.
- Do not assume PATCH or partial-merge semantics. Use documented operation behavior for the chosen surface.
- `bicep build --no-restore` validates local structure without restoring modules. If required modules are missing, report the gap.
- `terraform validate` and `terraform fmt` assume existing initialized dependencies. Do not run init or install providers/modules by default. Report missing initialization as a gap.
- What-if and Terraform plan can be remote and can call Azure or state backends. They are validation signals, not deployment proof and not evaluated-health proof.
- Terraform plan and provider preflight can read state or call networked services. This is not blanket write permission. Do not print secrets or full state.
- Never auto-install tools, restore providers/modules, run tutorial setup, grant roles, or run cleanup.

## Signals and groups

- Shared definitions affect every consumer. Include all consumers in reviewed effects ([signals](https://learn.microsoft.com/azure/azure-monitor/health-models/signals)).
- Members match signal names. The API can silently accept nonexistent names.
- Check member names and readback `unresolvedMembers`. Request success alone does not verify membership ([entity GET](https://learn.microsoft.com/rest/api/health-models/entities/get)).

## Access and health

- Caller access differs from model-identity access.
- Missing Reader/Monitoring Reader roles can block evaluation. Do not grant them implicitly ([permissions](https://learn.microsoft.com/azure/azure-monitor/health-models/health-models-faq)).
- To establish evaluated health, use attributable signal status: `healthState`, `value`, `reportedAt`, `error`. Provisioning status does not establish evaluated health.

## Explicit external-report request

A report can silently create a signal, replace its previous report and expire by TTL. Treat it as a separate write, not a configuration check ([ingestion](https://learn.microsoft.com/azure/azure-monitor/health-models/health-report-ingestion)).
