# Workstream XP — cross-platform (2026-10-07)

- **XP-30.** `vx init`: a root script's `cd packages/my\ app` (escaped
  space or paren) was not read as a cd into the member, so the root kept a
  task that runs the member's work. Row: `init.test.ts` "a cd into a
  member whose dir holds a backslash-escaped space runs the members".
