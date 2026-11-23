import type { APIRoute } from 'astro'
import { agentPages, pageMarkdown, readingOrder } from '../llms/pages.ts'

/** Every docs page in llms.txt's reading order, so a reader cut short still has the start. */
export const GET: APIRoute = async ({ site }) => {
  const base = new URL(import.meta.env.BASE_URL, site).href
  const all = await agentPages()
  const ids = new Set(all.map((p) => p.id))
  const pages = readingOrder(all).flatMap(([, ps]) => ps)
  const body = pages.map((p) => pageMarkdown(p, base, ids)).join('\n---\n\n')
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
