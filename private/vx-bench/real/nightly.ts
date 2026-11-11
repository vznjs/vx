// The nightly real-repo bench (2026-10-12): every repo on
// /compare/real-repos/, re-run against the tool it ships with on this
// checkout's vx. Each case's best rep is compared; a case vx loses is a
// LOSS line and the run exits 1, so the routine that runs it files the
// loss with Engineering.
//
//   bun private/vx-bench/real/nightly.ts [--reps N] [--out report.md] [--only name]
//     [--json real-repos.json]
//
// Needs network (git clone, pnpm install) and node + pnpm on PATH. Repos
// are kept under VX_NIGHTLY_DIR (default ~/.vx-nightly), reset to their
// pinned commit each night and moved to vx: a repo with an overlay gets
// the native config written for it under real/<name>/ copied over the
// clone (REPOS.md); the others run `vx init --native`. `--json` writes each
// repo's row in real-repos.json's shape into that file, replacing the row
// of the same repo.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { benchEnv } from '../bench-env.js'
import { vxCompileEntries } from '../compile-entries.js'
import { ARMS, bestReps, dataRow, mergeRows, serializeData, settle, type DataRow } from './rows.js'

interface Repo {
  name: string
  url: string
  commit: string
  tool: 'turbo' | 'nx'
  tasks: string
  /** FILTERS for the harness: both tools run the same projects. */
  filters?: string
  workers: number
  /** Native config kept in real/<name>/, copied over the clone; pinned by full SHA. */
  overlay?: boolean
}

