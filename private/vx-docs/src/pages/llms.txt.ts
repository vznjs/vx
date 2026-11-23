import type { APIRoute } from 'astro'
import { agentPages, isInternal, markdownUrl, readingOrder, type Page } from '../llms/pages.ts'

export const GET: APIRoute = async ({ site }) => {
  const base = new URL(import.meta.env.BASE_URL, site).href
  const pages = await agentPages()
  const line = (p: Page): string => {
    const note = p.data.description ? `: ${p.data.description}` : ''
    return `- [${p.data.title}](${markdownUrl(p, base)})${note}`
  }
  const docs = readingOrder(pages)
  const listed = new Set(docs.flatMap(([, ps]) => ps.map((p) => p.id)))
  const sections: [string, Page[]][] = [
    ...docs,
    ['Blog', pages.filter((p) => p.id.startsWith('blog/'))],
    ['Releases', pages.filter((p) => p.id.startsWith('releases/'))],
    ['How vx is built', pages.filter((p) => isInternal(p.id) && !listed.has(p.id))],
  ]
  const body = `# vx

> vx is a Bun-native task runner and content-addressed cache for JavaScript monorepos. Tasks live in TypeScript configs (\`vx.config.ts\`), a run is \`vx run <task>\`, and plugins decide where tasks run and where the cache lives.

Every page below is plain markdown, the docs in reading order: start with the Quickstart, then AI agents. The docs in one file, in the same order: ${base}llms-full.txt. In a vx workspace, \`bunx skills add vznjs/vx\` installs the vx skill, and \`--format json\` on \`vx show\`, \`vx info\`, \`vx why\` and \`vx last\` answers from the workspace itself (${base}docs/agents.md).

${sections
  .filter(([, ps]) => ps.length > 0)
  .map(([name, ps]) => `## ${name}\n\n${ps.map(line).join('\n')}`)
  .join('\n\n')}
`
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
