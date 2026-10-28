// `vx dte worker`: one CI job's share of a run. It joins the run's relay
// with what its machine has, runs what the orchestrator sends in its own
// checkout, each at once: the orchestrator sends what fits the load each
// frame of this worker reports. A task's dependencies' files come from the workspace's
// cache by the keys its order names, and its own files and output go
// there under its key; the relay carries only orders and status.

import { readFileSync, realpathSync } from 'node:fs'
import { lstat, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  answerRuntime,
  BoundedCapture,
  hostPlatform,
  localFloor,
  machineMemoryBytes,
  ui,
  machineParallelism,
  sampleTrees,
  sandboxRequestFor,
  sweepPlaceholders,
  isUserError,
  UserError,
  type CacheFacts,
  type CapturedChunk,
  type ExecuteRequest,
  type LocalFloor,
  type TaskArtifacts,
  type TreeUsage,
} from '@vzn/vx'
import { childrenCpuMs, describeCpu, readPs, topBetween } from './cpu-account.js'
import {
  bytesOf,
  HELD_EVERY,
  HOST_ENV,
  PART_LISTS,
  type DepOrder,
  type Load,
  type WorkerInfo,
  type RunOrder,
  type ToOrchestrator,
  type ToWorker,
  type WiredResult,
} from './messages.js'
import { leftUnder, names, outputFiles } from './outputs.js'
import { snapshot } from './tree.js'
import { sealWorker, type Proof } from './seal.js'
import { join, RelayError, unsent as unsentBy } from './wire.js'