// The repos and scopes /compare/real-repos/ publishes (benchmarks.md § Real repos).
const REPOS: Repo[] = [
  {
    name: 'create-t3-turbo',
    url: 'https://github.com/t3-oss/create-t3-turbo',
    commit: '8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee',
    tool: 'turbo',
    tasks: 'build',
    filters: './packages/*',
    workers: 10,
    overlay: true,
  },
  {
    name: 'solid',
    url: 'https://github.com/solidjs/solid',
    commit: 'b25c557754f2ced0d86490e6dbfded9b1745b663',
    tool: 'turbo',
    tasks: 'build',
    workers: 10,
    overlay: true,
  },
  {
    name: 'vueuse',
    url: 'https://github.com/vueuse/vueuse',
    commit: 'efdd69a1481205051e85d9c815eaa5840237f2d1',
    tool: 'turbo',
    tasks: 'build',
    workers: 10,
    overlay: true,
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

const { values } = parseArgs({
  options: {
    reps: { type: 'string', default: '3' },
    out: { type: 'string' },
    only: { type: 'string' },
    json: { type: 'string' },
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

// `vx init` installs the latest vx, published within the day, and a repo's
// pnpm `minimumReleaseAge` refuses it, in the install and again in every
// task whose script runs pnpm against the lockfile (TanStack/query,
// 2026-10-13). An env override reaches neither: vx gives a task only the
// variables it declares. Exempt vx's own packages in the repo's config.
function allowSameDayVx(dir: string): void {
  const file = path.join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(file)) return
  const yaml = readFileSync(file, 'utf8')
  if (!/^minimumReleaseAge:/m.test(yaml) || /^minimumReleaseAgeExclude:/m.test(yaml)) return
  writeFileSync(file, `${yaml.replace(/\n*$/, '\n')}minimumReleaseAgeExclude:\n  - '@vzn/*'\n`)
}

// `vx init` writes .vx/workspace.ts with the published @vzn/vx-migrate,
// which can predate this checkout's config shape: until 0.0.637 shipped it
// wrote `concurrency` and `affectedBase` at the top level, which this vx
// refuses. Move one-line fields under `run`, as the refusal says.
const MOVED_TO_RUN = ['concurrency', 'schedule', 'affectedBase', 'timeout']
function moveRunFields(dir: string): void {
  for (const name of ['.vx/workspace.ts', '.vx/workspace.mjs', '.vx/workspace.js']) {
    const file = path.join(dir, name)
    if (!existsSync(file)) continue
    const moved: string[] = []
    const text = readFileSync(file, 'utf8').replace(
      new RegExp(`^  (${MOVED_TO_RUN.join('|')}): (.+?),?\\n`, 'gm'),
      (_, key: string, value: string) => {
        moved.push(`${key}: ${value}`)
        return ''
      },
    )
    if (moved.length === 0) return
    writeFileSync(
      file,
      text.replace(/\n\}( satisfies [\w]+)?\s*$/, `\n  run: { ${moved.join(', ')} },\n}$1\n`),
    )
    return
  }
}

// The overlay's configs over the clone, and the plugin packages its
// workspace file imports linked from this checkout: the binary serves
// `@vzn/vx` itself, a plugin it does not carry.
function applyOverlay(name: string, dir: string): void {
  const overlay = path.join(REPO_ROOT, 'private/vx-bench/real', name)
  cpSync(overlay, dir, { recursive: true })
  const workspace = readFileSync(path.join(overlay, '.vx/workspace.ts'), 'utf8')
  for (const [, pkg] of workspace.matchAll(/from '@vzn\/(vx-[\w-]+)'/g)) {
    // Replaced each night: a link kept from another checkout dangles.
    const link = path.join(dir, 'node_modules/@vzn', pkg!)
    rmSync(link, { force: true, recursive: true })
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(path.join(REPO_ROOT, 'packages', pkg!), link)
  }
  // The copy rewrites tracked files (vueuse's turbo.json) and the install
  // touched others: a stale index stat makes vx hash a clean file from disk
  // instead of trusting its blob id. Exit 1 (files differ) is expected.
  sh(['git', 'update-index', '-q', '--refresh'], dir)
}

const vxBin = path.join(WORK, 'vx')
must(
  [
    'bun',
    'build',
    '--compile',
    '--minify',
    '--bytecode',
    ...vxCompileEntries(path.join(REPO_ROOT, 'packages/vx/src/bin.ts')),
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
const dataRows: DataRow[] = []
const failures: string[] = []
const today = new Date().toISOString().slice(0, 10)

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
    if (repo.overlay === true) applyOverlay(repo.name, dir)
    else {
      allowSameDayVx(dir)
      must([vxBin, 'init', '--native'], dir)
      moveRunFields(dir)
    }
    const script = path.join(REPO_ROOT, 'private/vx-bench/real', `${repo.tool}-repo.sh`)
    const toolArgs = repo.tool === 'nx' ? 'NX_ARGS' : 'TURBO_ARGS'
    const load = await settle(os.loadavg, (ms) => Bun.sleep(ms))
    const out = must(['bash', script, dir, vxBin, repo.tasks, values.reps!], dir, {
      ...benchEnv(),
      FILTERS: repo.filters ?? '',
      VX_ARGS: `--concurrency ${repo.workers}`,
      [toolArgs]:
        repo.tool === 'nx' ? `--parallel=${repo.workers}` : `--concurrency=${repo.workers}`,
    })
    // Every rep and the box's load: a best rep says nothing of the others,
    // or of what else ran (a 91 ms no-op that was 55 ms idle, 2026-11-10).
    console.error(`${repo.name}: load before ${load}\n${out}`)
    const best = bestReps(out)
    failures.push(...best.failed.map((f) => `${repo.name}: ${f}`))
    for (const arm of ARMS) {
      const vx = best.ms.get(`vx ${arm}`)
      const rival = best.ms.get(`${repo.tool} ${arm}`)
      if (vx !== undefined && rival !== undefined)
        rows.push({ repo: repo.name, tool: repo.tool, arm, vx, rival })
    }
    const toolPkg = path.join(dir, 'node_modules', repo.tool, 'package.json')
    const row = dataRow(
      {
        repo: new URL(repo.url).pathname.slice(1),
        version: JSON.parse(readFileSync(toolPkg, 'utf8')).version,
        commit: repo.commit,
        machine: `${os.platform()} ${os.arch()}, ${os.cpus().length} cores`,
        load,
        setup:
          repo.overlay === true
            ? `native config, \`private/vx-bench/real/${repo.name}/\``
            : 'native config, `vx init --native`',
        date: today,
        heading: 'Real repos on native config',
      },
      repo.tool,
      best,
    )
    if ('row' in row) dataRows.push(row.row)
    else failures.push(`${repo.name}: no successful rep of ${row.missing.join(', ')}`)
  } catch (err) {
    // The command line alone named no cause: keep the output's last line too.
    const lines = (err as Error).message.split('\n').filter((l) => l.trim() !== '')
    failures.push(`${repo.name}: ${lines[0]}${lines.length > 1 ? ` ${lines.at(-1)!.trim()}` : ''}`)
  }
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(ms < 1000 ? 3 : 2)} s`
// "N× faster" from 2×, a percentage below it (2026-10-09).
const verdict = (r: Row): string => {
  const [fast, slow] = r.vx <= r.rival ? [r.vx, r.rival] : [r.rival, r.vx]
  const ratio = slow / fast
  const size = ratio >= 2 ? `${ratio.toFixed(1)}×` : `${Math.round((ratio - 1) * 100)}%`
  return r.vx <= r.rival ? `${size} faster` : `LOSS: ${r.tool} ${size} faster`
}
const losses = rows.filter((r) => r.vx > r.rival)
const report = [
  `# Nightly real-repo bench ${today}`,
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
if (values.json !== undefined && dataRows.length > 0) {
  const file = values.json
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rows: [] }
  writeFileSync(file, serializeData({ ...data, rows: mergeRows(data.rows, dataRows) }))
}
console.log(report)
for (const r of losses)
  console.log(`LOSS ${r.repo} ${r.arm}: vx ${secs(r.vx)} vs ${r.tool} ${secs(r.rival)}`)
process.exitCode = losses.length > 0 || failures.length > 0 ? 1 : 0
