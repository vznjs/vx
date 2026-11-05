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

const TOOL_NAMES: Record<string, string> = {
  vx: 'vx',
  turbo: 'Turborepo',
  nx: 'Nx',
  'vite-task': 'Vite Task',
  nix: 'Nix',
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

const unique = (xs: string[]): string[] => [...new Set(xs)]
export const CATEGORIES = unique(RESULTS.cases.map((c) => c.category))

/** A score as the page prints it: a whole percentage, rounded down so one failure never reads 100%, or `–` when no case applies. */
export const percent = (s: Score | undefined): string =>
  s === undefined || s.of === 0 ? '–' : `${Math.floor((s.pass / s.of) * 100)}%`

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