export async function runWorker(opts: {
  relay: string
  run: string
  /** `WorkerSpawn.id`, when the run started it. */
  id?: string
  root: string
  token: () => Promise<string | undefined>
  /** `dte({ headers })`, on every dial. */
  headers?: Readonly<Record<string, string>>
  /** What admits it to the orchestrator's session: the run's key, or its CI identity. */
  proof: Proof
  /** The workspace's cache read under the facts it is handed (`CommandContext.artifactsFor`). */
  artifacts: (facts: () => CacheFacts | undefined) => TaskArtifacts
}): Promise<number> {
  // The tracked files as they are, as the run snapshots its own: HEAD's
  // tree let in a checkout whose prepare rewrote a tracked file, and the
  // task built from it was saved under the clean key (2026-10-25).
  const base = await snapshot(opts.root)
  const tree = base.tree
  // Never an output, as core never cleans one: the checkout is the run's
  // commit, so this is the run's tracked set.
  const tracked = trackedFiles(opts.root)
  const cores = machineParallelism()
  const memory = machineMemoryBytes()
  const info: WorkerInfo = {
    v: 1,
    ...(opts.id === undefined ? {} : { id: opts.id }),
    cores,
    memory,
    platform: hostPlatform(),
    tree,
    booted: Math.round(performance.timeOrigin),
  }
  let me
  try {
    me = await sealWorker(
      (signed) => join(opts.relay, opts.run, 'worker', signed, opts.token, opts.headers),
      opts.run,
      opts.proof,
      { ...info },
    )
  } catch (err) {
    if (err instanceof RelayError && err.status === 410) {
      // The run ended before this worker came up: nothing is left for it,
      // and its CI job is no failure. One started by hand may have come
      // before its run, so it says so: an exit with no word left the run
      // waiting on nobody (2026-10-25).
      if (opts.id === undefined) {
        ui.print(
          'err',
          ui.status(
            'warn',
            'vx dte worker',
            `the relay has no live run ${opts.run}: it ended, or has not started (start the run first, then its workers)`,
          ),
        )
      }
      return 0
    }
    throw err
  }
  // Read as the run reads: its refs, and what its remotes lent.
  let facts: CacheFacts | undefined
  const artifacts = opts.artifacts(() => facts)
  const running = new Map<string, AbortController>()
  /** Each order's deps sent ahead of its batch, until the batch comes. */
  const ahead = new Map<string, DepOrder[]>()
  const work = new Set<Promise<void>>()
  let root = opts.root
  let realRoot = opts.root
  const myReal = realpathSync(opts.root)
  let floor: LocalFloor | undefined
  const load = loadMeter()
  const started = {
    at: performance.now(),
    self: process.cpuUsage(),
    children: childrenCpuMs(),
    ps: readPs(),
  }
  let tasksCpuMs = 0
  const trees = treeMeter()
  const frame = (): Load => ({ ...load.now(), tasks: trees.now() })
  /**
   * Entries whose files are here, restored or run here, by key: tasks
   * started together wait on one restore, never run before it.
   */
  const present = new Map<string, Promise<void>>()
  /** Of `present`, which files each holds: a task that clears one makes it absent. */
  const holds = new Map<string, (file: string) => boolean>()

  /** Saves the task's files (none when `bare`) and output under `key` and says so. */
  const reply = async (
    m: RunOrder,
    key: string,
    others: ReadonlySet<string> | undefined,
    res: WiredResult & { output: CapturedChunk[] },
    bare = false,
  ): Promise<void> => {
    const { output, ...result } = res
    // Forced: the key keeps an entry it holds, so the run's machines restore
    // the fresh bytes under the run key.
    const keys = !bare && m.fresh === true && key === m.key ? [key, m.runKey] : [key]
    try {
      for (const k of keys)
        await artifacts.save(
          k,
          {
            id: m.task,
            projectDir: path.join(opts.root, m.project),
            command: m.command,
            outputs: bare ? { files: [], workspaceFiles: [] } : m.outputs,
            nestedProjectDirs: m.nested.map((n) => path.join(opts.root, n)),
            ...(others === undefined || others.size === 0 ? {} : { others }),
          },
          {
            output,
            durationMs: res.durationMs,
            ...(res.cpuMs === undefined ? {} : { cpuMs: res.cpuMs }),
            ...(res.peakRssBytes === undefined ? {} : { peakRssBytes: res.peakRssBytes }),
            env: m.env,
            ...(m.secret === undefined ? {} : { secret: m.secret }),
            // The run's own key is this run's alone; `key` as the probe found it.
            ...(k === m.runKey || (k === m.key && m.absent === true) ? { absent: true } : {}),
          },
        )
    } catch (err) {
      // Its outputs refused (a link out of its project): the task fails, as
      // core fails it, not this worker. Taken as a fault, it failed every
      // worker it reached and the run with them (2026-10-24).
      if (bare || !isUserError(err)) throw err
      return reply(
        m,
        m.runKey,
        undefined,
        { ...res, exitCode: 1, output: [...output, { text: `${err.message}\n`, err: true }] },
        true,
      )
    }
    // No remote took it: the orchestrator reads the remotes alone, so its
    // dependants come here and its output goes with the `end` (2026-10-25).
    const saved = keys.at(-1)!
    const wired: WiredResult =
      (await artifacts.uploaded?.(saved)) === false
        ? { ...result, unshared: true, output: pieces(output) }
        : result
    if (result.exitCode === 0)
      for (const k of keys) {
        present.set(k, Promise.resolve())
        holds.set(k, names(m.project, m.outputs))
      }
    const end: ToOrchestrator = {
      type: 'end',
      task: m.task,
      key: saved,
      result: wired,
      load: frame(),
    }
    for (const part of parts(end)) await me.send('orchestrator', part)
  }

  // A message the relay would not take is said, each kind once (2026-10-23):
  // a lost `ran` or `held` left the run waiting on this worker for nothing.
  const said = new Set<string>()
  const unsent = (what: string): ((err: unknown) => void) =>
    unsentBy(
      (m) => {
        if (said.has(what)) return
        said.add(what)
        ui.print('err', ui.status('warn', 'vx dte worker', m))
      },
      what,
      'the orchestrator',
    )
  /** Runs a task the orchestrator sent: it fits what this worker has free. */
  const start = (m: RunOrder): void => {
    let ran = false
    const done = (): void => {
      if (ran) return
      ran = true
      void me
        .send('orchestrator', { type: 'ran', task: m.task, load: frame() })
        .catch(unsent('ran'))
    }
    const p = runTask(m, done)
      .catch(async (err: unknown) => {
        // The task's own error (a sandbox this machine cannot host, an
        // `exec.sandbox` it refuses) fails it, as core fails it. Taken as a
        // fault, each worker it reached left the run, and unsandboxed tasks
        // failed with no worker left (docker(), 2026-10-25).
        if (isUserError(err)) {
          ui.print('err', ui.status('error', m.task, err.message))
          const res = { exitCode: 1, durationMs: 0, violations: [] }
          const output = [{ text: `${err.message}\n`, err: true }]
          const told = await reply(m, m.runKey, undefined, { ...res, output }, true).then(
            () => true,
            (e: unknown) => ((err = e), false),
          )
          if (told) return
        }
        const reason = err instanceof Error ? err.message : String(err)
        ui.print('err', ui.status('error', m.task, `could not run: ${reason}`))
        await me
          .send('orchestrator', { type: 'fault', task: m.task, reason })
          .catch(unsent('fault'))
      })
      .finally(() => work.delete(p))
    work.add(p)
  }

  // Each probe once per worker, as a run answers it once.
  const probes = new Map<string, Promise<string>>()
  /** The first probe this machine answers otherwise than the orchestrator did. */
  const runtimeDiffers = async (m: RunOrder): Promise<string | undefined> => {
    for (const r of m.runtime ?? []) {
      const dir = r.workspace === true ? '' : m.project
      const k = `${dir}\0${r.command}`
      let p = probes.get(k)
      if (p === undefined) {
        p = answerRuntime(r.command, path.join(opts.root, dir), opts.root, r.workspace === true)
        probes.set(k, p)
      }
      // Its checkout root read as the run's: a path under it names the same
      // file there, as the task's env does. Compared raw, a probe of a
      // workspace tool's path failed every task on a worker checked out
      // elsewhere (2026-10-25).
      const mine = swapRoots(await p, [[opts.root, root]])
      if (mine !== r.output)
        return `\`${r.command}\` answers ${JSON.stringify(mine)} on this worker, ${JSON.stringify(r.output)} on the run's machine, whose answer its key holds`
    }
    return undefined
  }

  const runTask = async (m: RunOrder, free: () => void): Promise<void> => {
    const stop = new AbortController()
    running.set(m.task, stop)
    // Not awaited: the task does not wait on the relay to say it began.
    void me
      .send('orchestrator', { type: 'start', task: m.task, load: frame() })
      .catch(unsent('start'))
    try {
      const differs = await runtimeDiffers(m)
      if (differs !== undefined) {
        ui.print('err', ui.status('error', m.task, differs))
        await reply(m, m.runKey, undefined, {
          exitCode: 1,
          durationMs: 0,
          output: [{ text: `${differs}\n`, err: true }],
          violations: [],
        })
        return
      }
      for (const d of m.deps) {
        let got = present.get(d.key)
        if (got === undefined) {
          got = artifacts
            .restore(d.key, {
              id: d.task,
              projectDir: path.join(opts.root, d.project),
              command: '',
              outputs: d.outputs,
            })
            .then((log) => {
              if (log === null)
                throw new UserError(`${d.task}'s entry ${d.key} is in no cache this worker reads`)
            })
          present.set(d.key, got)
          holds.set(d.key, names(d.project, d.outputs))
          // quiet: awaited below, where its error is the task's fault
          got.catch(() => present.delete(d.key))
        }
        try {
          await got
        } catch (err) {
          // No worker reads it either: the task fails, naming it. Taken as a
          // fault, each worker it reached was dropped and the run waited on
          // a worker that never came (2026-10-24).
          if (!isUserError(err)) throw err
          ui.print('err', ui.status('error', m.task, err.message))
          const res = { exitCode: 1, durationMs: 0, violations: [], unread: [d.key] }
          await reply(
            m,
            m.runKey,
            undefined,
            { ...res, output: [{ text: `${err.message}\n`, err: true }] },
            true,
          )
          return
        }
      }
      // An earlier task's files under these outputs would ship as this one's.
      // A tracked file or a nested project's is none of them: cleared, a
      // committed file under `gen/**` was gone for the task's dependants
      // (2026-10-24). Nor is a dependency's: an additive task (outputs over
      // its upstream's tree) found the files it builds on gone.
      const upstream = m.deps.map((d) => names(d.project, d.outputs))
      const under = await outputFiles(opts.root, m.project, m.outputs)
      const { cleared, held: upstreams } = leftUnder(under, tracked, m.nested, upstream)
      // An upstream's file it leaves as it found it is not its entry's: one
      // saved there replayed the upstream's old bytes over its new ones on
      // a hit that did not fold the upstream's key (2026-10-24).
      const found = await stamps(upstreams.map((f) => path.join(opts.root, f)))
      for (const [key, held] of holds)
        if (cleared.some(held)) {
          present.delete(key)
          holds.delete(key)
        }
      for (const f of cleared) await rm(path.join(opts.root, f), { force: true })
      // Built here: the walls, real paths and grants are this machine's.
      const sb =
        m.sandbox === undefined
          ? undefined
          : await sandboxRequestFor(
              { projectDir: path.join(opts.root, m.project) },
              m.sandbox.config,
              opts.root,
              m.sandbox.keyed === undefined
                ? undefined
                : new Set(m.sandbox.keyed.map((k) => path.join(opts.root, k))),
              m.nested.map((n) => path.join(opts.root, n)),
            )
      const output = new BoundedCapture()
      const req: ExecuteRequest = {
        taskId: m.task,
        workspaceRoot: opts.root,
        command: m.command,
        forwardArgs: [],
        cwd: path.join(opts.root, m.cwd),
        env: localEnv(m.env, root, opts.root),
        envDefine: {},
        // Both streams as one capture, in the order written, as core keeps a
        // run's: kept apart, a hit replayed every stdout line before the
        // stderr between them (2026-10-25).
        capture: { stdout: false, stderr: false },
        onStdout: (t) => output.push(t),
        onStderr: (t) => output.push(t, true),
        signal: stop.signal,
        onSpawn: (pid) => trees.watch(m.task, pid),
        outputs: m.outputs,
        ...(m.timeoutMs === undefined ? {} : { timeoutMs: m.timeoutMs }),
        ...(sb === undefined ? {} : { sandbox: sb.sandbox }),
        ...(m.servers === undefined
          ? {}
          : {
              servers: m.servers.map((s) => ({
                taskId: s.task,
                command: s.command,
                cwd: path.join(opts.root, s.cwd),
                env: localEnv(s.env, root, opts.root),
                ...(s.readyWhen === undefined ? {} : { readyWhen: s.readyWhen }),
                ...(s.timeoutMs === undefined ? {} : { timeoutMs: s.timeoutMs }),
                ...(s.sandbox === undefined
                  ? {}
                  : {
                      sandbox: {
                        config: s.sandbox.config,
                        nested: s.sandbox.nested.map((n) => path.join(opts.root, n)),
                      },
                    }),
              })),
            }),
      }
      floor ??= localFloor()
      ui.print('out', ui.status('info', m.task, ui.dim('running')))
      const crowd = load.mark()
      const {
        outputs: _,
        stdout: _o,
        stderr: _e,
        ...res
      } = await floor.execute(req).finally(() => trees.drop(m.task))
      tasksCpuMs += res.cpuMs ?? 0
      const cpuShare = load.shareSince(
        crowd,
        res.cpuMs === undefined || !(res.durationMs > 0) ? undefined : res.cpuMs / res.durationMs,
      )
      // Its command is done: saving its outputs to the cache is the
      // network's time, and its cores are the next task's (main,
      // 2026-10-23: workers booked 3.7 cores and used 2.4).
      free()
      const took = ui.dim(`${Math.round(res.durationMs)}ms`)
      ui.print(
        'out',
        res.exitCode === 0
          ? ui.status('ok', m.task, took)
          : ui.status('error', m.task, [`exit ${res.exitCode} `, took]),
      )
      // A bind the task never wrote is not its output. By size alone, an
      // empty stamp the task wrote was taken too and saved as no file
      // (2026-10-24).
      if (sb !== undefined) await sweepPlaceholders(sb.placeholders)
      // Its violations name the orchestrator's paths. As JSON first: the swap
      // round-trips them through JSON, which leaves a Date a string.
      const back = swapRoots(
        res.violations.map((v) => ({ ...v, timestamp: v.timestamp.toISOString() })),
        [
          [myReal, realRoot],
          [opts.root, root],
        ],
      )
      // Only a success the sandbox found nothing wrong with is the task's
      // entry; anything else is kept where no lookup finds it. A 0 past the
      // timeout (a trapped SIGTERM) failed, and saved under the key the
      // next run hit it green (2026-10-24). A process it left running may
      // still write its outputs: core saves no entry, nor does this. Nor for
      // one the run cancelled: a trapped SIGTERM's 0 was a stopped run's
      // half-done task, and the next run hit it (2026-10-24).
      // A tracked file it changed under its project (a formatter's input)
      // is one the orchestrator's disk never shows: its key read the file
      // as checked out, and the entry built from the rewrite was the next
      // run's hit (2026-10-24). Core withholds its own save if the key read
      // it; this entry is withheld for any. Nor for an additive task that
      // removed an upstream's file: a hit left the file in place, and core
      // saves none once this machine removes it too (2026-10-24).
      const changed = await changedTracked(opts.root, base.commit, m, names(m.project, m.outputs))
      const now = await stamps([...found.keys()])
      const others = unchanged(found, now)
      const removed = [...found.keys()]
        .filter((f) => !now.has(f))
        .map((f) => path.relative(opts.root, f))
      const key =
        res.exitCode === 0 &&
        res.timedOut !== true &&
        res.leftRunning !== true &&
        !stop.signal.aborted &&
        res.violations.length === 0 &&
        changed.length === 0 &&
        removed.length === 0 &&
        m.key !== undefined
          ? m.key
          : m.runKey
      await reply(m, key, others, {
        ...res,
        output: output.chunks(),
        violations: back,
        ...(cpuShare === undefined ? {} : { cpuShare }),
        ...(changed.length === 0 ? {} : { changed }),
        ...(removed.length === 0 ? {} : { removed }),
      })
    } finally {
      running.delete(m.task)
    }
  }

  // What it holds, every `HELD_EVERY` heartbeats: the orchestrator's lease on each task.
  const held = setInterval(() => {
    if (running.size === 0) return
    void me
      .send('orchestrator', { type: 'held', running: [...running.keys()], load: frame() })
      .catch(unsent('held'))
  }, HELD_EVERY * me.heartbeatMs)
  try {
    for (;;) {
      let messages
      try {
        messages = await me.poll()
      } catch (err) {
        if (err instanceof RelayError && err.status === 410) return 0
        // The relay lost it (silent too long, or restarted): the run gave its
        // tasks to others, so this job has nothing left and is no failure.
        if (err instanceof RelayError && err.status === 404) {
          ui.print(
            'err',
            ui.status('warn', 'vx dte worker', 'the relay no longer knows this worker'),
          )
          return 0
        }
        throw err
      }
      for (const { from, body } of messages) {
        if (from === 'relay') {
          if ((body as { type?: string }).type === 'closed') return 0
          continue
        }
        const m = body as ToWorker
        if (m.type === 'refused') {
          ui.print('err', ui.status('error', 'vx dte worker', `refused: ${m.reason}`))
          return 1
        }
        if (m.type === 'exit') return 0
        if (m.type === 'cache') facts = m.cache
        else if (m.type === 'welcome') {
          facts = m.cache
          ui.print(
            'out',
            ui.report('vx dte worker', [
              ['worker', ui.id(m.name)],
              ['run', opts.run],
              ['relay', opts.relay],
              ['machine', `${cores} cores · ${gb(memory)}`],
            ]),
          )
        } else if (m.type === 'deps') {
          ahead.set(m.task, [...(ahead.get(m.task) ?? []), ...m.deps])
        } else if (m.type === 'cancel') {
          running.get(m.task)?.abort()
        } else if (m.type === 'batch') {
          // Every batch of a run names the same orchestrator root.
          root = m.root
          realRoot = m.realRoot
          if (m.sandboxes !== undefined) {
            if (floor === undefined) floor = localFloor(m.sandboxes)
            else await floor.rearm(m.sandboxes)
          }
          for (const t of m.tasks) {
            // One it runs already, sent again (its lease ended while the
            // relay was away): it is not run twice.
            if (running.has(t.task)) continue
            const deps = ahead.get(t.task)
            ahead.delete(t.task)
            start(deps === undefined ? t : { ...t, deps: [...deps, ...t.deps] })
          }
        }
      }
    }
  } catch (err) {
    // The run closed under a poll or an answer: nothing is left for this worker.
    if (err instanceof RelayError && err.status === 410) return 0
    throw err
  } finally {
    clearInterval(held)
    trees.stop()
    for (const c of running.values()) c.abort()
    await Promise.all(work)
    const onlineMs = performance.now() - started.at
    const self = process.cpuUsage(started.self)
    const children = childrenCpuMs()
    const ps = readPs()
    ui.print(
      'out',
      ui.status(
        'info',
        'vx dte worker',
        describeCpu({
          onlineMs,
          machineMs: (load.now().avg ?? 0) * onlineMs,
          tasksMs: tasksCpuMs,
          selfMs: (self.user + self.system) / 1000,
          ...(children === undefined || started.children === undefined
            ? {}
            : { childrenMs: Math.max(0, children - started.children - tasksCpuMs) }),
          top:
            started.ps === undefined || ps === undefined
              ? []
              : topBetween(started.ps.table, ps, process.pid),
        }),
      ),
    )
    load.stop()
    await floor?.close()
    await me.leave()
  }
}

