// `vx info` — workspace doctor printout. One screen of environment +
// workspace + cache facts for bug reports and quick sanity checks.
// `vx stats` is a deprecated alias (info absorbed it). The facts come
// from the orchestrator's `collectInfo` (doctor.ts), which `vx mcp` reads
// too; this file parses the flags and renders the rows.

import { collectInfo, type FlakyTask, type InfoFacts } from '../orchestrator/index.js'
import { seeHelp } from './help.js'
import { parseCacheDirFlag, warnToStderr } from './workspace-config.js'
import { formatBytes } from './format.js'

export interface InfoArgs {
  format: 'pretty' | 'json'
  /** `--cache-dir`: report on the cache a run with the same flag uses. */
  cacheDir?: string
  error?: string
}

export function parseInfoArgs(args: readonly string[]): InfoArgs {
  const out: InfoArgs = { format: 'pretty' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--format' || a?.startsWith('--format=')) {
      const v = a === '--format' ? args[++i] : a.slice('--format='.length)
      if (v !== 'pretty' && v !== 'json') {
        return { ...out, error: `--format must be pretty or json${seeHelp('info')}` }
      }
      out.format = v
      continue
    }
    const cd = parseCacheDirFlag(args, i)
    if (cd !== null) {
      if ('error' in cd) return { ...out, error: cd.error }
      out.cacheDir = cd.cacheDir
      i = cd.next
      continue
    }
    return { ...out, error: `unknown argument: ${a}${seeHelp('info')}` }
  }
  return out
}

export async function infoCmd(args: readonly string[]): Promise<number> {
  const parsed = parseInfoArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx info: ${parsed.error}\n`)
    return 1
  }
  const facts = await collectInfo(process.cwd(), {
    ...(parsed.cacheDir !== undefined ? { cacheDir: parsed.cacheDir } : {}),
    warn: warnToStderr,
  })
  process.stdout.write(
    parsed.format === 'json' ? `${JSON.stringify(facts, null, 2)}\n` : `${renderInfo(facts)}\n`,
  )
  return 0
}

export function renderInfo(f: InfoFacts): string {
  const rows: [string, string][] = [
    ['vx', f.vx],
    ['bun', f.bun],
    ['git', f.git ?? '(not found)'],
    ['git status cache', renderGitStatusCache(f.gitStatusCache)],
    ['workspace root', f.workspaceRoot],
    ['projects', `${f.projects} (${f.tasks} task${f.tasks === 1 ? '' : 's'})`],
    ['plugins', describePlugins(f.plugins)],
    ['workers', describeWorkers(f.workers)],
    ['memory', describeMemory(f.memory)],
    ['cache dir', f.cacheDir],
    ['cache versions', `keys ${f.cacheVersion} · index schema ${f.schemaVersion}`],
    ['cache entries', `${f.cacheEntries} (${formatBytes(f.cacheBytes)})`],
    // Only when there is something to say.
    ...(f.orphans.artifacts > 0
      ? ([
          [
            'orphans',
            `${f.orphans.artifacts} artifact${f.orphans.artifacts === 1 ? '' : 's'} (${formatBytes(f.orphans.bytes)}) the index does not know — \`vx cache prune\` reaps them`,
          ],
        ] as [string, string][])
      : []),
    ['runs (24h)', `${f.runs24h} (${f.hits24h} cache hits)`],
    ['flaky tasks', describeFlakyTasks(f.flakyTasks)],
    ['vx-lock.json', f.lockfile ? 'yes' : 'no'],
  ]
  const labelW = Math.max(...rows.map(([label]) => label.length))
  return rows.map(([label, value]) => `${`${label}:`.padEnd(labelW + 1)} ${value}`).join('\n')
}

/** `4 — the CPU count`, `2 — cgroup CPU quota 2 of 8 cores`, `8 — vx.workspace.ts (4 cores)`. */
export function describeWorkers(w: InfoFacts['workers']): string {
  const quota = w.cpuQuota === null ? '' : `, cgroup CPU quota ${trimCores(w.cpuQuota)}`
  if (w.source === 'workspace') return `${w.count} — vx.workspace.ts (${w.cores} cores${quota})`
  if (w.source === 'cgroup')
    return `${w.count} — cgroup CPU quota ${trimCores(w.cpuQuota ?? w.count)} of ${w.cores} cores`
  return `${w.count} — the CPU count${quota}`
}

/** `13 GB usable — cgroup limit; the machine has 16 GB`, or `16 GB`. */
export function describeMemory(m: InfoFacts['memory']): string {
  if (m.cgroupLimitBytes !== null && m.usableBytes < m.totalBytes) {
    return `${formatBytes(m.usableBytes)} usable — cgroup limit; the machine has ${formatBytes(m.totalBytes)}`
  }
  return formatBytes(m.totalBytes)
}

function trimCores(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '')
}

/** `2 — app#test (3 of 7 runs failed on unchanged inputs); api#e2e (1 of 4)`, or `none`. */
export function describeFlakyTasks(tasks: readonly FlakyTask[]): string {
  if (tasks.length === 0) return 'none'
  const parts = tasks.map(
    (t, i) =>
      `${t.taskId} (${t.failures} of ${t.passes + t.failures} runs failed${i === 0 ? ' on unchanged inputs' : ''})`,
  )
  return `${tasks.length} — ${parts.join('; ')}`
}

export function describePlugins(
  plugins: ReadonlyArray<{ name: string; seams: readonly string[] }>,
): string {
  if (plugins.length === 0) return 'none'
  const parts = plugins.map(
    (p) => `${p.name} (${p.seams.length === 0 ? 'no seams' : p.seams.join(', ')})`,
  )
  return `${plugins.length} — ${parts.join('; ')}`
}

function renderGitStatusCache(c: InfoFacts['gitStatusCache']): string {
  if (c === null) return '(unknown)'
  if (c.fsmonitor && c.untrackedCache) return 'fsmonitor + untrackedCache on'
  const missing = [
    ...(c.fsmonitor ? [] : ['core.fsmonitor']),
    ...(c.untrackedCache ? [] : ['core.untrackedCache']),
  ]
  return `${missing.join(', ')} off`
}
