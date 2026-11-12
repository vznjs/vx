#!/usr/bin/env -S bun --no-env-file --no-install
// Wrapped in an explicit async main so `bun build --compile` accepts
// the file. The compile target doesn't allow top-level await.
import { handOff, localVx, upgradesOnlyItself, vxPath } from './handoff.js'
import { takeSignalRelay } from './util/signal-relay.js'

let settled = false

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // Out of the env before anything spawns: no task, and no vx this one hands off to, inherits it.
  takeSignalRelay()
  // A rejection nothing awaited (a plugin verb's floating promise) is a
  // failure: the exit after the streams end came before Bun reported it,
  // and the run said nothing and exited 0. Its line is written here, not
  // after an import: one reported in the turn the exit ends the streams
  // landed after stderr had ended and was dropped (exit 1, no word of why).
  process.on('unhandledRejection', (reason) => {
    process.exitCode = 1
    const ui = require('./ui/index.js') as typeof import('./ui/index.js')
    const { maskedLine } = require('./util/index.js') as typeof import('./util/index.js')
    ui.say(
      'error',
      maskedLine(
        `vx: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`,
      ),
    )
  })
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
    // `vx --version` needs one leaf module; the dispatcher and the util barrel
    // it pulled in were 20 ms of its 28.
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === 'version')) {
      // Handed off, it says which vx ran and which one handed it the call.
      const from = process.env['VX_HANDED_OFF'] || undefined
      const where = from === undefined ? '' : ` (${vxPath()}, handed off from ${from})`
      const [{ VERSION }, { printVersion }] = await Promise.all([
        import('./version.js'),
        import('./ui/version-line.js'),
      ])
      await printVersion(VERSION, where)
      settled = true
      return
    }
    listenForReadersGone()
    const { registerCoreAlias, run } = await import('./cli/index.js')
    // Every `import … from '@vzn/vx'` this process evaluates — a plugin
    // package, a workspace or project config — resolves to THIS core, not to
    // a second copy from node_modules (core-alias.ts says why and what it
    // costs). Registered before any verb runs; the façade loads on first use.
    registerCoreAlias(
      () => require('./index.js') as Record<string, unknown>,
      () => require('./config.js') as Record<string, unknown>,
    )
    // A refusal too: work a verb left running (a config bundle) finishes,
    // never cut by the exit below with its temp dir left behind.
    const { settleBeforeExit } = await import('./util/index.js')
    const code = await run(argv).finally(settleBeforeExit)
    // Not `process.exit` here: Bun drops what a pipe has not yet taken when it
    // follows a large write (300 KB written, 64 KiB delivered; `vx history
    // --format json` was cut mid-string). The code is set, and
    // `exitOnceFlushed` exits after both streams have ended.
    process.exitCode = code
  } catch (err) {
    const ui = await import('./ui/index.js')
    const { refusalNotice } = ui
    const {
      errorCode,
      errorDocument,
      fsRefusalHint,
      isFsRefusal,
      isOutOfFds,
      isUserError,
      maskedLine,
      OUT_OF_FDS_HINT,
      wantsJson,
    } = await import('./util/index.js')
    // A plugin's failure quotes what it was told (a remote's reply, a header),
    // and a config's own throw is its author's text: a secret in either reached
    // stderr whole.
    const say = (line: string): void => ui.say('error', maskedLine(line))
    // UserError (workspace not found, cycle, config invalid,...) — print the
    // message only; the stack is noise the user can't act on. Everything else
    // gets the full stack so internal bugs are debuggable.
    if (isUserError(err)) {
      // A message that names its verb (`vx why: …`, a plugin's `vx dte
      // worker: …`) is that verb's; any other is the verb typed. A config
      // refusal shows its line.
      // A plugin verb may hold a capital, `.` or `:` (`my.verb`).
      const named = /^(vx [A-Za-z0-9][\w:.-]*(?: [a-z][\w-]*)?): /.exec(err.message)
      const typed = /^[A-Za-z0-9][\w:.-]*$/.test(argv[0] ?? '') ? `vx ${argv[0]}` : 'vx'
      const block = refusalNotice(
        named?.[1] ?? typed,
        named === null ? err.message : err.message.slice(named[0].length),
        err.parts,
      )
      ui.data('err', maskedLine(ui.render([block], ui.colorsOf('err'))))
    } else if (cwdGone(err)) {
      // Removed under the shell (a checkout of another branch, `rm -rf` in
      // another): every verb starts from the cwd.
      say('vx: the current directory no longer exists — cd into the workspace again and re-run\n')
    } else if (isOutOfFds(err)) {
      say(`vx: ${err.message} — ${OUT_OF_FDS_HINT}\n`)
    } else if (isFsRefusal(err)) {
      // The file system's refusal names the path; the stack would name
      // the verb's write, which the reader cannot act on either.
      say(`vx: ${err.message} — ${fsRefusalHint(err)}\n`)
    } else {
      say(`vx: ${withCauses(err)}\n`)
    }
    // A verb asked for JSON answers JSON on a refusal too: an agent reading
    // stdout got nothing to parse, and only prose on stderr to branch on.
    if (wantsJson(argv)) {
      const message = err instanceof Error ? err.message : String(err)
      ui.data('out', errorDocument(errorCode(err), maskedLine(message)))
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
  // One macrotask: a floating rejection is reported after the microtasks
  // drain, and its handler above sets the code and writes its line.
  await new Promise((resolve) => setImmediate(resolve))
  let open = 2
  const ended = (): void => {
    if (--open === 0) process.exit()
  }
  process.stdout.end(ended)
  process.stderr.end(ended)
}

/**
 * An error's stack, then each `cause` under it: a config or plugin that
 * wraps a failure (`new Error(msg, { cause })`) put the reason there, and
 * the stack alone printed only the wrapper. Bounded, and a cause seen
 * before ends the chain.
 */
function withCauses(err: unknown): string {
  const text = (e: unknown): string =>
    e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e)
  let out = text(err)
  const seen = new Set<unknown>([err])
  let at = err instanceof Error ? err.cause : undefined
  for (let depth = 0; at !== undefined && at !== null && !seen.has(at) && depth < 8; depth++) {
    seen.add(at)
    out += `\nCaused by: ${at instanceof Error ? text(at) : Bun.inspect(at)}`
    at = at instanceof Error ? at.cause : undefined
  }
  return out
}

