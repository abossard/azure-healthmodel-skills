# KQL

## Build the query

- Inspect the actual tables and columns. Set the resource scope and time window.
- For a signal, set `timeGrain` or an explicit KQL window. Set `valueColumnName` to the numeric result column. Group only when the measurement needs it.

## Check the response

- [Summarize](https://learn.microsoft.com/kusto/query/summarize-operator) without grouping can return a count of zero for empty input. Check data coverage separately.
- Inspect [response errors](https://learn.microsoft.com/azure/azure-monitor/logs/api/response-format). HTTP 200 with `PartialError` is an incomplete result.

## Use query templates

For [query templates](https://learn.microsoft.com/azure/azure-monitor/health-models/signals#query-templates), quote supported substitutions and check the resolved query for each entity.
