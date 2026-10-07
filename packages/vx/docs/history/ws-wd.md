# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-6.** With several kept servers, a server's unfinished last line was held for
  its newline and printed only at settle, below its own `exited with code` notice.
  A status line now flushes held partial lines first.
  Row: `tests/status-line.test.ts` › "a kept server partial line prints before a later status line".
