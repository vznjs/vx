# `src/orchestrator/run-context.ts` — git/CI/host capture

## Purpose

The per-run context for the `invocations` header row and the telemetry
`RunContextRecord`: commit, branch, dirty, CI provider, host/os/arch.

## Public surface

- `captureGitContext(root, dirty)` — ONE `git rev-parse` spawn for
  commit+branch; `dirty` is passed in (reused from the
  `git status --porcelain` the GitFilesCache populate already ran — no
  second status spawn). Behind try/catch; fields null on failure.
- `detectCi(env)` — provider matrix (GitHub, GitLab, Buildkite, …).
- `captureHostContext()` — hostname/os/arch.

## Invariants

- ≤1 extra git spawn per run; never fails a run.
