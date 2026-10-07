# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-5.** A run whose task came from the picker recorded its command as
  `vx run` plus the flags, so `vx last` printed a line that opened the
  picker again instead of re-running the choice. The picked `pkg#task` is
  now named first in the recorded command. Row:
  `tests/terminal.unsafe.test.ts` › "is named in the command `vx last` replays".
