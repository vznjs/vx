import { visit } from 'unist-util-visit'

const escapeHtml = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Replace ```mermaid fenced blocks with a <pre class="mermaid"> node carrying
// the (HTML-escaped) definition. The browser decodes the entities back into
// the original source when mermaid reads textContent, so escaping is lossless.
// Client-side rendering lives in src/components/Head.astro.
export default function remarkMermaid() {
  return (tree) => {
    visit(tree, 'code', (node, index, parent) => {
      if (!parent || index === null || index === undefined) return
      if ((node.lang ?? '').toLowerCase() !== 'mermaid') return
      parent.children[index] = {
        type: 'html',
        value: `<pre class="mermaid" role="img" aria-label="diagram">${escapeHtml(node.value)}</pre>`,
      }
    })
  }
}
