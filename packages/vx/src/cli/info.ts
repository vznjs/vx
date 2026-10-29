// `vx info` — workspace doctor printout. One screen of environment +
// workspace + cache facts for bug reports and quick sanity checks.
// The facts come
// from the orchestrator's `collectInfo` (doctor.ts); this file parses the flags and renders the rows.

import os from 'node:os'
import { collectInfo, type InfoFacts } from '../orchestrator/index.js'
import { type FlakyTask } from '../history/index.js'
import { flagHint, formatValue, refuse, refusedWord, seeHelp } from './help.js'
import { namedCacheDir, parseCacheDirFlag, warnToStderr } from './workspace-config.js'
import { formatBytes } from './format.js'
import { detectColors, MIN_BUN, ui, type ColorSupport } from '../util/index.js'
import { envName } from '../settings.js'

interface InfoArgs {
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
      const v = formatValue(a === '--format' ? args[++i] : a.slice('--format='.length), 'info')
      if (typeof v === 'object') return { ...out, ...v }
      out.format = v
      continue
    }
    const cd = parseCacheDirFlag(args, i)
    if (cd !== null) {
      if ('error' in cd) return { ...out, error: `${cd.error}${seeHelp('info')}` }
      out.cacheDir = cd.cacheDir
      i = cd.next
      continue
    }
    return {
      ...out,
      error: `${refusedWord(a ?? '')}: ${a}${flagHint('info', a ?? '')}${seeHelp('info')}`,
    }
  }
  return out
}

export async function infoCmd(args: readonly string[]): Promise<number> {
  const parsed = parseInfoArgs(args)
  if (parsed.error) return refuse('info', args, parsed.error, 'VX_E_USAGE')
  // `collectInfo` takes a resolved directory, where one
  // not made yet is a workspace that never ran; the flag is the user's,
  // and a directory it names that is not there is a typo (item 900).
  if (parsed.cacheDir !== undefined) namedCacheDir(parsed.cacheDir)
  const facts = await collectInfo(process.cwd(), {
    ...(parsed.cacheDir !== undefined ? { cacheDir: parsed.cacheDir } : {}),
    warn: warnToStderr,
  })
  process.stdout.write(
    parsed.format === 'json'
      ? `${JSON.stringify(facts)}\n`
      : `${renderInfo(facts, detectColors(process.stdout))}\n`,
  )
  return 0
}

export function renderInfo(f: InfoFacts, colors: ColorSupport = { enabled: false }): string {
  const rows: [string, string][] = [
    [
      'vx',
      `${f.vx} (${tildePath(f.vxPath)}${f.handedOffFrom === null ? '' : `, handed off from ${tildePath(f.handedOffFrom)}`})`,
    ],
    // The prose stays in the rendered row; `f.bun` itself is the bare
    // version a script reads (doctor.ts says why).
    [
      'bun',
      f.bunSupported
        ? f.bun
        : `${f.bun} — unsupported, vx needs >= ${MIN_BUN.join('.')}; answers may be wrong`,
    ],
    ['git', f.git ?? '(not found)'],
    ['git status cache', renderGitStatusCache(f.gitStatusCache)],
    ['workspace root', tildePath(f.workspaceRoot)],
    ['projects', describeProjects(f)],
    ['plugins', describePlugins(f.plugins)],
    ['workers', describeWorkers(f.workers)],
    ['memory', describeMemory(f.memory)],
    [
      'cache dir',
      `${tildePath(f.cacheDir)} (${formatBytes(f.cacheDirBytes)}, ${f.cacheStore === null ? 'the entries and ' : ''}this workspace's run history)`,
    ],
    [
      'cache store',
      f.cacheStore === null
        ? 'none: the cache dir holds the entries'
        : `${tildePath(f.cacheStore)} (${formatBytes(f.cacheStoreBytes ?? 0)}, shared by this repo's checkouts)`,
    ],
    ['cache versions', `keys ${f.cacheVersion} · index schema ${f.schemaVersion}`],
    ['cache entries', describeEntries(f)],
    // Only the settings a variable or the workspace changed.
    ...(Object.values(f.settings).some((s) => s.source !== 'default')
      ? ([['settings', describeSettings(f.settings)]] as [string, string][])
      : []),
    // Only when there is something to say.
    ...(f.orphans.artifacts > 0
      ? ([
          [
            'orphans',
            `${f.orphans.artifacts} artifact${f.orphans.artifacts === 1 ? '' : 's'} (${formatBytes(f.orphans.bytes)}) the index does not know — \`vx cache clean\` reaps them`,
          ],
        ] as [string, string][])
      : []),
    // Task runs, not invocations (which `vx last` calls runs): the count
    // the hits are a share of.
    [
      'task runs (24h)',
      `${f.runs24h} (${f.hits24h} cache hit${f.hits24h === 1 ? '' : 's'}` +
        (f.hits24h > 0
          ? `: ${f.hits24h - f.restored24h} up-to-date, ${f.restored24h} restored)`
          : ')'),
    ],
    ['flaky tasks', describeFlakyTasks(f.flakyTasks)],
    ['sandbox', describeSandbox(f.sandbox)],
    ['projects lock', f.lockfile ? 'yes' : 'no'],
  ]
  return ui.report('vx info', rows).lines(colors).join('\n')
}

