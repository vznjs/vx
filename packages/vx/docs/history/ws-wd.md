# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-4.** A requested server streams raw past its frame and the summary, and a
  status line after its partial last line glued onto it
  (`partialvx: app#dev exited with code 2`). A status line now starts on its own line.
  Row: `tests/status-line.test.ts` › "a status line after a kept server partial line starts on its own line".
