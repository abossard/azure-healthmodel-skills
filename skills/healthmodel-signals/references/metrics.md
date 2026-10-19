# Azure metrics

## Build the query

- Read the target resource's [metric definitions](https://learn.microsoft.com/rest/api/monitor/metric-definitions/list). Check the namespace, metric name, unit, dimensions, supported aggregations and time grains.
- Choose the aggregation, window and dimension filters for the population you want to measure.

## Check the response

- Inspect the returned series and timestamps. Keep null or missing datapoints separate from measured zero.
- Check the [effective response parameters](https://learn.microsoft.com/rest/api/monitor/metrics/list). Report adjusted time grains or ignored filters. Claim an exact match only when the response confirms it.