/** The looks a task's share is read over, and the CPUs' busy and total time then. */
interface Mark {
  sum: number
  n: number
  times: [number, number]
}

/** How often the run queue is read: a test shard's spawns come and go within a second. */
const CROWD_EVERY_MS = 200
/** The share of the CPUs' time busy at which a Mac may be crowded. */
const FULL = 0.9

function cpuTimes(): [number, number] {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return [total - idle, total]
}

/**
 * The share of a core each runnable thread gets now: the machine's cores
 * over the threads Linux has runnable (`procs_running`, less the one
 * reading it), at most 1. Undefined where there is no /proc/stat.
 */
export function crowdShare(stat: string, cores: number): number | undefined {
  const m = /^procs_running (\d+)$/m.exec(stat)
  if (m === null) return undefined
  return Math.min(1, cores / Math.max(1, Number(m[1]) - 1))
}

/**
 * This machine's load, sampled each second: the cores busy over the last
 * one, from the CPUs' times, and the memory in use. Also how crowded its
 * CPU is, read every `CROWD_EVERY_MS`: a task on a crowded machine uses
 * only its share, and the run learns its need from what it used. With no
 * /proc/stat (macOS), the load average says it: six test shards on a
 * 3-core Mac reported no share, so the run learned their crowded use as
 * their need and packed them as tight again: 66-78 s each (main 1e19c00,
 * 2026-10-23). Lagging a minute, it fits the long tasks a
 * crowd stretches. A load average of 0 (Windows) is none. It counts
 * more than the threads that wait for a core: a GitHub macOS runner
 * read 49 with two test shards on 3 cores and a core idle, and the run
 * learned each shard needed the whole machine (main 8fa3c98). So a
 * Mac whose cores were not all busy since the last look is not crowded.
 */
