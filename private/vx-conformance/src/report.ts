// The results: the data the site's conformance page renders (every case,
// what each tool did, each tool's score per kind and category), and the
// score table the CLI prints.
import path from 'node:path'
import type { Adapter } from './adapter.ts'
import type { Outcome } from './harness.ts'
import { INVENTORY, VERDICTS, type Verdict } from './inventory.ts'
import type { Case, Category, Kind } from './spec.ts'

export interface Coverage {
  /** Test files a case draws from. */
  ported: number
  /** Files of each other verdict that no case cites. */
  rest: Record<Verdict, string[]>
  /** What each verdict means. */
  verdicts: Record<Verdict, string>
}

/** How much of vx's own suite the cases carry. */
export function coverage(cases: Case[]): Coverage {
  const cited = new Set(cases.flatMap((c) => c.from))
  return {
    ported: cited.size,
    rest: Object.fromEntries(
      Object.entries(INVENTORY).map(([v, files]) => [v, files.filter((f) => !cited.has(f))]),
    ) as Record<Verdict, string[]>,
    verdicts: VERDICTS,
  }
}

/** Cases a tool passed, of those it could express. */
export interface Score {
  pass: number
  of: number
}

export interface Results {
  coverage: Coverage
  /** Tool → version. */
  tools: Record<string, string>
  /** Tool → `all`, each kind and each category → its score. */
  scores: Record<string, Record<string, Score>>
  cases: {
    id: string
    category: Category
    kind: Kind
    title: string
    why?: string
    from: string[]
    outcomes: Record<string, Outcome>
  }[]
}

const MODULES = path.join(import.meta.dir, '..', 'node_modules')

export async function toolVersion(a: Adapter): Promise<string> {
  const pkg = await Bun.file(path.join(MODULES, a.pkg, 'package.json')).json()
  // The workspace's own packages are this checkout.
  return pkg.version === '0.0.0' ? 'this commit' : String(pkg.version)
}

type Row = Results['cases'][number]

function score(rows: Row[], tool: string): Score {
  const applicable = rows.filter((r) => r.outcomes[tool]?.status !== 'n/a')
  return {
    pass: applicable.filter((r) => r.outcomes[tool]?.status === 'pass').length,
    of: applicable.length,
  }
}

/** Each tool's score over all cases, each kind and each category. */
export function scores(tools: string[], rows: Row[]): Results['scores'] {
  const groups: [string, Row[]][] = [
    ['all', rows],
    ...[...new Set(rows.map((r) => r.kind))].map((k): [string, Row[]] => [
      k,
      rows.filter((r) => r.kind === k),
    ]),
    ...[...new Set(rows.map((r) => r.category))].map((c): [string, Row[]] => [
      c,
      rows.filter((r) => r.category === c),
    ]),
  ]
  return Object.fromEntries(
    tools.map((t) => [t, Object.fromEntries(groups.map(([g, rs]) => [g, score(rs, t)]))]),
  )
}

const percent = (s: Score | undefined) =>
  s === undefined || s.of === 0 ? '–' : `${Math.round((s.pass / s.of) * 100)}% (${s.pass}/${s.of})`

/** The score table, as the CLI prints it. */
export function scoreTable(r: Pick<Results, 'tools' | 'scores'>): string {
  const tools = Object.keys(r.tools)
  const groups = Object.keys(r.scores[tools[0]!] ?? {})
  return [
    `| | ${tools.map((t) => `${t} ${r.tools[t]}`).join(' | ')} |`,
    `|---|${tools.map(() => '---').join('|')}|`,
    ...groups.map((g) => `| ${g} | ${tools.map((t) => percent(r.scores[t]![g])).join(' | ')} |`),
  ].join('\n')
}
