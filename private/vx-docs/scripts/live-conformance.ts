// The conformance results main's deploy builds the site from
// (deploy.pages.build): the committed src/data/conformance.json, with every other
// tool's outcomes and version taken from the newest weekly run
// (conformance.yml's `conformance-data` artifact), which scores the rivals
// at npm's latest (2026-11-21). vx's column stays the committed one, the
// commit's own: the weekly run fails when vx fails a case. A case added
// since that run keeps its committed row, and so does a rival's committed
// N/A: it is the adapter's `lacks` at this commit, which a run older than
// the commit had not seen (2026-11-23). No run yet: the committed copy.

import type { Case, Results, Score } from '../src/conformance/data.ts'
import { newestArtifact, type LiveEnv } from './live-bench.ts'

// As @vzn/vx-conformance's report.ts scores (restated: the site reads no
// other private package): every case counts, one a tool cannot express too.
function score(rows: Case[], tool: string): Score {
  return {
    pass: rows.filter((r) => r.outcomes[tool]?.status === 'pass').length,
    can: rows.filter((r) => r.outcomes[tool]?.status !== 'n/a').length,
    of: rows.length,
  }
}

function scores(tools: string[], rows: Case[]): Results['scores'] {
  const groups: [string, Case[]][] = [
    ['all', rows],
    ...[...new Set(rows.map((r) => r.kind))].map((k): [string, Case[]] => [
      k,
      rows.filter((r) => r.kind === k),
    ]),
    ...[...new Set(rows.map((r) => r.category))].map((c): [string, Case[]] => [
      c,
      rows.filter((r) => r.category === c),
    ]),
  ]
  return Object.fromEntries(
    tools.map((t) => [t, Object.fromEntries(groups.map(([g, rs]) => [g, score(rs, t)]))]),
  )
}

export function merge(committed: Results, weekly: Results): Results {
  const ran = new Map(weekly.cases.map((c) => [c.id, c]))
  const rivals = Object.keys(weekly.tools).filter((t) => t !== 'vx' && t in committed.tools)
  const cases = committed.cases.map((c) => {
    const w = ran.get(c.id)
    if (!w) return c
    const outcomes = { ...c.outcomes }
    for (const t of rivals)
      if (w.outcomes[t] && outcomes[t]?.status !== 'n/a') outcomes[t] = w.outcomes[t]
    return { ...c, outcomes }
  })
  const tools = { ...committed.tools }
  for (const t of rivals) tools[t] = weekly.tools[t]!
  return { ...committed, tools, scores: scores(Object.keys(tools), cases), cases }
}

if (import.meta.main) {
  const env = process.env
  const missing = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'].filter((k) => !env[k])
  if (missing.length > 0) throw new Error(`live-conformance: ${missing.join(', ')} not set`)
  const committed = (await Bun.file('src/data/conformance.json').json()) as Results
  const found = await newestArtifact(
    env as unknown as LiveEnv,
    'conformance-data',
    'conformance.json',
  )
  const results = found ? merge(committed, JSON.parse(found.json) as Results) : committed
  await Bun.write('measured/live-conformance.json', JSON.stringify(results))
  console.log(
    found
      ? `live-conformance: measured/live-conformance.json from Conformance run ${found.run}`
      : 'live-conformance: no Conformance run on main yet, the committed results',
  )
}
