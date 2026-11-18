#!/usr/bin/env bun
// A sim fixture from a real run: the graph `vx run --dry=json` printed for
// the run's tasks, and how each task that ran took from the run's
// `--profile` (its ms, cores as cpu over wall, peak RSS, and the platform
// of the worker it ran on). What tests/sim.test.ts plays.
//
//   bun packages/vx-dte/scripts/fixture.ts dry.json profile.json "main <sha>, <date>" > fixture.json

import { readFileSync } from 'node:fs'

interface DryTask {
  id: string
  cacheStatus: string
  deps: string[]
}
interface TraceEvent {
  ph: string
  name: string
  pid: number
  tid?: number
  ts?: number
  dur?: number
  args?: { name?: string; cpuMs?: number; peakRssBytes?: number; input?: string }
}

interface PlanInput {
  tasks: { id: string; ms?: number; cores: number; memory: number }[]
  warmUps?: Record<string, number>
  spreads?: Record<string, number>
}

/** `hosted.small#3` -> `small`: the size as `.vx/workspace.ts` names it. */
const sizeOf = (worker: string): string => worker.split('#')[0]!.split('.').at(-1)!

/**
 * A worker's platform by its size's name, as .vx/workspace.ts declares
 * them. A profile names a worker by its adapter group too (`hosted.mac#2`):
 * read whole, no Mac task got its platform, and the sims of three planner
 * changes ran the Mac's shards on Linux workers (2026-11-18).
 */
const PLATFORMS: Record<string, string> = {
  small: 'linux-x64',
  arm: 'linux-arm64',
  mac: 'darwin-arm64',
}

export function fixture(dry: { tasks: DryTask[] }, trace: TraceEvent[], note: string) {
  const machine = new Map<number, string>()
  for (const e of trace)
    if (e.ph === 'M' && e.name === 'process_name' && e.args?.name !== undefined)
      machine.set(e.pid, e.args.name)
  // A task's command inside it on its worker's lane: the task's span past
  // it is the check and save, its cores free. Played whole, the sim held
  // each task's cores 0.73 s past its command, where main d36eed9's
  // workers ran 4 commands at once on 4 cores (2026-11-18).
  const commands = new Map<string, TraceEvent[]>()
  for (const e of trace)
    if (e.ph === 'X' && e.name === 'command')
      (
        commands.get(`${e.pid}:${e.tid}`) ??
        commands.set(`${e.pid}:${e.tid}`, []).get(`${e.pid}:${e.tid}`)!
      ).push(e)
  const commandOf = (e: TraceEvent): TraceEvent | undefined =>
    commands
      .get(`${e.pid}:${e.tid}`)
      ?.find((c) => c.ts! >= e.ts! && c.ts! + c.dur! <= e.ts! + e.dur! + 1)
  const ran: Record<string, [number, number, number] | [number, number, number, number]> = {}
  const platform = new Map<string, string>()
  for (const e of trace) {
    if (e.ph !== 'X' || e.args?.cpuMs === undefined || !(e.dur! > 0)) continue
    const command = commandOf(e)
    // The run's own lane spans a task from its queueing: a worker's says how it ran.
    if (command === undefined && e.name in ran) continue
    const ms = Math.max(1, Math.round((command ?? e).dur! / 1000))
    const after = Math.round(e.dur! / 1000) - ms
    ran[e.name] = [
      ms,
      Math.round((e.args.cpuMs / ms) * 100) / 100,
      Math.round((e.args.peakRssBytes ?? 0) / 1e6),
      ...(command !== undefined && after > 0 ? [after] : []),
    ] as [number, number, number] | [number, number, number, number]
    const p = PLATFORMS[sizeOf(machine.get(e.pid) ?? '')]
    if (p !== undefined && p !== 'linux-x64') platform.set(e.name, p)
  }
  // What the run's first plan knew: history's time, cores and memory of
  // each task, and each size's warm-up and join spread an earlier run
  // learned. Played without the spreads, the sim asked 11 workers where
  // main d36eed9 asked 13, and ended its Linux lane 159-178 s for the
  // run's 147-153 (2026-11-18).
  const first = trace.find((e) => e.ph === 'i' && e.name === 'plan' && e.args?.input !== undefined)
  const input: PlanInput | undefined =
    first === undefined ? undefined : JSON.parse(first.args!.input!)
  const known: Record<string, [number, number, number] | null> = {}
  for (const t of input?.tasks ?? [])
    if (t.id in ran)
      known[t.id] = t.ms === undefined ? null : [t.ms, t.cores, Math.round(t.memory / 1e6)]
  const bySize = (r: Record<string, number> = {}) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [sizeOf(k), v]))
  // Each worker's warm-up, by size in the order they were numbered.
  const joins: Record<string, number[]> = {}
  for (const e of trace)
    if (e.ph === 'X' && e.name === 'warm-up') {
      const w = machine.get(e.pid) ?? ''
      ;(joins[sizeOf(w)] ??= [])[Number(w.split('#')[1]) - 1] = Math.round(e.dur! / 1000)
    }
  return {
    _: `${note}: the CI graph (cache: false for an uncached task), and the tasks that ran with how long each's command ran, its cores (cpu over wall), peak RSS in MB and the ms its worker took after the command; every other task hit. known: what the first plan's history said of each (ms, cores, MB; null: unmeasured); warmUps, spreads: what it had learned of each size; joins: each worker's warm-up (ms) by size`,
    nodes: dry.tasks.map((t) => ({
      id: t.id,
      deps: t.deps,
      exec: t.cacheStatus !== 'group',
      cache: t.cacheStatus !== 'no-cache',
      ...(platform.has(t.id) ? { platform: platform.get(t.id) } : {}),
    })),
    ran,
    ...(input === undefined
      ? {}
      : { known, warmUps: bySize(input.warmUps), spreads: bySize(input.spreads), joins }),
  }
}

if (import.meta.main) {
  const [dry, profile, note = 'a run'] = process.argv.slice(2)
  if (dry === undefined || profile === undefined) {
    console.error('usage: fixture.ts dry.json profile.json [note]')
    process.exit(2)
  }
  const p = JSON.parse(readFileSync(profile, 'utf8'))
  const trace: TraceEvent[] = Array.isArray(p) ? p : p.traceEvents
  console.log(JSON.stringify(fixture(JSON.parse(readFileSync(dry, 'utf8')), trace, note), null, 2))
}
