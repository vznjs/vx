# Workstream O — Windows (plan-2026-09-27)

Design: `docs/design/windows-2026-09.md`.

## Items

O-1. A Windows CI job, and the design. `core-windows` in `ci.yml`
(windows-latest, not required, `continue-on-error`) runs `vx run test`
for core, then the same shards as bare `bun test` for data. The first
run stopped at the first task: every task here declares `exec.sandbox`,
and vx refused it (`sandbox not available`), as it should. Queue: 34 s
to a Windows runner (macOS 82 s, Linux 2 s), 25 s of `bun install`.

O-3. Windows ships no `sh`, so every task and runtime probe exited 127.
On win32 the task shell is `bun exec` (`shellArgv`, `util/which.ts`),
with no `exec` wrap, no kill guard (an `sh` script over process groups)
and no `detached` spawn (a detached child has no console). Linux and
macOS spawn exactly as before.

## Leads for other streams

- B: `@anthropic-ai/sandbox-runtime` 0.0.76 ships a Windows backend
  (`vendor/srt-win`, set through `windows.srtWin.path`, exported as
  `VENDORED_SRT_WIN_EXE`). Wiring it gives `exec.sandbox` on Windows.
  It is also the only way this repo's own suite runs through vx there.
- B: on win32 the sandbox refusal says "install it (Linux: apt install
  bubblewrap socat ripgrep …)". That advice is wrong there.
- J: `caching.md` should say that a Windows artifact restores on Linux
  without an exec bit (Windows cannot see one), the same class as a
  native binary shared across OSes, with the same answer: a declared
  `cache.inputs.runtime` such as `node -p process.platform`.
