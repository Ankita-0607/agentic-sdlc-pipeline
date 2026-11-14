# ADR 002: A hand-written agent loop instead of an agent framework

**Status:** accepted

## Context

Agent frameworks and the SDK's own tool runner will run the
request → tool call → result loop for you. The pipeline needs three things to
happen at precise points in that loop: a budget check before every model call,
a policy check and an audit record around every tool call, and a typed
`submit_*` call that ends the loop.

## Decision

Write the loop directly against the Messages API (`src/agent/loop.ts`), behind
a small `LlmClient` interface.

## Consequences

- The control points are explicit and sit in under 200 lines anyone on the team can read.
- The interface makes the whole pipeline testable with a scripted model: rework loops, gate rejections and budget stops are covered by fast tests with no API key.
- We own the details a framework would hide: echoing thinking blocks back unchanged, returning all tool results in one message, refusing to run tool calls from a truncated response.
- If the needs outgrow this (parallel sub-agents, long-running sessions), moving to a managed agent runtime is a contained change behind the same interface.
