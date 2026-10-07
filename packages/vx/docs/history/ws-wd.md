# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-15.** A `vx watch` cycle whose server never matched `readyWhen`, with no
  `exec.timeout`, never ended, so every later edit (the fix included) waited behind
  it. An edit while the cycle waits on readiness alone now stops it and starts the
  next; a cycle running other work is not stopped. Row: `tests/watch-ready-interrupt.test.ts` › "an edit stops a cycle waiting on a server that never becomes ready".
