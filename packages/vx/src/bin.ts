#!/usr/bin/env bun
import { registerCoreAlias, run } from './cli/index.js'
import { fsRefusalHint, isFsRefusal, isUserError } from './util/index.js'

// Every `import … from '@vzn/vx'` this process evaluates — a plugin
// package, a workspace or project config — resolves to THIS core, not to
// a second copy from node_modules (core-alias.ts says why and what it
// costs). Registered before any verb runs; the façade loads on first use.
registerCoreAlias(() => import('./index.js') as Promise<Record<string, unknown>>)

// Wrapped in an explicit async main so `bun build --compile` accepts
// the file. The compile target doesn't allow top-level await.
async function main(): Promise<void> {
  try {
    const code = await run(process.argv.slice(2))
    // NOTHING calls `process.exit` here, and that is the fix rather than a
    // simplification. Bun drops what a pipe has not yet taken when
    // `process.exit` follows a large write: 300 KB written then exit
    // delivered 64 KiB (128 KiB after a tick), and `vx history --format
    // json` on a 300-project workspace was cut mid-string (2026-09-15).
    // `stdout.end(cb)` fixed that on 1.4.2 — and on 1.3.11 the callback
    // still fires early: 2 MiB written, 214 KB delivered (2026-09-20).
    // Setting the code and letting the loop drain is the one form that
    // does not depend on when a runtime decides a pipe is flushed; it
    // costs a hang if a verb leaves a handle open, which the suite's
    // several hundred spawns of this binary would show at once.
    process.exitCode = code
  } catch (err) {
    // UserError (workspace not found, cycle, config invalid, ...) —
    // print the message only; the stack is noise the user can't act
    // on. Everything else gets the full stack so internal bugs are
    // debuggable.
    if (isUserError(err)) {
      // A message that already names the tool (`vx why: …`, thrown by a verb
      // that wants its own name in the line) is printed as it is; prefixing
      // it produced `vx: vx why: …` (walkthrough, 2026-09-04).
      const m = err.message
      process.stderr.write(m.startsWith('vx ') ? `${m}\n` : `vx: ${m}\n`)
    } else if (isFsRefusal(err)) {
      // The file system's refusal names the path; the stack would name
      // the verb's write, which the reader cannot act on either.
      process.stderr.write(`vx: ${err.message} — ${fsRefusalHint(err)}\n`)
    } else {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
      process.stderr.write(`vx: ${message}\n`)
    }
    // Same reason as the success path above: a large stderr is truncated by
    // `process.exit` too, and an error message cut in half is the one a
    // reader most needs whole.
    process.exitCode = 1
  }
}

// A reader that leaves is not the run's failure. `vx run build | head -1`
// closes the pipe after one line; every later write gets EPIPE, which Bun
// raises as an `error` event on the stream, and an `error` nobody listens
// for is an uncaught exception: the run died with a stack after its task
// had succeeded, exit 1, its lock directory left behind (2026-09-16). With
// a listener the write returns false, the run finishes, saves, releases,
// and exits with its own verdict; what was going to the reader goes
// nowhere. Same for stderr (`2>&1 | head`). Here and not in the logger:
// an embedder's streams are the embedder's.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {})
}

void main()
