# `src/orchestrator/worker-exec.ts` — agent-side execution primitive

## Purpose

What a distribution worker/agent calls to execute a coordinator-assigned
task: spawn the command, stream stdout/stderr back, return exit code +
duration. Lives in orchestrator/ so cli (and the cloud package) can call
it without a cli → exec edge (deliberately absent from the module
matrix).

## Invariants

- No sandbox, no cache — the worker is compute-fungible; caching
  happens via the remote layer if at all (the vx-agents roadmap adds
  cache participation; see docs/design/dev-flows-ci-agents-2026-07.md).
