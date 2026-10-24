// Timing tables drawn as bars (src/plugins/data-charts.ts): every way the
// docs write a duration, which tables become charts and how they group, and
// the Markdown a chart replaces staying one click away.

import { describe, expect, it } from 'bun:test'
import {
  dataCharts,
  figureColumns,
  groupsForTable,
  parseDuration,
  renderBars,
} from '../src/plugins/data-charts.ts'
import { markdownToHtml } from 'satteri'

describe('figureColumns', () => {
  it('marks a column right only when every filled cell is a figure', () => {
    expect(
      figureColumns([
        ['default', '120.5 s', '86%', '$1,016', 'best-fit'],
        ['fifo', '348.9 s', '', '~2 min (warm)', '10'],
      ]),
    ).toEqual([false, true, true, true, false])
  })
})

describe('parseDuration', () => {
  it.each([
    ['476 ms', 476],
    ['476ms', 476],
    ['1,712 ms', 1712],
    ['14 181 ms (13 798–14 986)', 14_181],
    ['3.1 ms', 3.1],
    ['3.59 s', 3590],
    ['1.17s (vx 36× faster)', 1170],
    ['9 s', 9000],
    ['3m 47s', 227_000],
    ['114m 06s (vx 99× faster)', 6_846_000],
    ['1 min 35 s (vx 91× faster)', 95_000],
    ['31 min', 1_860_000],
    ['380–450 ms', 415],
  ])('%s → %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms)
  })

  it.each(['0.0.0', '2.10.12', '1000', '—', 'git walk 67ms', '8.5×', '76 msx'])(
    '%s is not a duration',
    (text) => {
      expect(parseDuration(text)).toBeNull()
    },
  )
})

describe('groupsForTable', () => {
  it('runners down the side: a group per timed column, vx leading', () => {
    const groups = groupsForTable(
      ['Runner', 'Version', 'Fresh (cold)', 'Warm'],
      [
        ['vx', '0.0.0', '10.29 s', '79 ms'],
        ['turbo', '2.11.3', '10.43 s (vx 1× faster)', '86 ms (vx 8× faster)'],
      ],
    )
    expect(groups).toEqual([
      {
        title: 'Fresh (cold)',
        bars: [
          { name: 'vx', ms: 10_290, value: '10.29 s', hero: true },
          { name: 'turbo', ms: 10_430, value: '10.43 s', note: 'vx 1× faster', hero: false },
        ],
      },
      {
        title: 'Warm',
        bars: [
          { name: 'vx', ms: 79, value: '79 ms', hero: true },
          { name: 'turbo', ms: 86, value: '86 ms', note: 'vx 8× faster', hero: false },
        ],
      },
    ])
  })

  it('runners across the top: a group per row, a blank cell left out', () => {
    const groups = groupsForTable(
      ['', 'vx', 'vx, no lock', 'Nx'],
      [['Warm', '476ms', '—', '3.59s (vx 86× faster)']],
    )
    expect(groups).toEqual([
      {
        title: 'Warm',
        bars: [
          { name: 'vx', ms: 476, value: '476ms', hero: true },
          { name: 'Nx', ms: 3590, value: '3.59s', note: 'vx 86× faster', hero: false },
        ],
      },
    ])
  })

  it('no runner named: every bar is vx', () => {
    const groups = groupsForTable(
      ['Milestone', 'No-restore'],
      [
        ['before', '10.2 s'],
        ['after', '0.62 s'],
      ],
    )
    expect(groups.flatMap((g) => g.bars.map((b) => b.hero))).toEqual([true, true])
  })

  it('a column with one cell that is not a time, or a table of words, draws nothing', () => {
    expect(
      groupsForTable(
        ['Runner', 'Cold'],
        [
          ['vx', '1 s'],
          ['nx', 'n/a'],
        ],
      ),
    ).toEqual([])
    expect(groupsForTable(['Flag', 'Does'], [['--force', 'run everything']])).toEqual([])
  })
})

describe('renderBars', () => {
  it('sizes each bar against the slowest in its group and escapes text', () => {
    const html = renderBars([
      {
        title: 'a<b',
        bars: [
          { name: 'vx', ms: 25, value: '25 ms', hero: true },
          { name: 'nx', ms: 100, value: '100 ms', note: 'vx 75× faster' },
        ],
      },
    ])
    expect([...html.matchAll(/--w:([\d.]+)%/g)].map((m) => m[1])).toEqual(['25', '100'])
    expect(html).toContain('<figcaption>a&lt;b</figcaption>')
    expect(html).toContain('<div class="vx-bar vx-bar-lead"')
    expect(html).toContain('<span class="vx-bar-note">vx 75× faster</span>')
  })
})

describe('dataCharts', () => {
  const TABLE = '| Runner | Cold |\n| --- | --- |\n| vx | 1 s |\n| nx | 4 s |\n'
  const html = (md: string): string =>
    markdownToHtml(md, { mdastPlugins: [dataCharts], features: { directive: true } }).html

  it('puts the chart before the table and the table in a details', () => {
    const out = html(TABLE)
    expect(out).toStartWith('<div class="vx-charts">')
    expect(out).toContain(
      '</div>\n<details class="vx-chart-table"><summary>The table</summary>\n<div class="vx-table-scroll">\n<table>',
    )
    expect(out.trimEnd()).toEndWith('</table>\n</div>\n</details>')
  })

  it('reads "(+0:09)", a text directive to the parser, as written', () => {
    expect(html(TABLE.replace('1 s', '1 s (+0:09)'))).toContain(
      '<span class="vx-bar-note">+0:09</span>',
    )
  })

  it('leaves a table quoted as sample output alone', () => {
    const out = html(TABLE.replace(/^/gm, '> ').replace(/> $/, ''))
    expect(out).not.toContain('vx-charts')
    expect(out).toContain('<blockquote>')
  })

  it('wraps a table that draws no chart in the scroller too', () => {
    const out = html('| Kind | What |\n| --- | --- |\n| file | a path |\n')
    expect(out).not.toContain('vx-charts')
    expect(out.trimEnd()).toStartWith('<div class="vx-table-scroll">\n<table>')
    expect(out.trimEnd()).toEndWith('</table>\n</div>')
  })
})