/** `812 (1.2 GB)`, or why the index cannot be read and its fix. */
function describeEntries(f: InfoFacts): string {
  if (f.cacheIndexError !== null) return `unreadable: ${f.cacheIndexError}`
  return `${f.cacheEntries} (${formatBytes(f.cacheBytes)})`
}

/**
 * The settings not at their default, with where each came from:
 * `run.timeout 30m (VX_RUN_TIMEOUT), cache.policy local:rw (.vx/workspace)`.
 */
function describeSettings(settings: InfoFacts['settings']): string {
  return Object.entries(settings)
    .filter(([, s]) => s.source !== 'default')
    .map(
      ([path, s]) =>
        `${path} ${String(s.value)} (${s.source === 'env' ? envName(path) : '.vx/workspace'})`,
    )
    .join(', ')
}

/** A path under the home directory as `~/…`: shorter, and no user name in a pasted report. */
function tildePath(p: string): string {
  const home = os.homedir()
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}

/**
 * `available (3 tasks declare exec.sandbox)`, with `, untraced — <why>, so
 * the reads it denies go unreported` where no strace can trace, or
 * `unavailable — <why>; 3
 * tasks declare exec.sandbox and will fail`: a declared sandbox whose
 * runtime cannot start fails the task, so the doctor names it before a run
 * does.
 */
function describeSandbox(s: InfoFacts['sandbox']): string {
  const declared = `${s.declared} task${s.declared === 1 ? '' : 's'} declare${s.declared === 1 ? 's' : ''} exec.sandbox`
  if (s.available && s.untraced !== null)
    return `available (${declared}), untraced — ${s.untraced}, so the reads it denies go unreported`
  if (s.available) return `available (${declared})`
  return `unavailable — ${s.reason}; ${declared}${s.declared > 0 ? ' and will fail' : ''}`
}

/** `4 — the CPU count`, `2 — cgroup CPU quota 2 of 8 cores`, `8 — .vx/workspace.ts (4 cores)`. */
export function describeWorkers(w: InfoFacts['workers']): string {
  const quota = w.cpuQuota === null ? '' : `, cgroup CPU quota ${trimCores(w.cpuQuota)}`
  const cores = `${w.cores} core${w.cores === 1 ? '' : 's'}`
  if (w.source === 'workspace') return `${w.count} — .vx/workspace.ts (${cores}${quota})`
  if (w.source === 'env') return `${w.count} — ${envName('run.concurrency')} (${cores}${quota})`
  if (w.source === 'cgroup')
    return `${w.count} — cgroup CPU quota ${trimCores(w.cpuQuota ?? w.count)} of ${cores}`
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
function describeProjects(f: InfoFacts): string {
  return `${f.projects} (${f.tasks} task${f.tasks === 1 ? '' : 's'})`
}

function describeFlakyTasks(tasks: readonly FlakyTask[]): string {
  if (tasks.length === 0) return 'none'
  const parts = tasks.map(
    (t, i) =>
      `${t.taskId} (${t.failures} of ${t.passes + t.failures} runs failed${i === 0 ? ' on unchanged inputs' : ''})`,
  )
  return `${tasks.length} — ${parts.join('; ')}`
}

function describePlugins(
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
