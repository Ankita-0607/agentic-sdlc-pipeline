# ADR 001: Guardrails are enforced in code, not in prompts

**Status:** accepted

## Context

The pipeline lets a language model propose file writes and trigger a command in
a real repository. The usual first instinct is to describe the limits in the
system prompt ("only edit files under src/"). Prompts are probabilistic: a
model can misread them, and text in an issue can argue against them.

## Decision

Every limit that must hold is checked by deterministic code at the tool
boundary (`src/policy/policy.ts`), driven by a policy file in the target
repository. Prompts describe the policy so the model can plan within it, but a
prompt is never the only thing standing between a model and a protected file.

The policy is checked twice: when a tool is called, and again against the real
git change set before review.

## Consequences

- A denied action is an ordinary, logged event that the model sees and can adapt to, not a security incident.
- The policy can be reviewed, diffed and tested like any other code (see `test/policy.test.ts`).
- The model has no general shell. Tasks that need one (installing a dependency, running a migration) are out of scope until there is a sandbox to run them in.
