import { defineMdastPlugin } from 'satteri'

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Replace ```mermaid fenced blocks with a <pre class="mermaid"> node carrying
// the (HTML-escaped) definition. The browser decodes the entities back into
// the original source when mermaid reads textContent, so escaping is lossless.
// Client-side rendering lives in src/components/Head.astro.
export const mermaid = defineMdastPlugin({
  name: 'vx-mermaid',
  code(node, ctx) {
    if ((node.lang ?? '').toLowerCase() !== 'mermaid') return
    ctx.replaceNode(node, {
      type: 'html',
      value: `<pre class="mermaid" role="img" aria-label="diagram">${escapeHtml(node.value)}</pre>`,
    })
  },
})
