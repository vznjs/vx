// The report: one score per tool and category, then every case where the
// tools disagree, each with what each tool did.
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
}

/** How much of vx's own suite the cases carry. */
export function coverage(cases: Case[]): Coverage {
  const cited = new Set(cases.flatMap((c) => c.from))
  return {
    ported: cited.size,
    rest: Object.fromEntries(
      Object.entries(INVENTORY).map(([v, files]) => [v, files.filter((f) => !cited.has(f))]),
    ) as Record<Verdict, string[]>,
  }
}

export interface Results {
  coverage: Coverage
  /** Tool → version. */
  tools: Record<string, string>
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

function score(rows: Row[], tool: string): string {
  const applicable = rows.filter((r) => r.outcomes[tool]?.status !== 'n/a')
  if (applicable.length === 0) return '–'
  const pass = applicable.filter((r) => r.outcomes[tool]?.status === 'pass').length
  return `${Math.round((pass / applicable.length) * 100)}% (${pass}/${applicable.length})`
}

const MARK = { pass: '✓', fail: '✗', 'n/a': '–' } as const

export function renderReport(r: Results): string {
  const tools = Object.keys(r.tools)
  const categories = [...new Set(r.cases.map((c) => c.category))]
  const head = `| | ${tools.map((t) => `${t} ${r.tools[t]}`).join(' | ')} |\n|---|${tools.map(() => '---').join('|')}|`
  const line = (label: string, rows: Row[]) =>
    `| ${label} | ${tools.map((t) => score(rows, t)).join(' | ')} |`
  const differ = r.cases.filter((c) => new Set(tools.map((t) => c.outcomes[t]?.status)).size > 1)
  const allFail = r.cases.filter((c) => tools.every((t) => c.outcomes[t]?.status === 'fail'))
  const caseBlock = (c: Row) =>
    [
      `### ${c.title}`,
      '',
      `\`${c.id}\` · ${c.kind}${c.why ? ` · ${c.why}` : ''}`,
      '',
      ...tools.map((t) => {
        const o = c.outcomes[t]!
        return `- ${MARK[o.status]} **${t}**${o.detail ? `: ${o.step ? `step ${o.step}, ` : ''}${o.detail}` : ''}`
      }),
      '',
    ].join('\n')
  return [
    '# Task runner conformance',
    '',
    `${r.cases.length} cases, each a small workspace and the outcome a user sees: which commands ran, the files left on disk, the exit code. Every tool runs sandboxed. A tool that cannot express a case scores it \`–\` and it leaves its percentage.`,
    '',
    head,
    line('**all**', r.cases),
    line(
      'correctness',
      r.cases.filter((c) => c.kind === 'correctness'),
    ),
    line(
      'efficiency',
      r.cases.filter((c) => c.kind === 'efficiency'),
    ),
    ...categories.map((cat) =>
      line(
        cat,
        r.cases.filter((c) => c.category === cat),
      ),
    ),
    '',
    '## Where the cases come from',
    '',
    `Each case is drawn from vx's own tests. Of the ${r.coverage.ported + Object.values(r.coverage.rest).flat().length} test files in this repo:`,
    '',
    `- ${r.coverage.ported} are carried by a case;`,
    ...(Object.keys(VERDICTS) as Verdict[]).map(
      (v) => `- ${r.coverage.rest[v].length} are ${v}: ${VERDICTS[v]}.`,
    ),
    '',
    `## Where they differ (${differ.length})`,
    '',
    ...differ.map(caseBlock),
    ...(allFail.length > 0
      ? [`## Where every tool fails (${allFail.length})`, '', ...allFail.map(caseBlock)]
      : []),
    `## Where they agree (${r.cases.length - differ.length - allFail.length})`,
    '',
    ...r.cases
      .filter((c) => !differ.includes(c) && !allFail.includes(c))
      .map((c) => `- ${c.title} (\`${c.id}\`)`),
    '',
  ].join('\n')
}
