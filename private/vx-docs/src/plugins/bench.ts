import { defineMdastPlugin } from 'satteri'
import { fillBench } from '../bench/data.ts'

// Fills each `%bench.…%` token with its measured figure (src/bench/format.ts)
// before the charts read a table, so a bar is drawn from the number shown.
// A dot, not a colon: with directives on, `:name` parses as a directive and
// splits the token across nodes.
export const bench = defineMdastPlugin({
  name: 'vx-bench',
  text(node, ctx) {
    if (node.value.includes('%bench.')) ctx.setProperty(node, 'value', fillBench(node.value))
  },
  inlineCode(node, ctx) {
    if (node.value.includes('%bench.')) ctx.setProperty(node, 'value', fillBench(node.value))
  },
})
