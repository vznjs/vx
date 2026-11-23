import type { APIRoute, GetStaticPaths } from 'astro'
import { agentPages, pageMarkdown, type Page } from '../llms/pages.ts'

export const getStaticPaths: GetStaticPaths = async () => {
  const pages = await agentPages()
  const ids = new Set(pages.map((p) => p.id))
  return pages.map((page) => ({ params: { slug: page.id }, props: { page, ids } }))
}

export const GET: APIRoute = ({ props, site }) => {
  const { page, ids } = props as { page: Page; ids: ReadonlySet<string> }
  const base = new URL(import.meta.env.BASE_URL, site).href
  return new Response(pageMarkdown(page, base, ids), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
