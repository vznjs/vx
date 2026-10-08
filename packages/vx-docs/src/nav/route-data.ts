// Starlight's route middleware: each page sees the sidebar of its own section
// only, and its prev/next links stay inside that section. The section is the
// top-level group that lists the page; a page no group lists goes by its
// path: the blog's to the Blog, a release note's to Releases, and every
// other one, internals included, to the Reference, which is where the
// internals index is linked from. The blog and Releases have no sidebar, no
// table of contents and no prev/next: their pages are a listing and posts
// read one column wide (components/blog/).

import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data'
import { ogCover } from '../blog/og-cover.js'
import { GROUP_SECTION, type SectionId } from './sections.js'

type Entry = StarlightRouteData['sidebar'][number]
type Link = Extract<Entry, { type: 'link' }>

function links(entries: Entry[]): Link[] {
  return entries.flatMap((e) => (e.type === 'link' ? [e] : links(e.entries)))
}

/** A page's section from its route id (`blog/hello-vx`, `modules/cache`, `404`). */
function sectionByPath(id: string): SectionId {
  const top = id.split('/')[0]
  return top === 'blog' || top === 'releases' ? top : 'reference'
}

export const onRequest = defineRouteMiddleware(async (context) => {
  const route = context.locals.starlightRoute
  const groups = route.sidebar.filter((e) => e.type === 'group')
  const listed = groups.find((g) => links(g.entries).some((l) => l.isCurrent))
  const section = listed === undefined ? sectionByPath(route.id) : GROUP_SECTION[listed.label]!
  context.locals.vxSection = section
  if (section === 'blog' || section === 'releases') {
    route.hasSidebar = false
    route.toc = undefined
    route.pagination = { prev: undefined, next: undefined }
    await ogCover(route, context.site)
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
