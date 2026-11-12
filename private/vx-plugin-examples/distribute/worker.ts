// One worker of `distribute()`: a process that runs the tasks it is sent
// on stdin, one JSON line each, as the local floor would, and answers each
// with a JSON line on stdout. A real DTE's worker is a CI job on another
// machine; the contract it runs tasks through is the same.
import { workerRuntime, type WorkerTask } from '@vzn/vx'

export type Order = { id: number; task: WorkerTask } | { id: number; cancel: true }

const rt = workerRuntime({ root: process.argv[2]! })
const stops = new Map<number, AbortController>()

async function run(id: number, task: WorkerTask): Promise<void> {
  const stop = new AbortController()
  stops.set(id, stop)
  try {
    const prepared = await rt.prepare({ ...task, signal: stop.signal })
    const result = await prepared.run()
    await prepared.sweep()
    process.stdout.write(`${JSON.stringify({ id, result })}\n`)
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ id, error: String(err) })}\n`)
  } finally {
    stops.delete(id)
  }
}

let buffered = ''
for await (const chunk of Bun.stdin.stream()) {
  buffered += new TextDecoder().decode(chunk)
  for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
    const order = JSON.parse(buffered.slice(0, at)) as Order
    buffered = buffered.slice(at + 1)
    if ('cancel' in order) stops.get(order.id)?.abort('SIGTERM')
    else void run(order.id, order.task)
  }
}
await rt.close()
