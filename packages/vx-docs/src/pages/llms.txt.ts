import type { APIRoute } from 'astro'
import { agentPages, isInternal, markdownUrl } from '../llms/pages.ts'

const SECTIONS: readonly [string, (id: string) => boolean][] = [
  ['Docs', (id) => id === 'quickstart' || id.startsWith('guides/') || id === 'playground'],
  ['Reference', (id) => !/^(blog|releases)\//.test(id) && !isInternal(id)],
  ['Blog', (id) => id.startsWith('blog/')],
  ['Releases', (id) => id.startsWith('releases/')],
  ['Internals (for contributors)', isInternal],
]

export const GET: APIRoute = async ({ site }) => {
  const base = new URL(import.meta.env.BASE_URL, site).href
  const pages = await agentPages()
  const seen = new Set<string>()
  const sections = SECTIONS.map(([name, owns]) => {
    const lines = pages
      .filter((p) => !seen.has(p.id) && owns(p.id))
      .map((p) => {
        seen.add(p.id)
        const note = p.data.description ? `: ${p.data.description}` : ''
        return `- [${p.data.title}](${markdownUrl(p, base)})${note}`
      })
    return `## ${name}\n\n${lines.join('\n')}`
  })
  const body = `# vx

> vx is a Bun-native task runner and content-addressed cache for JavaScript monorepos. Tasks live in TypeScript configs (\`vx.config.ts\`), a run is \`vx run <task>\`, and plugins decide where tasks run and where the cache lives.

Every page below is plain markdown. Every Docs and Reference page in one file: ${base}llms-full.txt. An agent in a vx workspace can also ask the workspace itself: \`vx mcp\`, and \`--format json\` on \`vx show\`, \`vx info\`, \`vx why\` and \`vx last\` (${base}guides/agents.md).

${sections.join('\n\n')}
`
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
