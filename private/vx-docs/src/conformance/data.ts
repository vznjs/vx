// The conformance page's data: src/data/conformance.json, written by
// @vzn/vx-conformance's `conformance` task (its `Results`). A static import,
// as the bench data's: a build without the file fails to resolve it. The
// type is restated, not imported: the site's type-check reads no other
// private package.
import raw from '../data/conformance.json'

export type Status = 'pass' | 'fail' | 'n/a'

export interface Outcome {
  status: Status
  step?: number
  detail?: string
}

export interface Score {
  pass: number
  /** Cases the tool can express at all. */
  can: number
  of: number
}

export interface Case {
  id: string
  category: string
  kind: string
  title: string
  why: string
  from: string[]
  outcomes: Record<string, Outcome>
}

export interface Results {
  coverage: {
    ported: number
    rest: Record<string, string[]>
    verdicts: Record<string, string>
  }
  tools: Record<string, string>
  scores: Record<string, Record<string, Score>>
  cases: Case[]
}

export const RESULTS = raw as Results
export const TOOLS = Object.keys(RESULTS.tools)
/** The tools as the page lists them: most cases passed first. */
export const RANKED = [...TOOLS].sort(
  (a, b) => (RESULTS.scores[b]?.['all']?.pass ?? 0) - (RESULTS.scores[a]?.['all']?.pass ?? 0),
)

const TOOL_NAMES: Record<string, string> = {
  vx: 'vx',
  turbo: 'Turborepo',
  nx: 'Nx',
  'vite-task': 'Vite Task',
  nix: 'Nix',
  moon: 'moon',
}
export const toolName = (t: string): string => TOOL_NAMES[t] ?? t
/** A column header's name on a phone, where a cell is a mark wide. */
export const toolShort = (t: string): string =>
  ({ turbo: 'Turbo', 'vite-task': 'Vite' })[t] ?? toolName(t)

const GROUP_NAMES: Record<string, string> = {
  all: 'All cases',
  correctness: 'Correctness',
  efficiency: 'Efficiency',
  data: 'Data',
  graph: 'Task graph',
  inputs: 'Inputs',
  outputs: 'Outputs',
  env: 'Environment',
  cache: 'Cache',
  config: 'Config',
  failure: 'Failures',
  affected: 'Affected',
  report: 'Run report',
  sandbox: 'Isolation',
  watch: 'Watch mode',
}
export const groupName = (g: string): string => GROUP_NAMES[g] ?? g

// What each category checks and why it matters, shown on its section.
const ABOUT: Record<string, string> = {
  graph:
    'Which tasks run, in what order, and how many at once. Get it wrong and a build reads files its dependency has not written yet.',
  inputs:
    'Which file changes make a task run again. Miss one and the cache replays an old result for new code: a green build that ships the wrong thing.',
  outputs:
    'The files a task leaves on disk, saved and brought back on a replay. A replay must leave the disk exactly as a real run would.',
  env: 'Environment variables a task reads. A changed variable must run the task again, or a build made for one environment ships to another.',
  cache:
    'When a task is replayed instead of run. Replay too often and results are wrong; too rarely and every run pays the full time again.',
  failure:
    'What a failing task does to the rest of the run. Nothing that needs it may run, and the run must say it failed.',
  config:
    'Mistakes in the config, like depending on a task that does not exist. The tool must refuse them up front, not quietly skip the task.',
  affected:
    'Running only what a change touches. Miss a project and a broken change merges untested; pick too many and CI wastes time.',
  report:
    'The data a run hands back about each task: time, cache result, CPU, memory. Without it, nobody can see why CI is slow.',
  sandbox:
    'Whether a task is stopped from reading or writing what it never declared. Without that, the inputs list is a promise nobody checks.',
  watch:
    'Rerunning on save. Rebuild on every real change and only then, so you never wait on work that was not needed.',
}
/** What a category checks and why it matters, or '' for none. */
export const about = (g: string): string => ABOUT[g] ?? ''

const unique = (xs: string[]): string[] => [...new Set(xs)]
export const CATEGORIES = unique(RESULTS.cases.map((c) => c.category))

/** A score as the page prints it: cases passed of those the tool supports, a whole percentage rounded down so one failure never reads 100%, or `–` when it supports none. */
export const percent = (s: Score | undefined): string =>
  s === undefined || s.can === 0 ? '–' : `${Math.floor((s.pass * 100) / s.can)}%`

/** The share of all cases a tool can express at all, rounded down like {@link percent}. */
export const supports = (s: Score | undefined): string =>
  s === undefined || s.of === 0 ? '–' : `${Math.floor((s.can * 100) / s.of)}%`

/** Whether every tool that can express the case got the same result. */
export function agree(c: Case): boolean {
  const seen = new Set(
    Object.values(c.outcomes)
      .map((o) => o.status)
      .filter((s) => s !== 'n/a'),
  )
  return seen.size <= 1
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A case's text as HTML: escaped, with its `code` spans in code font. */
export const inline = (s: string): string =>
  escape(s).replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`)

/** A failing or inapplicable cell's note, in plain text. */
export const note = (o: Outcome): string =>
  [o.step === undefined ? '' : `Step ${o.step}: `, o.detail ?? ''].join('')