export function loadMeter(
  read: () => string | undefined = procStat,
  average: () => number = () => os.loadavg()[0] ?? 0,
  /** The CPUs' busy and total time so far (`os.cpus()`). */
  times: () => [number, number] = cpuTimes,
): {
  now: () => Load
  mark: () => Mark
  shareSince: (from: Mark, used?: number) => number | undefined
  stop: () => void
} {
  let last = times()
  const first = last
  let cpu = 0
  const timer = setInterval(() => {
    const next = times()
    const total = next[1] - last[1]
    if (total > 0) cpu = ((next[0] - last[0]) / total) * os.cpus().length
    last = next
  }, 1_000)
  timer.unref?.()
  const cores = os.cpus().length
  const crowd = { sum: 0, n: 0 }
  let looked = last
  const look = (): void => {
    const stat = read()
    const avg = stat === undefined ? average() : 0
    let full = true
    if (stat === undefined && avg > 0) {
      const now = times()
      full = now[1] <= looked[1] || (now[0] - looked[0]) / (now[1] - looked[1]) >= FULL
      looked = now
    }
    const share =
      stat !== undefined
        ? crowdShare(stat, cores)
        : avg > 0
          ? full
            ? Math.min(1, cores / avg)
            : 1
          : undefined
    if (share === undefined) return clearInterval(crowded)
    crowd.sum += share
    crowd.n++
  }
  const crowded = setInterval(look, CROWD_EVERY_MS)
  crowded.unref?.()
  return {
    now: () => {
      const t = times()
      const total = t[1] - first[1]
      return {
        cpu: Math.round(cpu * 100) / 100,
        memory: os.totalmem() - available(),
        ...(total > 0 ? { avg: Math.round(((t[0] - first[0]) / total) * cores * 100) / 100 } : {}),
      }
    },
    mark: () => ({ ...crowd, times: times() }),
    // Its mean share over the looks since `from`; none (a task shorter
    // than a look, or no /proc) is no correction. A task that used `used`
    // cores beside cores left free wanted at most both: six test shards
    // on a 3-core Mac used 2.3 cores, read a share of 0.22 from its load
    // average, and the next run booked each 2.2 cores (main 3917881).
    shareSince: (from, used) => {
      if (crowd.n <= from.n) return undefined
      let share = (crowd.sum - from.sum) / (crowd.n - from.n)
      const now = times()
      const total = now[1] - from.times[1]
      if (used !== undefined && used > 0 && total > 0) {
        const free = Math.max(0, 1 - (now[0] - from.times[0]) / total) * cores
        share = Math.max(share, Math.min(1, used / (used + free)))
      }
      return Math.round(share * 1000) / 1000
    },
    stop: () => {
      clearInterval(timer)
      clearInterval(crowded)
    },
  }
}

