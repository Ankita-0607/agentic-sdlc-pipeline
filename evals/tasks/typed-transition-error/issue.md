# Throw a typed error for invalid status transitions

The API layer needs to tell "this status change is not allowed" (which should
become a 409 for the caller) apart from every other failure. Today
`applyTransition` throws a plain `Error`, so the only way to tell is to match on
the message text, which is brittle.

## What we need

In `src/transitions.ts`:

- Export a class `InvalidTransitionError` that extends `Error`, with
  `name === "InvalidTransitionError"` and three readonly fields:
  `sampleId: string`, `from: SampleStatus | null` (null for a sample with no
  history) and `to: SampleStatus`.
- `applyTransition` throws `InvalidTransitionError` when the transition is not
  allowed. The message keeps its current format
  (`Cannot move sample <id> from <status or "new"> to <status>`), because log
  alerts match on it.
- An event timestamp earlier than the previous event stays a plain `Error`. It
  is a data problem, not a transition problem, and must **not** be an
  `InvalidTransitionError`.
