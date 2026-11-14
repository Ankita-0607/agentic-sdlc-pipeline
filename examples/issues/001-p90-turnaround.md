# Add 90th-percentile turnaround time to the client summary

Client success keeps asking for a tail-latency number alongside the median. A
client whose median turnaround looks fine can still have a handful of samples
that take far too long, and those are the ones they call us about.

## What we need

`summarizeByClient` in `examples/sample-service/src/summary.ts` should return a
new field on every row:

- `p90TatHours: number | null` — the 90th percentile of turnaround hours across
  the client's reported samples, using the **nearest-rank** method: sort the
  values ascending and take the value at position `ceil(0.9 × n)` (1-based).
- `null` when the client has no reported samples, the same as `medianTatHours`.

Examples: for turnarounds `[10, 20, 30, 40, 50, 60, 70, 80, 90, 100]` the p90
is `90`; for a single value `[24]` it is `24`.

## Notes

- Existing fields and ordering must not change.
- Please cover the new field with tests, including the one-sample and
  no-reported-samples cases.
