// The nightly real-repo bench (owner, 2026-10-12): every repo on
// /compare/real-repos/, re-run against the tool it ships with on this
// checkout's vx. Each case's best rep is compared; a case vx loses is a
// LOSS line and the run exits 1, so the routine that runs it files the
// loss with Engineering.
//
//   bun packages/vx-bench/real/nightly.ts [--reps N] [--out report.md] [--only name]
//
// Needs network (git clone, pnpm install) and node + pnpm on PATH. Repos
// are kept under VX_NIGHTLY_DIR (default ~/.vx-nightly), reset to their
// pinned commit and re-moved to vx (`vx init --native`) each night.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { benchEnv } from '../bench-env.js'

interface Repo {
  name: string
  url: string
  commit: string
  tool: 'turbo' | 'nx'
  tasks: string
  /** FILTERS for the harness: both tools run the same projects. */
  filters?: string
  workers: number
}

// The repos and scopes /compare/real-repos/ publishes (benchmarks.md § Real repos).
const REPOS: Repo[] = [
  {
    name: 'create-t3-turbo',
    url: 'https://github.com/t3-oss/create-t3-turbo',
    commit: '8f945b7',
    tool: 'turbo',
    tasks: 'build',
    filters: './packages/*',
    workers: 10,
  },
  {
    name: 'react-email',
    url: 'https://github.com/resend/react-email',
    commit: '1531a39',
    tool: 'turbo',
    tasks: 'build',
    filters: './packages/*',
    workers: 10,
  },
  {
    name: 'tanstack-query',
    url: 'https://github.com/TanStack/query',
    commit: '817bd02',
    tool: 'nx',
    tasks: 'build',
    filters: '!./examples/** !./integrations/**',
    workers: 5,
  },
]

const ARMS = ['cold', 'restore', 'noop'] as const

const { values } = parseArgs({
  options: {
    reps: { type: 'string', default: '3' },
    out: { type: 'string' },
    only: { type: 'string' },
  },
})
const REPO_ROOT = path.resolve(import.meta.dir, '../../..')
const WORK = process.env['VX_NIGHTLY_DIR'] ?? path.join(os.homedir(), '.vx-nightly')
mkdirSync(WORK, { recursive: true })

function sh(cmd: string[], cwd: string, env = benchEnv()): { ok: boolean; out: string } {
  const r = Bun.spawnSync(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() }
}

function must(cmd: string[], cwd: string, env?: Record<string, string | undefined>): string {
  const r = sh(cmd, cwd, env)
  if (!r.ok) throw new Error(`${cmd.join(' ')} (in ${cwd}) failed:\n${r.out.slice(-2000)}`)
  return r.out
}

// pnpm 12 fetches a repo's pinned pnpm (`packageManager`) into its tools
// dir with build scripts off, so the native binary's install.js never runs
// and the placeholder left as `pnpm` fails with ENOEXEC when a script calls
// pnpm (TanStack/query's `build`, 2026-10-12). Run the script ourselves.
function repairManagedPnpm(dir: string): void {
  const pm = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).packageManager
  const version = /^pnpm@([^+]+)/.exec(pm ?? '')?.[1]
  if (version === undefined) return
  const home = process.env['PNPM_HOME'] ?? path.join(os.homedir(), '.local/share/pnpm')
  const pkg = path.join(home, '.tools/pnpm', version, 'node_modules/pnpm')
  if (existsSync(path.join(pkg, 'install.js'))) must(['node', 'install.js'], pkg)
}

const vxBin = path.join(WORK, 'vx')
must(
  [
    'bun',
    'build',
    '--compile',
    '--minify',
    '--bytecode',
    'packages/vx/src/bin.ts',
    '--outfile',
    vxBin,
  ],
  REPO_ROOT,
)
const vxCommit = must(['git', 'rev-parse', '--short', 'HEAD'], REPO_ROOT).trim()

interface Row {
  repo: string
  tool: string
  arm: (typeof ARMS)[number]
  vx: number
  rival: number
}
const rows: Row[] = []
const failures: string[] = []

