# PromQL

## Build the query

- Use the [workspace query endpoint](https://learn.microsoft.com/azure/azure-monitor/metrics/prometheus-api-promql) with existing access.
- Check whether the metric is a counter or gauge. Check the range window, units and denominator.
- For counters, apply [rate](https://prometheus.io/docs/prometheus/latest/querying/functions/#rate) before aggregation.

## Check the results

- For signals, test instant-query results. Range-query matrices alone are not enough.
- Reduce labels to the intended population and inspect result cardinality.
- Report missing series, NaN/Inf and `or vector(0)` fallback values separately from measured zero.
