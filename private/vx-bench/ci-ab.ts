#!/usr/bin/env bun
// TEMPORARY experiment (cold-margin thread, 2026-11-22), never merged: on one
// CI machine, interleaved cold runs of the site shape for vx arms that differ
// only by hack env vars, plus Vite Task. Prints wall, CPU and vx's per-thread
// CPU per run, so we learn whether vx's own main-thread CPU moves the wall on
// the slow runners.
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { vxCompileEntries } from './compile-entries.js'
import { deleteDist } from './outputs.js'
import { generate, gitInit, linkRivals, RUNNER_ENV, rivalRuns } from './site-workspace.js'
import { RUN_TASKS } from './shape.js'

const ROUNDS = Number(process.env.ROUNDS ?? 3)
const C = 10
const modules = path.join(import.meta.dir, 'node_modules')

function threads(pid: number): Map<string, number> {
  const out = new Map<string, number>()
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const s = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8')
      const close = s.lastIndexOf(')')
      const comm = s.slice(s.indexOf('(') + 1, close)
      const f = s.slice(close + 2).split(' ')
      out.set(`${tid}:${comm}`, (Number(f[11]) + Number(f[12])) * 10)
    }
  } catch {}
  return out
}

async function run(cmd: string[], cwd: string, env: Record<string, string>) {
  const t0 = Bun.nanoseconds()
  const p = Bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe', env: { ...RUNNER_ENV, ...env } })
  let last = new Map<string, number>()
  const poll = setInterval(() => {
    const t = threads(p.pid)
    if (t.size > 0) last = t
  }, 100)
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  clearInterval(poll)
  const ms = (Bun.nanoseconds() - t0) / 1e6
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}\n${(out + err).slice(-2000)}`)
  const u = p.resourceUsage()!
  const cpu = Number(u.cpuTime.user + u.cpuTime.system) / 1000
  const byName = new Map<string, number>()
  for (const [k, v] of last) {
    const n = k.slice(k.indexOf(':') + 1).replace(/\d+$/, '#')
    byName.set(n, (byName.get(n) ?? 0) + v)
  }
  return { ms, cpu, threads: Object.fromEntries([...byName].sort((a, b) => b[1] - a[1])) }
}

const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-ab-'))
console.log(`cpu: ${os.cpus()[0]?.model} x${os.cpus().length}`)
await generate(ws, C)
await linkRivals(ws)
const vxBin = path.join(ws, '.vx-runner')
const b = Bun.spawnSync([
  'bun', 'build', '--compile', '--minify', '--bytecode', '--format=esm', '--splitting',
  '--target=bun-linux-x64',
  ...vxCompileEntries(path.join(modules, '@vzn', 'vx', 'src', 'bin.ts')),
  '--outfile', vxBin,
], { cwd: ws })
if (b.exitCode !== 0) throw new Error(b.stderr.toString())
gitInit(ws)
const lock = Bun.spawnSync([vxBin, 'lock'], { cwd: ws, env: RUNNER_ENV })
if (lock.exitCode !== 0) throw new Error(lock.stderr.toString())

const vt = rivalRuns(ws, C)['vite-task']
const vxRun = [vxBin, 'run', ...RUN_TASKS, '--all', '--concurrency', String(C)]
const arms = [
  { label: 'base', cmd: vxRun, env: {}, clear: ['.vx/cache'] },
  { label: 'skipAll', cmd: vxRun, env: { VX_HACK_SKIP_CHECKS: 'all' }, clear: ['.vx/cache'] },
  { label: 'skipOwn', cmd: vxRun, env: { VX_HACK_SKIP_CHECKS: 'own' }, clear: ['.vx/cache'] },
  { label: 'skipUp', cmd: vxRun, env: { VX_HACK_SKIP_CHECKS: 'up' }, clear: ['.vx/cache'] },
  { label: 'stat40', cmd: vxRun, env: { VX_HACK_STATS: '40' }, clear: ['.vx/cache'] },
  { label: 'vt', cmd: vt.run, env: {}, clear: vt.clear.paths, clearCmd: vt.clear.command },
]
for (let r = 0; r < ROUNDS; r++) {
  for (let i = 0; i < arms.length; i++) {
    const a = arms[(i + r) % arms.length]!
    if (a.clearCmd) Bun.spawnSync(a.clearCmd, { cwd: ws, env: RUNNER_ENV })
    for (const c of a.clear) await rm(path.join(ws, c), { recursive: true, force: true })
    await deleteDist(ws)
    const res = await run(a.cmd, ws, a.env)
    console.log(JSON.stringify({ round: r, arm: a.label, ...res }))
  }
}