/** How often each running task's process tree is read: core's own `task.sample` cadence. */
const TREE_EVERY_MS = 1_000

/**
 * The cores each running task's whole process tree uses, read every
 * second, summed: beside the machine's busy cores, the rest is no task's
 * (the worker's own restores and saves, the OS). A Mac whose tasks'
 * exits said 1.8 cores ran them at half their share (main fd9afe0,
 * 2026-10-24), and nothing said where the rest went.
 */
export function treeMeter(
  sample: (roots: readonly number[]) => Promise<ReadonlyMap<number, TreeUsage>> = sampleTrees,
  every = TREE_EVERY_MS,
): {
  watch: (task: string, pid: number) => void
  drop: (task: string) => void
  now: () => number
  stop: () => void
} {
  const watched = new Map<string, { pid: number; at: number; cpuMs: number; cores: number }>()
  let timer: ReturnType<typeof setInterval> | undefined
  let looking = false
  const look = async (): Promise<void> => {
    if (looking) return
    looking = true
    try {
      const entries = [...watched]
      const usage = await sample(entries.map(([, w]) => w.pid))
      const at = performance.now()
      for (const [task, w] of entries) {
        const u = usage.get(w.pid)
        if (u === undefined || watched.get(task) !== w) continue
        // A child that exited takes its CPU out of the live sum.
        if (at > w.at) w.cores = Math.max(0, (u.cpuMs - w.cpuMs) / (at - w.at))
        w.at = at
        w.cpuMs = u.cpuMs
      }
    } catch {
      // quiet: a failed look is a missing point; the last one stands
    } finally {
      looking = false
    }
  }
  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  return {
    watch: (task, pid) => {
      watched.set(task, { pid, at: performance.now(), cpuMs: 0, cores: 0 })
      if (timer === undefined) {
        timer = setInterval(() => void look(), every)
        timer.unref?.()
      }
    },
    drop: (task) => {
      watched.delete(task)
      if (watched.size === 0) stop()
    },
    now: () => {
      let cores = 0
      for (const w of watched.values()) cores += w.cores
      return Math.round(cores * 100) / 100
    },
    stop,
  }
}

