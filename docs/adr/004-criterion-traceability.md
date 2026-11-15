# ADR 004: Criterion-to-test traceability is deterministic and tag-based

**Status:** accepted

## Context

The run report said whether each acceptance criterion was "met", but that
verdict came from the reviewer agent. The pipeline's own verification only knew
that the whole test command exited zero. Nothing connected an individual
criterion to the tests that prove it, which is the link a reviewer, and an
auditor in a regulated setting, asks for first.

## Decision

Tests declare the criteria they prove by carrying the criterion id in square
brackets in the test name (`[AC1]`). After the test command passes, the
pipeline runs a second command from the policy (`traceability.report_command`)
that writes a Jest-format JSON report to a path outside the workspace, and
builds the matrix from that report in plain code (`src/trace/trace.ts`).

- The matrix is evidence the pipeline gathered, kept apart from the two agent
  opinions (the implementer's `criteria_status`, the reviewer's `criteria_check`).
- Enforcement is a policy choice: `report` informs the human reviewer,
  `required` makes a gap fail verification. If the report cannot be read under
  `required`, verification fails rather than passing unverified.
- The tag lives in the test name because every test runner reports names. No
  runner plugin or annotation syntax is needed, and the convention is the same
  for tests a person writes.

## Consequences

- One extra test run per verified round.
- The check is cheap to satisfy dishonestly: a test can carry a tag and assert
  nothing useful. The matrix is therefore shown to the reviewer agent with that
  caveat, and the eval suite's hidden tests still measure escaped defects.
- `asdlc trace` exposes the same check for a spec and a report produced
  elsewhere, so it can gate pull requests that people wrote.
- Not done yet: judging whether a tagged test really checks its criterion
  (for example by mutating the code and seeing whether the test notices), and
  flagging changed code that no criterion asks for.
