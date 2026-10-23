// A section's feed (the blog's, the Releases'), RSS 2.0 with each post in
// full. Written by hand: the format is a few elements, and `@astrojs/rss`
// would be a dependency for a string template.
import { posts, type Kind } from './posts.js'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const ABOUT: Record<Kind, [string, string]> = {
  blog: ['vx | Blog', 'Stories and design notes behind vx.'],
  releases: ['vx | Releases', 'What each vx release changed.'],
}

export async function feed(kind: Kind, site: URL | undefined): Promise<Response> {
  const root = new URL(import.meta.env.BASE_URL, site)
  const abs = (p: string): string => new URL(p, root).href
  // A site-absolute link or image in a post's HTML resolves against the
  // reader's origin, not this one; scripts and styles mean nothing in a feed.
  const body = (html: string): string =>
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '')
      .replace(/\b(href|src)="\/(?!\/)/g, `$1="${root.origin}/`)
  const items = (await posts(kind)).map((p) =>
    [
      '<item>',
      `<title>${esc(p.title)}</title>`,
      `<link>${abs(p.href)}</link>`,
      `<guid isPermaLink="true">${abs(p.href)}</guid>`,
      `<description>${esc(p.excerpt)}</description>`,
      `<pubDate>${p.date.toUTCString()}</pubDate>`,
      ...p.tags.map((t) => `<category>${esc(t)}</category>`),
      `<content:encoded>${esc(body(p.entry.rendered?.html ?? ''))}</content:encoded>`,
      '</item>',
    ].join(''),
  )
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${ABOUT[kind][0]}</title>`,
    `<description>${ABOUT[kind][1]}</description>`,
    `<link>${abs(`${kind}/`)}</link>`,
    '<language>en</language>',
    `<atom:link rel="self" type="application/rss+xml" href="${abs(`${kind}/rss.xml`)}"/>`,
    ...items,
    '</channel>',
    '</rss>',
  ].join('\n')
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } })
}
