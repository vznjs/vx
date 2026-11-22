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
gitInit(ws)
function compile(bin: string, out: string): void {
  const b = Bun.spawnSync([
    'bun', 'build', '--compile', '--minify', '--bytecode', '--format=esm', '--splitting',
    '--target=bun-linux-x64', ...vxCompileEntries(bin), '--outfile', out,
  ], { cwd: ws })
  if (b.exitCode !== 0) throw new Error(b.stderr.toString())
}
// One workspace copy per vx: a run's memo is named by the code that wrote it.
async function vxArm(label: string, bin: string) {
  const dir = `${ws}-${label}`
  if (Bun.spawnSync(['cp', '-a', ws, dir]).exitCode !== 0) throw new Error('cp')
  const exe = path.join(dir, '.vx-runner')
  compile(bin, exe)
  const lock = Bun.spawnSync([exe, 'lock'], { cwd: dir, env: RUNNER_ENV })
  if (lock.exitCode !== 0) throw new Error(lock.stderr.toString())
  return {
    label, dir, env: {}, clear: ['.vx/cache'],
    cmd: [exe, 'run', ...RUN_TASKS, '--all', '--concurrency', String(C)],
  }
}
const vt = rivalRuns(ws, C)['vite-task']
const arms: { label: string; dir: string; cmd: string[]; env: Record<string, string>; clear: string[]; clearCmd?: string[] | undefined }[] = [
  await vxArm('base', path.join(process.env.BASE_DIR!, 'packages/vx/src/bin.ts')),
  await vxArm('new', path.join(modules, '@vzn', 'vx', 'src', 'bin.ts')),
  { label: 'vt', dir: ws, cmd: vt.run, env: {}, clear: vt.clear.paths, clearCmd: vt.clear.command },
]
const ms: Record<string, number[]> = {}
for (let r = 0; r < ROUNDS; r++) {
  for (let i = 0; i < arms.length; i++) {
    const a = arms[(i + r) % arms.length]!
    if (a.clearCmd) Bun.spawnSync(a.clearCmd, { cwd: a.dir, env: RUNNER_ENV })
    for (const c of a.clear) await rm(path.join(a.dir, c), { recursive: true, force: true })
    await deleteDist(a.dir)
    const res = await run(a.cmd, a.dir, a.env)
    ;(ms[a.label] ??= []).push(res.ms)
    console.log(JSON.stringify({ round: r, arm: a.label, ...res }))
  }
}
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!
console.log('SUMMARY ' + Object.entries(ms).map(([k, v]) => `${k}=${(med(v) / 1000).toFixed(2)}`).join(' '))
