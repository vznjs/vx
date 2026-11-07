// Formatters for `--dry` (human / JSON).

import type { AffectedReason, CacheStatus, RunPlan } from '../orchestrator/index.js'
import { computeReverseDepCount } from '../graph/index.js'
import { planList, type PlannedRow, skippedReason } from '../report/index.js'
import { formatBytes, formatElapsed, maskedCommand, printable } from '../util/index.js'
import * as ui from '../ui/index.js'
import type { ColorSupport } from '../ui/index.js'

/**
 * `vx run --dry`'s screen: the `Plan` panel, each task on the running
 * list's grid (what the run would do with it, its usual time, where it
 * would run), then the counts and the predicted time.
 *
 *     Plan 3    status  cache     usual    time   cpu    mem outputs  blocks worker       task
 *              cached  local          —       —     —      —       —       — local        @vzn/vx#lint
 *              cached  remote         —       —     —      —    12MB       — local        @vzn/vx#test
 *              run     miss       ~1.2s       —     —      —       —       — local        @vzn/vx#build
 *
 *     tasks      3 planned · 2 cache hits (1 local, 1 remote, 12MB) · 1 would run
 *     predicted  ~1.20s wall · ~1.20s total execution
 */
export function planReport(plan: RunPlan): ui.Block {
  // A group the platform skip reaches is still a group: it runs nothing.
  const real = plan.tasks.filter(
    (t) =>
      t.cacheStatus !== 'group' &&
      (t.cacheStatus !== 'skipped' || t.node.config.exec !== undefined),
  )
  if (real.length === 0) return ui.section('Plan', ui.text('No tasks planned.'))

  const blocks = downstream(plan)
  const rows: PlannedRow[] = []
  let local = 0
  let remote = 0
  let miss = 0
  let nocache = 0
  let noop = 0
  let idle = 0
  let platform = 0
  for (const t of real) {
    // `@noop`: the run succeeds it without running, whatever its key says.
    const skipped = t.executor === 'noop' && t.cacheStatus !== 'skipped'
    const notes: string[] = []
    if (t.cacheStatus === 'skipped') notes.push(skippedReason(t))
    const desc = shownDescription(t)
    if (desc !== undefined && desc !== '') notes.push(desc)
    if (t.affected !== undefined) notes.push(`affected: ${printable(describeReason(t.affected))}`)
    const executes = !skipped && (t.cacheStatus === 'miss' || t.cacheStatus === 'no-cache')
    rows.push({
      node: t.node,
      ...(skipped ? NOOP : LOOK[t.cacheStatus]),
      ...(executes && t.p50Ms !== undefined ? { usualMs: t.p50Ms } : {}),
      ...(t.cacheStatus === 'hit-remote' && t.remoteBytes !== undefined
        ? { outputBytes: t.remoteBytes }
        : {}),
      blocks: blocks.get(t.node.id) ?? 0,
      // Placement by executor name; a task that will not run reaches no
      // machine, as a skip's row in the run has none.
      worker:
        skipped || t.cacheStatus === 'skipped' || t.cacheStatus === 'not-started'
          ? ''
          : (t.executor ?? 'local'),
      note: notes.join(' · '),
    })
    if (skipped) noop++
    else if (t.cacheStatus === 'hit-local') local++
    else if (t.cacheStatus === 'hit-remote') remote++
    else if (t.cacheStatus === 'miss') miss++
    else if (t.cacheStatus === 'no-cache') nocache++
    else if (t.cacheStatus === 'not-started') idle++
    else if (t.cacheStatus === 'skipped') platform++
  }

  const hitParts: string[] = []
  if (local > 0) hitParts.push(`${local} local`)
  if (remote > 0) {
    // The remote's sizes, summed: what restoring the hits would download.
    const bytes = real.reduce((sum, t) => sum + (t.remoteBytes ?? 0), 0)
    hitParts.push(bytes > 0 ? `${remote} remote, ${formatBytes(bytes)}` : `${remote} remote`)
  }
  const hits = local + remote
  const summary: string[] = [`${real.length} planned`]
  if (hits > 0) summary.push(`${hits} cache hit${hits === 1 ? '' : 's'} (${hitParts.join(', ')})`)
  if (miss > 0) summary.push(`${miss} would run`)
  if (nocache > 0) summary.push(`${nocache} no-cache`)
  if (noop > 0) summary.push(`${noop} noop`)
  if (idle > 0) summary.push(`${idle} not started`)
  if (platform > 0) summary.push(`${platform} skipped`)
  const facts: ui.FieldRow[] = [['tasks', summary.join(' · ')]]

  // `--cache-download` is invisible without this: the eligibility gate silently
  // keeps producers eager, so a user who asked for `none` and got no
  // deferral has nothing to read. Say what WOULD stay remote, and name the
  // refusals when nothing would.
  const deferred = real.filter((t) => t.download === 'deferred')
  const downgrades = plan.downloadDowngrades ?? []
  if (deferred.length > 0 || downgrades.length > 0) {
    facts.push([
      'download',
      `${deferred.length} task(s) would keep outputs remote` +
        (downgrades.length > 0 ? `, ${downgrades.length} kept eager:` : '.'),
      ...downgrades.slice(0, 3).map((d) => [ui.id(d.taskId), ui.dim(` — ${d.reason}`)]),
      ...(downgrades.length > 3 ? [`…and ${downgrades.length - 3} more`] : []),
    ])
  }

  // Time prediction — only when history gave us something to say: at least
  // one would-run task has a p50 (an all-unknown prediction is pure noise).
  const p = plan.predicted
  const executes = miss + nocache
  if (p !== undefined && executes > 0 && executes > p.unknownCount) {
    const parts = [`~${formatElapsed(p.wallMs)} wall`]
    parts.push(`~${formatElapsed(p.workMs)} total execution`)
    if (p.unknownCount > 0) {
      parts.push(`${p.unknownCount} task${p.unknownCount === 1 ? '' : 's'} without history (+?)`)
    }
    facts.push(['predicted', parts.join(' · ')])
  }
  return ui.section('Plan', String(real.length), planList(rows), ui.fields(facts))
}

