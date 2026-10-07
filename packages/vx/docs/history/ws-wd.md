# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-7.** With a dev server held, `vx watch` counted every write after the last
  cycle as the server's, so three saves of one source file printed "a persistent
  task rewrites it. Add it to .gitignore". Only a file git did not track at the arm
  is blamed on the server now. Row: `tests/watch-server-blame.test.ts` › "three saves of a tracked file under a held server blame no server".
