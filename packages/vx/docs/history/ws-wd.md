# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-1.** `vx watch`'s idle debounce reset on every event with no cap, so a
  writer that never paused 150 ms (a dev server logging into its project every
  50 ms) kept the loop idle for good and an edit never ran. A window now closes
  at most 1 s after its first event. Row: `tests/watch-loop.test.ts` › "a writer
  that never pauses for a debounce window does not hold an edit back".