function procStat(): string | undefined {
  try {
    return readFileSync('/proc/stat', 'utf8')
  } catch {
    // quiet: not Linux: no run queue to read, so no correction
    return undefined
  }
}

/**
 * The tracked files under `m`'s project that differ from the checkout,
 * workspace-relative: its outputs and nested projects' files are not its
 * project's inputs.
 */
type Stamp = { size: number; mtimeMs: number; ino: number; ctimeMs: number }

/** Each file's stat, by absolute path. */
async function stamps(files: readonly string[]): Promise<Map<string, Stamp>> {
  const out = new Map<string, Stamp>()
  for (const f of files) {
    // quiet: a file gone is one with no stamp
    const st = await lstat(f).catch(() => undefined)
    if (st !== undefined)
      out.set(f, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ctimeMs: st.ctimeMs })
  }
  return out
}

/** Of `found`, the files still as they were. */
function unchanged(
  found: ReadonlyMap<string, Stamp>,
  now: ReadonlyMap<string, Stamp>,
): Set<string> {
  const out = new Set<string>()
  for (const [f, was] of found) {
    const is = now.get(f)
    if (
      is !== undefined &&
      is.size === was.size &&
      is.mtimeMs === was.mtimeMs &&
      is.ino === was.ino &&
      is.ctimeMs === was.ctimeMs
    )
      out.add(f)
  }
  return out
}

