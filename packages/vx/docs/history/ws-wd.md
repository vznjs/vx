# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-2.** The workspace-wide watcher read a literal `inputs.workspaceFiles` entry (`shared`, `conf/`) as one path, so no edit under that directory ran a cycle while the key read the tree. The root event filter now compiles entries through `asTrees`, the key's rule. Row: `tests/watch-rules.test.ts` › "a directory literal in workspaceFiles is its tree, as the key reads it (WD-2)".
- **WD-4.** A requested server streams raw past its frame and the summary, and a
  status line after its partial last line glued onto it
  (`partialvx: app#dev exited with code 2`). A status line now starts on its own line.
  Row: `tests/status-line.test.ts` › "a status line after a kept server partial line starts on its own line".

- **WD-6.** With several kept servers, a server's unfinished last line was held for
  its newline and printed only at settle, below its own `exited with code` notice.
  A status line now flushes held partial lines first.
  Row: `tests/status-line.test.ts` › "a kept server partial line prints before a later status line".

- **WD-3.** A persistent task kept only as a dependency that exited 0 (a daemon that forked and returned, `docker compose up -d`) ended the foreground hold: the requested dev server was stopped right after the summary and vx exited 0. Now such an exit ends the hold only as the last kept server; a requested one, or a non-zero exit, ends it as before. Row: `tests/keep-alive.test.ts` › "a dependency daemon that exits 0 leaves the requested server held".

- **WD-8.** In a workspace git does not track, `vx run` on a terminal
  showed the picker and only refused ("vx requires git") after a choice.
  The refusal now comes before the menu (`gitRefusal`, free via the
  memoized `repoFacts` when git tracks the root). Row:
  `tests/terminal.unsafe.test.ts` › "is never shown: the refusal comes first".

- **WD-7.** With a dev server held, `vx watch` counted every write after the last
  cycle as the server's, so three saves of one source file printed "a persistent
  task rewrites it. Add it to .gitignore". Only a file git did not track at the arm
  is blamed on the server now. Row: `tests/watch-server-blame.test.ts` › "three saves of a tracked file under a held server blame no server".

- **WD-10.** A dependency-only server that died on its own during the run had its output block close `running`, right under the line naming its exit code. The outcome is now failed in place before the renderer closes the block, so it reads `failed (exit <n>)`. Row: `tests/keep-alive.test.ts` › "a crashed dependency-only server's output block closes failed".

- **WD-11.** The line naming the kept server that ended the foreground wait counted every other kept server as stopped, dead ones included: `stopping 1 other persistent task` after both servers had crashed. It now counts only those still up, and says nothing when none is. Row: `tests/keep-alive.test.ts` › "the server that ends the wait counts only the others still up".

- **WD-20.** A watch cycle's start was read off `Date.now()` while mtimes come from the kernel's coarse clock, which lags it by up to a tick. A write the run made in that tick read as an edit, so an uncached task's rewrite of an ignored file it reads started an extra cycle. The start is taken from the mtime clock (`fsClockNow`) now, as the arm is. Row: `tests/watch-cycle-clock.test.ts` › "a cycle's own write is the run's though the fine clock runs ahead of mtimes".
