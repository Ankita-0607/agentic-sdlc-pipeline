# A sample taken off hold must return to the status it had before the hold

Today a held sample can be resumed into any in-progress status. That lets a
sample skip a step entirely: `received → on_hold → analysis` is accepted even
though the sample was never sequenced. QA found two of these in last month's
audit.

## Expected behaviour

In `src/transitions.ts`:

- Add `statusBeforeHold(sample: Sample): SampleStatus | null`. It returns the
  status the sample was in immediately before it went on hold, or `null` when
  the sample is not currently on hold.
- `applyTransition` only lets a held sample move back to that status. Any other
  target is rejected the same way as every other disallowed transition (an
  error whose message starts with `Cannot move sample`).
- `canTransition(from, to)` keeps its signature and behaviour. It only knows
  about statuses, not about a sample's history, so the stricter rule lives in
  `applyTransition`.

One of the existing tests resumes a held sample into a different status than it
was held from. That test encodes the bug and needs to be updated.