// The loop drained while the verb was still pending: something it awaits can
// never settle (a plugin hook whose promise is never resolved), and with no
// exit code set Bun exits 0 — a run whose task failed reported green, and its
// task had not even run. An exit that no verdict reached is a failure, and says
// so.
process.on('beforeExit', () => {
  if (settled) return
  settled = true
  const util = require('./util/index.js') as typeof import('./util/index.js')
  const hooks = util.unsettledHooks()
  ;(require('./ui/index.js') as typeof import('./ui/index.js')).say(
    'error',
    `vx: the run stopped before it finished: ${hooks.length > 0 ? hooks.join(', ') : 'something it awaited can never settle (a plugin hook?)'}`,
  )
  process.exitCode = 1
  // Teardown runs on every exit (plugin.ts): the plugins' factories and
  // setup ran, and what they opened is theirs to release. Its timers keep
  // the loop up; the next drain finds `settled` and exits.
  void util.settleStranded()
})

/** `process.cwd()`'s refusal of a directory removed under the process. */
function cwdGone(err: unknown): boolean {
  return (
    (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' &&
    /\buv_cwd\b/.test((err as Error).message)
  )
}

// A reader that leaves is not the run's failure. `vx run build | head -1`
// closes the pipe after one line; every later write gets EPIPE, which Bun
// raises as an `error` event on the stream, and an `error` nobody listens for
// is an uncaught exception: the run died with a stack after its task had
// succeeded, exit 1, its lock directory left behind. With a listener the write
// returns false, the run finishes, saves, releases, and exits with its own
// verdict; what was going to the reader goes nowhere. Same for stderr (`2>&1 |
// head`). Here and not in the logger: an embedder's streams are the embedder's.
// Set up past `--version`, which never touches the Node streams.
function listenForReadersGone(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => {})
  }
}

void main()
