#!/usr/bin/env -S bun --no-env-file --no-install
// Wrapped in an explicit async main so `bun build --compile` accepts
// the file. The compile target doesn't allow top-level await.
import { handOff, localVx, upgradesOnlyItself, vxPath } from './handoff.js'

let settled = false

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  try {
    // Inside the try: `process.cwd()` throws EMFILE when out of descriptors,
    // and that is a one-line UserError below, not a stack.
    const local = upgradesOnlyItself(argv)
      ? null
      : await localVx(
          process.cwd(),
          process.execPath,
          Bun.main.startsWith('/$bunfs') || (process.argv[1] ?? '').startsWith('/$bunfs'),
        )
    if (local !== null) await handOff(local, argv)
    // `vx --version` needs one leaf module; the dispatcher and the util
    // barrel it pulled in were 20 ms of its 28 (2026-10-01).
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === 'version')) {
      // `Bun.stdout`, not `process.stdout`: the Node stream's first touch is
      // ~7 ms, half of this verb (2026-10-02). A reader gone (EPIPE) is no
      // failure of the line.
      // Handed off, it says which vx ran and which one handed it the call.
      const from = process.env['VX_HANDED_OFF'] || undefined
      const where = from === undefined ? '' : ` (${vxPath()}, handed off from ${from})`
      await Bun.write(Bun.stdout, `vx ${(await import('./version.js')).VERSION}${where}\n`).catch(
        () => {},
      )
      settled = true
      return
    }
    listenForReadersGone()
    const { registerCoreAlias, run } = await import('./cli/index.js')
    // Every `import … from '@vzn/vx'` this process evaluates — a plugin
    // package, a workspace or project config — resolves to THIS core, not to
    // a second copy from node_modules (core-alias.ts says why and what it
    // costs). Registered before any verb runs; the façade loads on first use.
    registerCoreAlias(() => require('./index.js') as Record<string, unknown>)
    const code = await run(argv)
    // Not `process.exit` here: Bun drops what a pipe has not yet taken
    // when it follows a large write (300 KB written, 64 KiB delivered;
    // `vx history --format json` was cut mid-string, 2026-09-15). The code
    // is set, and `exitOnceFlushed` exits after both streams have ended.
    process.exitCode = code
  } catch (err) {
    const {
      detectColors,
      errorCode,
      errorDocument,
      fsRefusalHint,
      isFsRefusal,
      isOutOfFds,
      isUserError,
      maskedLine,
      OUT_OF_FDS_HINT,
      refusalNotice,
      ui,
      wantsJson,
    } = await import('./util/index.js')
    // A plugin's failure quotes what it was told (a remote's reply, a
    // header), and a config's own throw is its author's text: a secret in
    // either reached stderr whole (L-11).
    const say = (line: string): void => void process.stderr.write(maskedLine(line))
    // UserError (workspace not found, cycle, config invalid, ...) —
    // print the message only; the stack is noise the user can't act
    // on. Everything else gets the full stack so internal bugs are
    // debuggable.
    if (isUserError(err)) {
      // A message that names its verb (`vx why: …`) is that verb's; any
      // other is the verb typed. A config refusal shows its line.
      const named = /^(vx [a-z][\w-]*): /.exec(err.message)
      const typed = /^[a-z][\w-]*$/.test(argv[0] ?? '') ? `vx ${argv[0]}` : 'vx'
      const block = refusalNotice(
        named?.[1] ?? typed,
        named === null ? err.message : err.message.slice(named[0].length),
        err.parts,
      )
      process.stderr.write(maskedLine(ui.render([block], detectColors(process.stderr))))
    } else if (isOutOfFds(err)) {
      say(`vx: ${err.message} — ${OUT_OF_FDS_HINT}\n`)
    } else if (isFsRefusal(err)) {
      // The file system's refusal names the path; the stack would name
      // the verb's write, which the reader cannot act on either.
      say(`vx: ${err.message} — ${fsRefusalHint(err)}\n`)
    } else {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
      say(`vx: ${message}\n`)
    }
    // A verb asked for JSON answers JSON on a refusal too: an agent reading
    // stdout got nothing to parse, and only prose on stderr to branch on.
    if (wantsJson(argv)) {
      const message = err instanceof Error ? err.message : String(err)
      process.stdout.write(errorDocument(errorCode(err), maskedLine(message)))
    }
    // Same reason as the success path above: a large stderr is truncated by
    // `process.exit` too, and an error message cut in half is the one a
    // reader most needs whole.
    process.exitCode = 1
  }
  settled = true
  await exitOnceFlushed()
}

/**
 * Exit once stdout and stderr have ended, with the code the verb set. A
 * config can leave a timer behind (a top-level `setInterval`, an await that
 * hit its evaluation budget), and the loop it holds never drained: vx
 * printed its verdict and hung for good. Only after `main` has settled, so
 * `vx watch`, a plugin's long-lived verb and a run's kept-alive tasks end when their verb
 * does. `end(cb)` delivers a large write whole on Bun 1.4.2 (4 MiB under a
 * slow reader; `write('', cb)` delivered 450 KB), the floor `engines.bun`
 * holds. A stream whose end never calls back leaves the loop to drain. A
 * signal's handler exits by itself, with the signal's code.
 */
async function exitOnceFlushed(): Promise<void> {
  if ((await import('./util/index.js')).exitClaimedBySignal()) return
  let open = 2
  const ended = (): void => {
    if (--open === 0) process.exit()
  }
  process.stdout.end(ended)
  process.stderr.end(ended)
}

// The loop drained while the verb was still pending: something it awaits
// can never settle (a plugin hook whose promise is never resolved), and
// with no exit code set Bun exits 0 — a run whose task failed reported
// green, and its task had not even run (item 921). An exit that no
// verdict reached is a failure, and says so.
process.on('beforeExit', () => {
  if (settled) return
  settled = true
  process.stderr.write(
    'vx: the run stopped before it finished: something it awaited can never settle (a plugin hook?)\n',
  )
  process.exitCode = 1
})

// A reader that leaves is not the run's failure. `vx run build | head -1`
// closes the pipe after one line; every later write gets EPIPE, which Bun
// raises as an `error` event on the stream, and an `error` nobody listens
// for is an uncaught exception: the run died with a stack after its task
// had succeeded, exit 1, its lock directory left behind (2026-09-16). With
// a listener the write returns false, the run finishes, saves, releases,
// and exits with its own verdict; what was going to the reader goes
// nowhere. Same for stderr (`2>&1 | head`). Here and not in the logger:
// an embedder's streams are the embedder's.
// Set up past `--version`, which never touches the Node streams.
function listenForReadersGone(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => {})
  }
}

void main()
