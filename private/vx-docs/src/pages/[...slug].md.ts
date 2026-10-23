import type { APIRoute, GetStaticPaths } from 'astro'
import { agentPages, pageMarkdown, type Page } from '../llms/pages.ts'

export const getStaticPaths: GetStaticPaths = async () =>
  (await agentPages()).map((page) => ({ params: { slug: page.id }, props: { page } }))

export const GET: APIRoute = ({ props }) =>
  new Response(pageMarkdown((props as { page: Page }).page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