/** Tracked files under the task's project it changed, workspace-relative, its outputs and nested projects' aside. */
export async function changedTracked(
  root: string,
  base: string,
  m: RunOrder,
  output: (file: string) => boolean,
): Promise<string[]> {
  const p = Bun.spawn(
    [
      'git',
      'diff',
      '--name-only',
      '-z',
      // Paths as the run names them: repo-relative, a workspace in a
      // subdirectory matched no keyed file, and core saved the rewrite
      // under its key (2026-10-25).
      '--relative',
      '--no-renames',
      base,
      '--',
      // Literal: a project at `p*` named its sibling `pa`'s files.
      m.project === '' ? '.' : `:(literal)${m.project}`,
    ],
    {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    },
  )
  const out = await new Response(p.stdout).text()
  await p.exited
  return out
    .split('\0')
    .filter((f) => f !== '' && !output(f) && !m.nested.some((n) => f.startsWith(`${n}/`)))
}

/** The checkout's tracked files, relative to `root`; none outside git. */
export function trackedFiles(root: string): Set<string> {
  const r = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root, stderr: 'pipe' })
  if (r.exitCode === 0) return new Set(r.stdout.toString().split('\0').filter(Boolean))
  const repo = Bun.spawnSync(['git', 'rev-parse', '--git-dir'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  if (repo.exitCode !== 0) return new Set()
  // A repository git cannot list (a corrupt index): read as none tracked,
  // clearing a task's outputs deleted its committed files.
  throw new Error(`git ls-files: ${r.stderr.toString().trim()}`)
}

/** Memory a task can take: Linux's MemAvailable counts the page cache it may reclaim, free memory does not. */
function available(): number {
  try {
    const m = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))
    if (m !== null) return Number(m[1]) * 1024
    // quiet: no /proc: the machine's total memory stands
  } catch {
    // Not Linux.
  }
  return os.freemem()
}

