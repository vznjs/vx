// The real-repo figures the site prints, from private/vx-bench/real-repos.json
// (`nightly.ts --json` writes it; real-repos.yml runs it weekly). Only the
// rows run on native config: the `turbo()` / `nx()` rows timed the bridge
// and are not quoted (STATUS, Positioning). Each figure is a
// `%bench.real.<repo>.…%` token, so every page and the agents' Markdown
// fill it the way they fill the head-to-head's.

export interface RealRow {
  repo: string
  tool: string
  version: string
  commit?: string
  machine?: string
  setup: string
  date: string
  cold: readonly string[]
  restore: readonly string[]
  noop: readonly string[]
}

const ARMS = ['cold', 'restore', 'noop'] as const
const TOOL_NAMES: Record<string, string> = { Turbo: 'Turbo', Nx: 'Nx' }

const bare = (cell: string): string => cell.replaceAll('**', '')

/** The cell, unstarred; a cell that is no duration is refused. */
function duration(cell: string): string {
  const d = bare(cell)
  if (!/^[\d.]+ (ms|s)$/.test(d)) throw new Error(`real-repos.json: not a duration: ${cell}`)
  return d
}

/** `solidjs/solid` → `solid`, the name a token uses. */
const slug = (repo: string): string => repo.slice(repo.indexOf('/') + 1).toLowerCase()

/** Every `real.<slug>.…` figure of the native-config rows. */
export function realFigures(rows: readonly RealRow[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of rows) {
    if (!row.setup.startsWith('native config')) continue
    const s = `real.${slug(row.repo)}`
    out.set(`${s}.tool`, `${TOOL_NAMES[row.tool] ?? row.tool} ${row.version}`)
    out.set(`${s}.rival`, TOOL_NAMES[row.tool] ?? row.tool)
    out.set(`${s}.commit`, row.commit?.slice(0, 7) ?? 'unpinned')
    out.set(`${s}.date`, row.date)
    out.set(`${s}.machine`, row.machine ?? 'machine not recorded')
    for (const arm of ARMS) {
      const [vx = '', rival = ''] = row[arm]
      out.set(`${s}.${arm}.vx`, duration(vx))
      out.set(`${s}.${arm}.rival`, duration(rival))
    }
  }
  return out
}
