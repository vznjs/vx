# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-3.** A persistent task kept only as a dependency that exited 0 (a daemon that forked and returned, `docker compose up -d`) ended the foreground hold: the requested dev server was stopped right after the summary and vx exited 0. Now such an exit ends the hold only as the last kept server; a requested one, or a non-zero exit, ends it as before. Row: `tests/keep-alive.test.ts` › "a dependency daemon that exits 0 leaves the requested server held".
