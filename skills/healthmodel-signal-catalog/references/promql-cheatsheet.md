# PromQL Cheatsheet — Kubernetes Health Model

> Reference for `healthmodel-design` when building `PrometheusMetricsQuery` signals for AKS entities.
> All queries assume an Azure Monitor Workspace (AMW) receiving Prometheus metrics from an AKS cluster.
> `<ns>` = Kubernetes namespace — hard-code the actual value in signal definitions (no variable substitution).

---

## 1 — Discovery & Investigation Queries

Use these interactively (via Recipe 5 in [metrics.md](./metrics.md)) to understand what's available before writing signals.

### Node conditions — list all distinct conditions & their status
```promql
group by (condition, status) (kube_node_status_condition == 1)
```
Common conditions: `Ready`, `DiskPressure`, `MemoryPressure`, `PIDPressure`, `NetworkUnavailable`.

### All nodes and their Ready status
```promql
kube_node_status_condition{condition="Ready"} == 1
```

### Nodes that are NOT Ready
```promql
kube_node_status_condition{condition="Ready", status="true"} == 0
```

### List all namespaces with running pods
```promql
group by (namespace) (kube_pod_status_phase{phase="Running"} == 1)
```

### All pod phases per namespace
```promql
group by (namespace, phase) (kube_pod_status_phase == 1)
```

### All container waiting reasons in a namespace
```promql
group by (reason) (kube_pod_container_status_waiting_reason{namespace="<ns>"} > 0)
```
Possible values: `CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, `CreateContainerConfigError`, `ContainerCreating`, …

### All container termination reasons in a namespace
```promql
group by (reason) (kube_pod_container_status_last_terminated_reason{namespace="<ns>"} == 1)
```
Possible values: `OOMKilled`, `Error`, `Completed`, `ContainerCannotRun`, `DeadlineExceeded`, …

### Pods per node (scheduling distribution)
```promql
count by (node) (kube_pod_info)
```

### Resource requests vs limits per namespace
```promql
sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"})
sum by (namespace) (kube_pod_container_resource_limits{resource="cpu"})
sum by (namespace) (kube_pod_container_resource_requests{resource="memory"})
sum by (namespace) (kube_pod_container_resource_limits{resource="memory"})
```

### Top 10 pods by memory / CPU usage
```promql
topk(10, container_memory_working_set_bytes{container!="", container!="POD"})
topk(10, rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[5m]))
```

### All deployments and their replica counts
```promql
kube_deployment_spec_replicas
```

### Deployments scaled to zero
```promql
kube_deployment_spec_replicas == 0
```

---

## 2 — Pod Health Signals

These are the primary signals for a health model. Each returns a single scalar suitable for threshold evaluation.

### Pod Restarts (15m window)
```promql
sum(increase(kube_pod_container_status_restarts_total{namespace="<ns>"}[15m]))
  or vector(0)
```
- `dataUnit`: Count, `timeGrain`: PT15M, direction: higher-is-worse
- Degraded: `> 1`, Unhealthy: `> 5`

### OOMKilled containers
```promql
sum(kube_pod_container_status_last_terminated_reason{namespace="<ns>", reason="OOMKilled"} == 1)
  or vector(0)
```
- `dataUnit`: Count, direction: higher-is-worse
- Degraded: `> 0`, Unhealthy: `> 2`

### CrashLoopBackOff containers
```promql
sum(kube_pod_container_status_waiting_reason{namespace="<ns>", reason="CrashLoopBackOff"})
  or vector(0)
```
- `dataUnit`: Count, direction: higher-is-worse
- Degraded: `> 0`, Unhealthy: `> 1`

### Pending Pods
```promql
count(kube_pod_status_phase{namespace="<ns>", phase="Pending"} == 1) or vector(0)
```
- `dataUnit`: Count, direction: higher-is-worse
- Degraded: `> 0`, Unhealthy: `> 3`

---

## 3 — CPU & Memory Utilization

### CPU usage vs requests (%)
```promql
sum(rate(container_cpu_usage_seconds_total{namespace="<ns>", container!="", container!="POD"}[5m]))
  / sum(kube_pod_container_resource_requests{namespace="<ns>", resource="cpu"})
  * 100
  or vector(0)
