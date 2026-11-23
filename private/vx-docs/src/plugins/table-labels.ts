import { defineHastPlugin } from 'satteri'

type El = { type: string; tagName?: string; children?: El[] }

const kids = (n: El, tag: string): El[] =>
  (n.children ?? []).filter((c) => c.type === 'element' && c.tagName === tag)

// Each body cell carries its column's name: on a phone a row stacks into a
// card and labels each value with it (styles/docs.css), so a wide table
// never scrolls sideways.
export const tableLabels = defineHastPlugin({
  name: 'vx-table-labels',
  element: {
    filter: ['table'],
    visit(node, ctx) {
      const table = node as unknown as El
      const headRow = kids(table, 'thead').flatMap((h) => kids(h, 'tr'))[0]
      if (!headRow) return
      const labels = kids(headRow, 'th').map((th) => ctx.textContent(th as never).trim())
      for (const tr of kids(table, 'tbody').flatMap((b) => kids(b, 'tr')))
        kids(tr, 'td').forEach((td, c) => {
          const label = labels[c]
          if (label) ctx.setProperty(td as never, 'dataLabel', label)
        })
    },
  },
})
