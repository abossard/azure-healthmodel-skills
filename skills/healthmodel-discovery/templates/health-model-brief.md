# Health Model Brief — {{APP_NAME}}

> Fill in this brief before or during the discovery phase.
> The architecture and design phases read this file to build your health model.
> Delete or leave blank any section that doesn't apply — defaults are listed in §10.

---

## 1. Azure Scope

<!-- Which subscription and resource groups should the health model cover? -->

- **Subscription ID**: <!-- e.g., b2af20ad-98fa-4aa7-94c3-059663641d9f -->
- **Subscription name**: <!-- e.g., MyApp-Production -->
- **Health model location**: <!-- Azure region for the model resource, e.g., swedencentral -->

### Resource Groups

<!-- List the RGs to include. Discovery will scan these for resources. -->

| Resource Group | Purpose | Include |
|----------------|---------|---------|
| <!-- e.g., rg-myapp-global --> | <!-- Shared services (Cosmos, Key Vault, Event Hub) --> | <!-- [x] --> |
| <!-- e.g., rg-myapp-swedencentral-001 --> | <!-- Stamp 1 (AKS, per-stamp Cosmos) --> | <!-- [x] --> |
| <!-- e.g., rg-myapp-swedencentral-002 --> | <!-- Stamp 2 --> | <!-- [x] --> |
| | | |

- **Cross-subscription resources?**: <!-- no (single sub only) / yes — list the other sub IDs below -->
- **Managed identity for health model**: <!-- existing UAMI resource ID, or "create new" -->
  <!-- e.g., /subscriptions/.../providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-healthmodel-myapp -->

---

## 2. Your Role & Responsibilities

- **Role**: <!-- e.g., SRE, Platform Engineer, App Dev Lead -->
- **Team**:
- **Scope**: <!-- e.g., "Full stack owner", "Data platform only", "AKS clusters + ingress" -->
- **Escalation**: <!-- Who gets paged when this health model goes red? -->

---

## 3. Critical User Journeys

<!-- What are users actually doing? Health models should reflect user impact, not just infra. -->

| Journey | Depends on | Impact if broken | Priority |
|---------|------------|------------------|----------|
| <!-- e.g., User login --> | <!-- App Service, Key Vault --> | <!-- Users locked out --> | <!-- H/M/L --> |
| | | | |
| | | | |

---

## 4. SLO / SLA Targets

| Service / Journey | Metric | Target | Window | Source | What counts as failure |
|-------------------|--------|--------|--------|--------|----------------------|
| <!-- e.g., Checkout API --> | <!-- P95 latency --> | <!-- < 500ms --> | <!-- 5 min rolling --> | <!-- App Insights --> | <!-- > 500ms or timeout --> |
| <!-- e.g., Overall API --> | <!-- Availability --> | <!-- 99.95% --> | <!-- Monthly --> | <!-- Synthetic test --> | <!-- non-2xx or timeout > 5s --> |
| | | | | | |

- **Composite SLO**: <!-- yes / no — should the root entity reflect a single "system healthy?" answer? -->
- **Error budget policy**: <!-- e.g., "freeze deploys at < 20% budget" — or leave blank -->

---

## 5. Top Concerns

<!-- Rank 1-5. These drive which signals get highest priority and tightest thresholds. -->

1.
2.
3.
4.
5.

<details><summary>Examples to pick from</summary>

- Data loss or corruption
- High latency for end users
- Cascading failures across stamps
- AI service throttling during peak
- Cost overrun from autoscaling
- Noisy alerts drowning real issues
- Silent failures (system broken but no alert)
- Certificate expiry
- Dependency on a single region
- Deployment breaking production

</details>

---

## 6. What to Observe

<!-- Generated from discovery. Check [x] to include, set priority H/M/L. -->
<!-- Add rows for anything the discovery missed. -->

| Include | Resource | Type | Suggested signals | Priority | Notes |
|---------|----------|------|-------------------|----------|-------|
| | <!-- filled by discovery --> | | | | |

---

## 7. Alert Philosophy

- **Sensitivity**: <!-- `quiet` = only critical / `balanced` = reasonable defaults / `noisy` = catch everything early -->
- **Audience**: <!-- NOC dashboard / team Grafana / executive summary / on-call rotation -->
- **On Degraded**: <!-- page / Slack notify / dashboard only -->
- **On Unhealthy**: <!-- page immediately / create incident / auto-remediate -->

---

## 8. Stamp & Regional Behavior

- **Independent stamp health?**: <!-- yes = each stamp gets its own entity subtree / no = flat -->
- **Stamps equally important?**: <!-- yes / no — if no, which is primary? -->
- **One stamp down = ?**: <!-- `Degraded` (system still up) / `Unhealthy` (system broken) -->

---

## 9. Environment & Exclusions

- **Environments to include**: <!-- prod / staging / both -->
- **Exclude resources matching**: <!-- e.g., "dev-*", "test-*" -->
- **Out-of-scope resources**: <!-- List anything discovered that should NOT be in the health model -->

---

## 10. Defaults If Left Blank

> The skills will assume the following for any section you skip.
> If these defaults are wrong for you, fill in the section above.

| Section | Default assumption |
|---------|-------------------|
| Azure scope | Current `az account show` subscription; all RGs provided to discovery |
| Role / scope | Full-stack operator; all discovered resources in scope |
| User journeys | Derived from resource dependencies (infra-shaped, not user-shaped) |
| SLO targets | Conservative service defaults from signal catalog |
| Top concerns | Availability > Latency > Errors > Saturation |
| What to Observe | All production-looking resources at Medium priority |
| Sensitivity | Balanced |
| Stamp behavior | Independent per stamp; one down = Degraded |
| Environment | Production only; exclude resources tagged dev/test |