```
- `dataUnit`: Percent, `timeGrain`: PT5M, direction: higher-is-worse
- Degraded: `> 80`, Unhealthy: `> 95`

### CPU Throttling (%)
```promql
(sum(rate(container_cpu_cfs_throttled_periods_total{namespace="<ns>", container!=""}[5m]))
  / sum(rate(container_cpu_cfs_periods_total{namespace="<ns>", container!=""}[5m]))
  * 100) or vector(0)
```
- ⚠️ `container_cpu_cfs_periods_total` only exists when the container has a CPU **limit** set
- `dataUnit`: Percent, direction: higher-is-worse
- Degraded: `> 20`, Unhealthy: `> 50`

### Memory usage vs limits (%)
```promql
sum(container_memory_working_set_bytes{namespace="<ns>", container!="", container!="POD"})
  / sum(kube_pod_container_resource_limits{namespace="<ns>", resource="memory"})
  * 100
  or vector(0)
```
- `dataUnit`: Percent, direction: higher-is-worse
- Degraded: `> 80`, Unhealthy: `> 95`

---

## 4 — Node Pressure (cross-metric join pattern)

Count your namespace's running pods that land on nodes with a specific condition:

```promql
count(
  (kube_pod_info{namespace="<ns>"}
    * on(namespace,pod) group_left()
      (kube_pod_status_phase{namespace="<ns>", phase="Running"} == 1)
  )
  * on(node) group_left()
    (<node_condition_expr>)
) or vector(0)
```

> ⚠️ **node-exporter metrics use `instance`, not `node`.** For CPU/memory pressure
> joins, rename `instance` → `node` with `label_replace`. `kube_node_status_condition`
> already has `node` — no rename needed.

### Pods on High-CPU Nodes (>80%)
```promql
# <node_condition_expr>:
label_replace(
  (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) > 0.8,
  "node", "$1", "instance", "(.+)"
)
```

### Pods on High-Memory Nodes (>85%)
```promql
# <node_condition_expr>:
label_replace(
  (1 - avg by (instance) (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) > 0.85,
  "node", "$1", "instance", "(.+)"
)
```

### Pods on DiskPressure / MemoryPressure / PIDPressure / NotReady Nodes
```promql
kube_node_status_condition{condition="DiskPressure",    status="true"}  == 1
kube_node_status_condition{condition="MemoryPressure",  status="true"}  == 1
kube_node_status_condition{condition="PIDPressure",     status="true"}  == 1
kube_node_status_condition{condition="Ready",           status="false"} == 1
```

#### Available `kube_node_status_condition` values

| condition | status="true" means | status="false" means |
|-----------|---------------------|----------------------|
| `Ready` | Node is healthy | Node is NOT healthy |
| `DiskPressure` | Disk is full | Disk is OK |
| `MemoryPressure` | Memory is low | Memory is OK |
| `PIDPressure` | Too many processes | PIDs are OK |
| `NetworkUnavailable` | Network not configured | Network is OK |

---

## 5 — Deployment & Scaling

### Minimum Deployment Replicas
```promql
min(kube_deployment_spec_replicas{namespace="<ns>"}) or vector(0)
```
- `dataUnit`: Count, direction: lower-is-worse
- Degraded: `< 2`, Unhealthy: `< 1`

### Deployments with unavailable replicas
```promql
count(kube_deployment_status_replicas_ready{namespace="<ns>"}
  < kube_deployment_spec_replicas{namespace="<ns>"})
  or vector(0)
```
- `dataUnit`: Count, direction: higher-is-worse
- Degraded: `> 0`, Unhealthy: `> 1`

### HPA at Ceiling (current == max)
```promql
count(
  kube_horizontalpodautoscaler_status_current_replicas{namespace="<ns>"}
    == kube_horizontalpodautoscaler_spec_max_replicas{namespace="<ns>"}
) or vector(0)
```
- `dataUnit`: Count, direction: higher-is-worse
- Degraded: `> 0`, Unhealthy: `> 1`

---

## 6 — Networking

### Container Network Errors
```promql
sum(
  rate(container_network_receive_errors_total{namespace="<ns>"}[5m])
  + rate(container_network_transmit_errors_total{namespace="<ns>"}[5m])
) or vector(0)
```
- `dataUnit`: CountPerSecond, direction: higher-is-worse

### Istio 5xx Error Rate (%)
```promql
(sum(rate(istio_requests_total{destination_workload_namespace="<ns>", response_code=~"5.."}[5m]))
  / sum(rate(istio_requests_total{destination_workload_namespace="<ns>"}[5m]))
  * 100) or vector(0)
```

### Istio P99 Latency (ms)
```promql
(histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket{destination_workload_namespace="<ns>"}[5m])) by (le)
) > 0) or vector(0)
```

---

## 7 — Cert Manager

### Certificate Days to Expiry
```promql
min((certmanager_certificate_expiration_timestamp_seconds - time()) / 86400)
  or vector(0)
