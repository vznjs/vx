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

/** `121 ms` / `36.0 s` in ms. */
function ms(cell: string): number {
  const m = /^([\d.]+) (ms|s)$/.exec(bare(cell))
  if (m === null) throw new Error(`real-repos.json: not a duration: ${cell}`)
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1)
}

/** Within this fraction of each other, two best-of-five figures are one: a rep's noise. */
const TIE = 0.02

/** "vx 11% faster", "vx 2.6× slower", "tie": N× from 2×, a percentage below it. */
export function verdict(vx: string, rival: string): string {
  const [a, b] = [ms(vx), ms(rival)]
  const [fast, slow] = a <= b ? [a, b] : [b, a]
  if (slow / fast <= 1 + TIE) return 'tie'
  // Rounded down, never claiming more than measured; divide last, as
  // (slow / fast - 1) * 100 lands on 56.99… for a 57% gap.
  const size =
    slow >= 2 * fast
      ? `${(Math.floor((slow * 10) / fast) / 10).toFixed(1)}×`
      : `${Math.floor(((slow - fast) * 100) / fast)}%`
  return `vx ${size} ${a <= b ? 'faster' : 'slower'}`
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
      out.set(`${s}.${arm}.vx`, bare(vx))
      out.set(`${s}.${arm}.rival`, `${bare(rival)} (${verdict(vx, rival)})`)
    }
  }
  return out
}
