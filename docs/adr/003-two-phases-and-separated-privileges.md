# ADR 003: Two phases with a human gate, and separated CI privileges

**Status:** accepted

## Context

The cheapest moment to catch a wrong direction is before any code exists, and
the most valuable human attention is on the plan and on the final diff. In CI,
the pipeline also has to run tests that an agent wrote, on a runner that holds
credentials.

## Decision

1. Split the run into a **plan phase** (spec and plan, no writes) and a
   **build phase** (implement, verify, review). A human approves in between.
   On GitHub the plan is posted on the issue and `/approve` from a collaborator
   starts the build.
2. Whether the gate applies is a property of the repository policy. There is no
   flag to skip it.
3. In CI, the build job has a read-only repository token. It hands a patch to a
   publish job that has write access, re-checks the patch against the policy
   and opens the pull request. The publish job never runs agent-written code.

## Consequences

- A rejected plan costs a few cents and leaves the repository untouched.
- The approver's name is recorded in the audit log and in the commit trailer.
- The plan phase and build phase are separate processes, so the plan state has to travel between them (a file locally, a hidden block in the issue comment on GitHub).
- The split adds a job and an artifact hand-off to the workflow. That is the price of not giving a write token to a job that executes generated code.
