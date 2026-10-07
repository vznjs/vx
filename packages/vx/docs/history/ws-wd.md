# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-16.** A SIGINT, SIGTERM or SIGHUP after the summary signalled each kept server twice: once from the stop, then a SIGTERM from the keep-alive teardown once another kept server exited, still inside the grace. A server that reads a second signal as "quit now" lost its graceful shutdown. Under a stop the wait now awaits the stop's own teardown. Rows: `tests/keep-alive.test.ts` › "a SIGTERM after the summary signals a kept server once" (and SIGINT, SIGHUP).
