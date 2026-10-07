# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-11.** The line naming the kept server that ended the foreground wait counted every other kept server as stopped, dead ones included: `stopping 1 other persistent task` after both servers had crashed. It now counts only those still up, and says nothing when none is. Row: `tests/keep-alive.test.ts` › "the server that ends the wait counts only the others still up".
