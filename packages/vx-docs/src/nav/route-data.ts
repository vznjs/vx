// Starlight's route middleware: each page sees the sidebar of its own section
// only, and its prev/next links stay inside that section. The section is the
// top-level group that lists the page; a page no group lists goes by its
// path: the blog's to the Blog, and every other one, internals included, to
// the Reference, which is where the internals index is linked from. The
// blog has no sidebar, no table of contents and no prev/next: its pages are
// a listing and posts read one column wide (components/blog/).

import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data'
import { getImage } from 'astro:assets'
import { GROUP_SECTION, type SectionId } from './sections.js'

type Entry = StarlightRouteData['sidebar'][number]
type Link = Extract<Entry, { type: 'link' }>

function links(entries: Entry[]): Link[] {
  return entries.flatMap((e) => (e.type === 'link' ? [e] : links(e.entries)))
}

/** A page's section from its route id (`blog/hello-vx`, `modules/cache`, `404`). */
function sectionByPath(id: string): SectionId {
  return id.split('/')[0] === 'blog' ? 'blog' : 'reference'
}

export const onRequest = defineRouteMiddleware(async (context) => {
  const route = context.locals.starlightRoute
  const groups = route.sidebar.filter((e) => e.type === 'group')
  const listed = groups.find((g) => links(g.entries).some((l) => l.isCurrent))
  const section = listed === undefined ? sectionByPath(route.id) : GROUP_SECTION[listed.label]!
  context.locals.vxSection = section
  if (section === 'blog') {
    route.hasSidebar = false
    route.toc = undefined
    route.pagination = { prev: undefined, next: undefined }
    // A shared post's card shows its cover, not the site's.
    const cover = route.entry.data.cover
    if (cover) {
      const img = await getImage({ src: cover.image, width: 1200, format: 'png' })
      const og = route.head.find((h) => h.attrs?.['property'] === 'og:image')!
      og.attrs = { ...og.attrs, content: new URL(img.src, context.site).href }
      const alt = route.head.find((h) => h.attrs?.['property'] === 'og:image:alt')!
      alt.attrs = { ...alt.attrs, content: cover.alt }
    }
    return
  }

  const own = groups.find((g) => GROUP_SECTION[g.label] === section)!
  route.sidebar = own.entries
  const flat = links(own.entries)
  const at = flat.findIndex((l) => l.isCurrent)
  route.pagination = {
    prev: at > 0 ? flat[at - 1] : undefined,
    next: at >= 0 ? flat[at + 1] : undefined,
  }
})
