// Probe (dropped before merge): one fixed test workload on a GitHub macOS
// runner, its wall time, the machine's busy cores and Spotlight's CPU.
import os from 'node:os'
import { readPs, topBetween } from '../../packages/vx-dte/src/cpu-account.ts'

const busy = (): [number, number] => {
  let b = 0
  let t = 0
  for (const { times: x } of os.cpus()) {
    b += x.user + x.nice + x.sys + x.irq
    t += x.user + x.nice + x.sys + x.irq + x.idle
  }
  return [b, t]
}
const files = (await Array.fromAsync(new Bun.Glob('tests/{archive,artifact,restore,scan-tar,tar,zstd}*.test.ts').scan({ cwd: 'packages/vx' }))).sort()
const ps0 = readPs()!, b0 = busy(), t0 = performance.now()
const r = Bun.spawnSync(['bun', 'test', '--only-failures', ...files], { cwd: 'packages/vx', stdout: 'ignore', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
const wall = performance.now() - t0, b1 = busy(), ps1 = readPs()!
const top = topBetween(ps0.table, ps1, process.pid, 8)
const spot = top.filter((p) => /^(md|mds|Spotlight)/.test(p.name)).reduce((n, p) => n + p.ms, 0)
console.log(JSON.stringify({
  arm: process.env.ARM, files: files.length, exit: r.exitCode, wallS: +(wall / 1000).toFixed(1),
  machineCores: +(((b1[0] - b0[0]) / (b1[1] - b0[1])) * os.cpus().length).toFixed(2),
  spotlightCores: +(spot / wall).toFixed(2),
  top: top.map((p) => `${p.name} ${(p.ms / wall).toFixed(2)}`),
}))
if (r.exitCode !== 0) console.log(r.stderr.toString().slice(-2000))