for (const repo of REPOS) {
  if (values.only !== undefined && values.only !== repo.name) continue
  const dir = path.join(WORK, repo.name)
  try {
    if (!existsSync(dir)) must(['git', 'clone', '--filter=blob:none', repo.url, dir], WORK)
    // A short commit cannot be fetched by name: fetch everything when the
    // clone does not hold it yet.
    if (!sh(['git', 'cat-file', '-e', `${repo.commit}^{commit}`], dir).ok) {
      must(['git', 'fetch', '-q', 'origin'], dir)
    }
    must(['git', 'checkout', '-qf', repo.commit], dir)
    must(['git', 'clean', '-fdxq', '-e', 'node_modules', '-e', '**/node_modules'], dir)
    must(['pnpm', 'install', '--frozen-lockfile'], dir)
    repairManagedPnpm(dir)
    // `vx init` installs the latest vx, published within the day, and a
    // repo's pnpm `minimumReleaseAge` refuses it (TanStack/query, 2026-10-13).
    must([vxBin, 'init', '--native'], dir, { ...benchEnv(), pnpm_config_minimum_release_age: '0' })
    const script = path.join(REPO_ROOT, 'packages/vx-bench/real', `${repo.tool}-repo.sh`)
    const toolArgs = repo.tool === 'nx' ? 'NX_ARGS' : 'TURBO_ARGS'
    const out = must(['bash', script, dir, vxBin, repo.tasks, values.reps!], dir, {
      ...benchEnv(),
      FILTERS: repo.filters ?? '',
      VX_ARGS: `--concurrency ${repo.workers}`,
      [toolArgs]:
        repo.tool === 'nx' ? `--parallel=${repo.workers}` : `--concurrency=${repo.workers}`,
    })
    // `<tool> <arm> <ms> ms exit=<code>`: the best successful rep per tool and arm.
    const best = new Map<string, number>()
    for (const m of out.matchAll(/^(\w+) (\w+) (\d+) ms exit=(\d+)$/gm)) {
      const [, tool, arm, ms, code] = m
      if (code !== '0') {
        failures.push(`${repo.name}: ${tool} ${arm} exited ${code}`)
        continue
      }
      const k = `${tool} ${arm}`
      best.set(k, Math.min(best.get(k) ?? Infinity, Number(ms)))
    }
    for (const arm of ARMS) {
      const vx = best.get(`vx ${arm}`)
      const rival = best.get(`${repo.tool} ${arm}`)
      if (vx === undefined || rival === undefined) {
        failures.push(
          `${repo.name}: no successful ${arm} rep for ${vx === undefined ? 'vx' : repo.tool}`,
        )
        continue
      }
      rows.push({ repo: repo.name, tool: repo.tool, arm, vx, rival })
    }
  } catch (err) {
    // The command line alone named no cause: keep the output's last line too.
    const lines = (err as Error).message.split('\n').filter((l) => l.trim() !== '')
    failures.push(`${repo.name}: ${lines[0]}${lines.length > 1 ? ` ${lines.at(-1)!.trim()}` : ''}`)
  }
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(ms < 1000 ? 3 : 2)} s`
// "N× faster" from 2×, a percentage below it (owner, 2026-10-09).
const verdict = (r: Row): string => {
  const [fast, slow] = r.vx <= r.rival ? [r.vx, r.rival] : [r.rival, r.vx]
  const ratio = slow / fast
  const size = ratio >= 2 ? `${ratio.toFixed(1)}×` : `${Math.round((ratio - 1) * 100)}%`
  return r.vx <= r.rival ? `${size} faster` : `LOSS: ${r.tool} ${size} faster`
}
const losses = rows.filter((r) => r.vx > r.rival)
const report = [
  `# Nightly real-repo bench ${new Date().toISOString().slice(0, 10)}`,
  '',
  `vx ${vxCommit} (compiled from this checkout), ${values.reps} reps, best of each; ` +
    `${os.type()} ${os.arch()}, ${os.cpus().length} cores.`,
  '',
  '| Repo | Case | vx | Rival | Result |',
  '| ---- | ---- | -- | ----- | ------ |',
  ...rows.map(
    (r) => `| ${r.repo} | ${r.arm} | ${secs(r.vx)} | ${r.tool} ${secs(r.rival)} | ${verdict(r)} |`,
  ),
  '',
  ...(failures.length > 0 ? ['## Failed', '', ...failures.map((f) => `- ${f}`), ''] : []),
].join('\n')
if (values.out !== undefined) writeFileSync(values.out, report)
console.log(report)
for (const r of losses)
  console.log(`LOSS ${r.repo} ${r.arm}: vx ${secs(r.vx)} vs ${r.tool} ${secs(r.rival)}`)
process.exitCode = losses.length > 0 || failures.length > 0 ? 1 : 0