/**
 * How many tasks are downstream of each, all of them (groups too), by the
 * run's own count: a closure walked per task was quadratic, and a 10,000
 * task chain's `--dry` spent 7 s here.
 */
function downstream(plan: RunPlan): Map<string, number> {
  return computeReverseDepCount(
    new Map(plan.tasks.map((t) => [t.node.id, { ...t.node, deps: [...t.deps] }])),
  )
}

/** The plan as plain text: what a pipe, a test or `grep` reads. */
export function formatPlanText(plan: RunPlan, c: ColorSupport = { enabled: false }): string {
  return ui.render([planReport(plan)], c)
}

type Look = Pick<PlannedRow, 'status' | 'tone' | 'cache' | 'cacheTone'>

/** Each outcome on the run's grid: its words, as the run would print them. */
const LOOK: Record<CacheStatus, Look> = {
  'hit-local': {
    status: 'cached',
    tone: 'ok',
    cache: 'local',
    cacheTone: 'local',
  },
  'hit-remote': {
    status: 'cached',
    tone: 'ok',
    cache: 'remote',
    cacheTone: 'remote',
  },
  miss: { status: 'run', tone: 'info', cache: 'miss', cacheTone: 'muted' },
  'no-cache': {
    status: 'run',
    tone: 'info',
    cache: 'no-cache',
    cacheTone: 'muted',
  },
  group: { status: 'group', tone: 'muted', cache: '', cacheTone: '' },
  'not-started': { status: 'not run', tone: 'muted', cache: '', cacheTone: '' },
  skipped: { status: 'skipped', tone: 'warn', cache: '', cacheTone: '' },
}
const NOOP: Look = { status: 'noop', tone: 'muted', cache: '', cacheTone: '' }

/** One `--affected --dry` reason line: the cause, then the edge chain that carried it. */
function describeReason(r: AffectedReason): string {
  const cause =
    r.kind === 'named'
      ? 'named on the command line'
      : r.kind === 'selected'
        ? 'its project is selected outright'
        : r.kind === 'package'
          ? `a ^ edge passes changed package ${r.project}`
          : r.kind === 'input'
            ? `${r.file} changed (an input)`
            : r.kind === 'workspace'
              ? `${r.file} changed (${r.wide === true ? 'workspace-wide' : 'every task in its project'})`
              : r.file !== undefined
                ? `${r.file} changed (in its project)`
                : 'its project changed as a whole'
  return r.via === undefined ? cause : `${cause}, via ${r.via.join(' ← ')}`
}

function wireReason(r: AffectedReason): AffectedReason {
  if (r.wide === undefined) return r
  const wire = { ...r }
  delete wire.wide
  return wire
}

/** A TS config may build the description from `process.env` (L-11). */
function shownDescription(t: RunPlan['tasks'][number]): string | undefined {
  const { description, exec } = t.node.config
  return description === undefined ? undefined : maskedCommand(description, exec?.env)
}

/** One task of `vx run --dry=json`: the wire, stated by `schemas/plan.json`. */
export interface PlanTaskJson {
  id: string
  project: string
  task: string
  hash: string
  cacheStatus: CacheStatus
  deps: readonly string[]
  p50Ms?: number
  executor?: string
  download?: 'deferred'
  description?: string
  affected?: AffectedReason
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string }
  blockedBy?: string
}

/** `affectedBase`: the ref a bare `--affected` guessed (or was given), so a reader knows what the diff was against. */
export function formatPlanJson(
  plan: Pick<RunPlan, 'tasks' | 'predicted' | 'downloadDowngrades'>,
  affectedBase?: string,
): string {
  return (
    JSON.stringify({
      ...(affectedBase !== undefined ? { affectedBase } : {}),
      tasks: plan.tasks.map((t): PlanTaskJson => {
        const description = shownDescription(t)
        return {
          id: t.node.id,
          project: t.node.projectName,
          task: t.node.taskName,
          hash: t.hash,
          cacheStatus: t.cacheStatus,
          deps: t.deps,
          ...(t.p50Ms !== undefined ? { p50Ms: t.p50Ms } : {}),
          ...(t.executor !== undefined ? { executor: t.executor } : {}),
          ...(t.download !== undefined ? { download: t.download } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(t.affected !== undefined ? { affected: wireReason(t.affected) } : {}),
          ...(t.otherPlatform !== undefined ? { otherPlatform: t.otherPlatform } : {}),
          ...(t.blockedBy !== undefined ? { blockedBy: t.blockedBy } : {}),
        }
      }),
      ...(plan.predicted !== undefined ? { predicted: plan.predicted } : {}),
      // The gate's refusals belong on the SCRIPTING surface too: a CI job
      // asking "did --cache-download=none actually defer anything, and if not
      // why" reads this, not the human table. (This object enumerates its
      // fields deliberately — the plan's internal shape is not the wire —
      // which is exactly why a new PlannedTask field does not appear here
      // for free, and why `download` above had to be added by hand.)
      ...(plan.downloadDowngrades !== undefined
        ? { downloadDowngrades: plan.downloadDowngrades }
        : {}),
    }) + '\n'
  )
}
