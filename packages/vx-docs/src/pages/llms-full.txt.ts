import type { APIRoute } from 'astro'
import { agentPages, isInternal, pageMarkdown } from '../llms/pages.ts'

export const GET: APIRoute = async () => {
  const pages = (await agentPages()).filter((p) => !p.id.startsWith('blog/') && !isInternal(p.id))
  const body = pages.map(pageMarkdown).join('\n---\n\n')
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
