// A minimal Distributed task execution, on vx's public contract alone: one
// run spread over `workers` processes it starts. Each worker runs what it
// is sent through `workerRuntime()`; core asks `distribution` where a task
// runs and what the workers did. A real one starts its workers on other
// machines and moves files through the cache; these share this checkout.
import path from 'node:path'
import {
  definePlugin,
  executorFallback,
  type ExecuteResult,
  type MachineReport,
  type TaskExecutor,
  type VxPlugin,
} from '@vzn/vx'
import type { Order } from './worker.ts'

interface Worker {
  readonly name: string
  readonly child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'inherit'>>
  readonly waiting: Map<number, (answer: { result?: ExecuteResult; error?: string }) => void>
  busy: boolean
  done: number
  failed: number
}

export function distribute(workers = 2): VxPlugin {
  let pool: Worker[] = []
  return definePlugin(import.meta, {
    executor(ctx) {
      pool = Array.from({ length: workers }, (_, i) => start(`w#${i + 1}`, ctx.workspaceRoot))
      const where = new Map<string, string>()
      let next = 0
      const executor: TaskExecutor = {
        name: 'distribute',
        // `capacity` is how many tasks core hands it at once: one per worker.
        capabilities: { remote: true, capacity: workers },
        async execute(req) {
          const w = pool.find((p) => !p.busy)!
          w.busy = true
          where.set(req.taskId, w.name)
          const id = next++
          const answer = new Promise<{ result?: ExecuteResult; error?: string }>((resolve) =>
            w.waiting.set(id, resolve),
          )
          const cancel = (): void => send(w, { id, cancel: true })
          req.signal?.addEventListener('abort', cancel, { once: true })
          // What a line can carry: the callbacks, the signal and the live
          // children stay here. No sandbox: it does not claim `sandbox`, so
          // core runs a sandboxed task on this machine.
          const {
            signal: _s,
            onStdout: _o,
            onStderr: _e,
            onSpawn: _p,
            liveChildren: _l,
            ...sent
          } = req
          const { capture: _c, sandbox: _b, workspaceRoot: _w, ...task } = sent
          send(w, { id, task: { ...task, projectDir: req.cwd, nested: [] } })
          const { result, error } = await answer.finally(() => {
            w.busy = false
            req.signal?.removeEventListener('abort', cancel)
          })
          // A worker that died never ran it: core runs it on this machine.
          if (result === undefined) throw executorFallback(`${w.name}: ${error ?? 'gone'}`)
          const { output, ...ran } = result as ExecuteResult & {
            output: { text: string; err: boolean }[]
          }
          for (const c of output) (c.err ? req.onStderr : req.onStdout)(c.text)
          if (result.exitCode === 0) w.done++
          else w.failed++
          return {
            ...ran,
            violations: result.violations.map((v) => ({ ...v, timestamp: new Date(v.timestamp) })),
            where: w.name,
          }
        },
        distribution: {
          running: (id) => where.get(id),
          footer: () => [['workers', pool.map((w) => `${w.name} ${w.done} done`).join(', ')]],
          machines: () =>
            pool.map((w): MachineReport => ({
              name: w.name,
              status: w.child.exitCode === null ? 'online' : 'gone',
              cores: 1,
              memoryBytes: 0,
              done: w.done,
              failed: w.failed,
              onlineMs: 0,
              busyMs: 0,
              cpuPeak: 0,
              cpuAvg: 0,
              memoryPeakBytes: 0,
              memoryAvgBytes: 0,
              utilization: 0,
            })),
        },
      }
      return executor
    },
    async teardown() {
      for (const w of pool) void w.child.stdin.end()
      await Promise.all(pool.map((w) => w.child.exited))
    },
  })
}

function send(w: Worker, order: Order): void {
  void w.child.stdin.write(`${JSON.stringify(order)}\n`)
  void w.child.stdin.flush()
}

function start(name: string, root: string): Worker {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'worker.ts'), root], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const w: Worker = { name, child, waiting: new Map(), busy: false, done: 0, failed: 0 }
  void (async () => {
    let buffered = ''
    for await (const chunk of child.stdout) {
      buffered += new TextDecoder().decode(chunk)
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const { id, ...answer } = JSON.parse(buffered.slice(0, at)) as {
          id: number
          result?: ExecuteResult
          error?: string
        }
        buffered = buffered.slice(at + 1)
        w.waiting.get(id)?.(answer)
        w.waiting.delete(id)
      }
    }
    // Gone: every task it held is given back.
    for (const resolve of w.waiting.values()) resolve({ error: 'the worker exited' })
    w.waiting.clear()
  })()
  return w
}