```
- `dataUnit`: Count (days), direction: lower-is-worse
- Degraded: `< 30`, Unhealthy: `< 7`

### Certificates Not Ready
```promql
count(certmanager_certificate_ready_status{condition="False"} == 1) or vector(0)
```
- `dataUnit`: Count, direction: higher-is-worse
- Degraded: `> 0`, Unhealthy: `> 1`

---

## PromQL Pattern Reference

### Aggregation functions

| Function | Purpose |
|----------|---------|
| `sum()` | Total across series |
| `count()` | Number of series matching |
| `min()` / `max()` | Extremes across series |
| `avg()` | Average across series |
| `topk(N, ...)` | Top N series by value |
| `group by (label) (metric)` | List distinct label values (returns 1 per combo) |

### Rate & change

| Pattern | Purpose |
|---------|---------|
| `rate(counter[5m])` | Per-second rate over 5m |
| `increase(counter[15m])` | Total increase over 15m |
| `changes(gauge[15m])` | Number of value changes |

### Ratios

| Pattern | Purpose |
|---------|---------|
| `sum(rate(errors[5m])) / sum(rate(total[5m])) * 100` | Error percentage |
| `sum(usage) / sum(limit) * 100` | Utilization percentage |

### Histograms
```promql
histogram_quantile(0.99, sum by (le) (rate(my_bucket[5m])))
```

### Joins

| Syntax | Purpose |
|--------|---------|
| `A * on(label) group_left() B` | Inner join A×B, keep left labels |
| `A * on(l1,l2) group_left() B` | Join on multiple labels |

### Null safety

| Pattern | Purpose |
|---------|---------|
| `... or vector(0)` | Return 0 when no series match |
| `(expr > 0) or vector(0)` | Clamp negatives to zero |

### Label matchers

| Syntax | Meaning |
|--------|---------|
| `{label="value"}` | Exact match |
| `{label!="value"}` | Not equal |
| `{label=~"5.."}` | Regex match |
| `{label!~"test.*"}` | Negative regex |

### Time math

| Pattern | Purpose |
|---------|---------|
| `time()` | Current unix timestamp |
| `(ts - time()) / 86400` | Days until timestamp |

---

## Cross-references

- [promql-validation.md](./promql-validation.md) — how to develop, test, and validate PromQL queries with `az rest`
- [metrics.md](./metrics.md) — Recipe 5 (probe PromQL) and Recipe 10 (local sanity check)
- `healthmodel-design/SKILL.md` Step 1b — AKS PromQL signal generation
- `healthmodel-deploy/scripts/validate-promql.sh` — automated validation script
