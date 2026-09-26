// The watch-probe delivery gate, beside the sandbox one and for the same
// reason: a capability the runtime may not provide, and a row that would
// otherwise report green by vanishing.
//
// `armWatcher` proves the stream is live by writing a DOTFILE probe and
// waiting for its event, and `vx watch` swaps in `pollWatcher` when that
// proof never arrives. The probe is what this gate reproduces, dot and all,
// because the dot is the part that fails: measured 2026-09-20 on this
// repo's cloud container, Bun 1.3.11's `fs.watch` delivers `rename` /
// `change` for `plain.txt` and NOTHING for `.dotfile` in the same
// directory, while node 22 on the same filesystem delivers both. So the
// native watcher works there for every file a user edits, and `vx watch`
// still polls — the readiness proof is coupled to hidden-file delivery,
// which is not the capability it means to test. CI's Bun 1.4.2 delivers
// the dotfile and the row runs.
//
// CI sets VX_REQUIRE_WATCH_EVENTS=1, so a runner that stops delivering is a
// failure there rather than a skip. A box without it skips that one row and
// keeps the rest — and the e2e suites assert per delivery mode, so the
// polling path is covered rather than merely tolerated.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { armWatcher } from '../../src/cli/watch.js'
import { envFlag } from './env.js'

const required = (): boolean => envFlag('VX_REQUIRE_WATCH_EVENTS')

let memo: boolean | undefined

/**
 * Can `armWatcher`'s readiness proof land here? Asked by RUNNING it — the
 * truest proxy there is, and the only one that matches its retry backoff. A
 * gate that wrote the probe once was more pessimistic than the thing it
 * gates, and would have skipped rows that pass.
 *
 * THROWS when `VX_REQUIRE_WATCH_EVENTS` is set and the proof never lands —
 * at module scope that fails the file with the reason attached.
 */
export async function watchProbeDelivered(label: string): Promise<boolean> {
  if (memo !== undefined) return memo
  // BOTH modes, and both must land. Delivery here is not a clean yes/no:
  // a recursive-only gate said "available" in one of twelve shard
  // processes and the NON-recursive row then failed in it, because Bun
  // 1.3.11 drops the hidden-file event most of the time rather than
  // always, and the two modes do not fail together. The rows arm both
  // forms, so the gate asks about both. On a runtime that delivers, each
  // lands in milliseconds.
  //
  // What this gate CANNOT answer, measured rather than assumed: it runs at
  // import, on an idle process, and the rows run later under twelve-way
  // shard load. Six consecutive probes landed here and the non-recursive
  // row still failed at `armed.ready` in that same process — readiness
  // timing out under load, not the capability missing. That one stays in
  // the container's baseline, like the other load-shaped watch row; CI,
  // where delivery is reliable, requires both rows via
  // VX_REQUIRE_WATCH_EVENTS.
  let delivered = true
  for (const recursive of [true, false]) {
    if (!delivered) break
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-probe-'))
    try {
      const armed = armWatcher(dir, recursive, () => {})
      try {
        delivered = await armed.ready
      } finally {
        armed.watcher.close()
      }
    } catch {
      // A runtime that refuses a form outright answers the same way.
      delivered = false
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  memo = delivered
  if (!delivered && required()) {
    throw new Error(
      `${label}: armWatcher could not prove delivery in a fresh directory. ` +
        `VX_REQUIRE_WATCH_EVENTS is set, so this is a failure and not a skip: ` +
        `the rows it gates are the ones that prove the native watcher works at all. ` +
        `Unset VX_REQUIRE_WATCH_EVENTS to skip them where the runtime does not deliver.`,
    )
  }
  if (!delivered) {
    // eslint-disable-next-line no-console
    console.warn(
      `[${label}] skipping — armWatcher's probe is never delivered on this host (Bun 1.3.11 drops hidden-file fs.watch events; node 22 on the same filesystem delivers them)`,
    )
  }
  return delivered
}
