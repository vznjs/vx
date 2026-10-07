# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-8.** In a workspace git does not track, `vx run` on a terminal
  showed the picker and only refused ("vx requires git") after a choice.
  The refusal now comes before the menu (`gitRefusal`, free via the
  memoized `repoFacts` when git tracks the root). Row:
  `tests/terminal.unsafe.test.ts` › "is never shown: the refusal comes first".
