# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-10.** A dependency-only server that died on its own during the run had its output block close `running`, right under the line naming its exit code. The outcome is now failed in place before the renderer closes the block, so it reads `failed (exit <n>)`. Row: `tests/keep-alive.test.ts` › "a crashed dependency-only server's output block closes failed".