/**
 * The orchestrator's env for a task, made this machine's: its checkout root
 * swapped for ours, host names from our own env, and PATH our own behind
 * the workspace's bin directories.
 */
export function localEnv(
  env: Readonly<Record<string, string>>,
  remoteRoot: string,
  root: string,
): Record<string, string | undefined> {
  // By path: a plain replace moved `/ws2` and `/private/ws` with `/ws`.
  const out: Record<string, string | undefined> = swapRoots({ ...env }, [[remoteRoot, root]])
  // Sent only when the task's `env.define` names it: its value, as keyed.
  for (const k of HOST_ENV) if (!(k in out)) out[k] = process.env[k]
  const bins = (out['PATH'] ?? '').split(':').filter((p) => p === root || p.startsWith(`${root}/`))
  out['PATH'] = [...bins, process.env['PATH'] ?? ''].join(':')
  return out
}

/**
 * `value` with each path under a `from` root moved under its `to`, in one
 * pass: a root that holds another (`/ws`, `/ws2`) is not swapped twice. A
 * root ends at `/`, `:` (a PATH list) or the string's end.
 */
export function swapRoots<T>(value: T, pairs: readonly (readonly [string, string])[]): T {
  // The first pair naming a root wins.
  const to = new Map([...pairs].reverse().map(([f, t]) => [esc(f), esc(t)]))
  const alt = [...to.keys()]
    .sort((a, b) => b.length - a.length)
    .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const text = JSON.stringify(value).replace(
    new RegExp(`(?<=^|[^\\w.-])(${alt})(?=[/":]|\\\\|$)`, 'g'),
    (m) => to.get(m)!,
  )
  return JSON.parse(text) as T
}

/** A path as JSON spells it inside a string. */
const esc = (p: string): string => JSON.stringify(p).slice(1, -1)

/** Makes each bind that is missing here: the empty files it made, to take back. */
const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`

/** The most of a result one send carries: a relay frame is 1 MiB, which sealing grows by a third. */
const PART_BYTES = 256 * 1024

/** `output` cut so each chunk fits a part, escaped as JSON grows it up to six times. */
function pieces(output: readonly CapturedChunk[]): CapturedChunk[] {
  const most = PART_BYTES / 8
  return output.flatMap((c) => {
    if (c.text.length <= most) return [c]
    const cut: CapturedChunk[] = []
    for (let i = 0; i < c.text.length;) {
      let end = Math.min(i + most, c.text.length)
      // Not inside a surrogate pair: each half replayed alone printed as
      // two replacement characters (2026-10-25).
      const last = c.text.charCodeAt(end - 1)
      if (end < c.text.length && last >= 0xd800 && last <= 0xdbff) end--
      cut.push({ ...c, text: c.text.slice(i, end) })
      i = end
    }
    return cut
  })
}

/**
 * `end` as its sends: itself when it fits one frame, else its long lists
 * first, in parts that each fit, and then the rest of it.
 */
function parts(end: Extract<ToOrchestrator, { type: 'end' }>): ToOrchestrator[] {
  if (bytesOf(end) <= PART_BYTES) return [end]
  const out: ToOrchestrator[] = []
  const result: Record<string, unknown> = { ...end.result }
  for (const list of PART_LISTS) {
    const items = end.result[list] as readonly unknown[] | undefined
    if (items === undefined) continue
    delete result[list]
    let piece: unknown[] = []
    let bytes = 0
    for (const item of items) {
      const size = bytesOf(item) + 1
      if (piece.length > 0 && bytes + size > PART_BYTES) {
        out.push({ type: 'part', task: end.task, [list]: piece })
        piece = []
        bytes = 0
      }
      piece.push(item)
      bytes += size
    }
    if (piece.length > 0) out.push({ type: 'part', task: end.task, [list]: piece })
  }
  out.push({ ...end, result: result as WiredResult })
  return out
}
