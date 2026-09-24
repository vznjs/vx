// Starlight's route middleware: each page sees the sidebar of its own section
// only, and its prev/next links stay inside that section. The section is the
// top-level group that lists the page; a page no group lists goes by its
// path: the Learn pages the Guide replaces (R4 redirects them) belong to the
// Guide, and every other one, internals included, to the Reference, which is
// where the internals index is linked from.

import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data'
import { GROUP_SECTION, type SectionId } from './sections.js'

type Entry = StarlightRouteData['sidebar'][number]
type Link = Extract<Entry, { type: 'link' }>

function links(entries: Entry[]): Link[] {
  return entries.flatMap((e) => (e.type === 'link' ? [e] : links(e.entries)))
}

/** A page's section from its route id (`guide/why`, `blog/hello-vx`, `404`). */
function sectionByPath(id: string): SectionId {
  const first = id.split('/')[0]
  if (first === 'blog') return 'blog'
  if (first === 'guide' || first === 'learn') return 'guide'
  return 'reference'
}

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute
  const groups = route.sidebar.filter((e) => e.type === 'group')
  const listed = groups.find((g) => links(g.entries).some((l) => l.isCurrent))
  const section = listed === undefined ? sectionByPath(route.id) : GROUP_SECTION[listed.label]!
  context.locals.vxSection = section
  // starlight-blog replaces the blog's sidebar after this runs.
  if (section === 'blog') return

  const own = groups.find((g) => GROUP_SECTION[g.label] === section)!
  route.sidebar = own.entries
  const flat = links(own.entries)
  const at = flat.findIndex((l) => l.isCurrent)
  route.pagination = {
    prev: at > 0 ? flat[at - 1] : undefined,
    next: at >= 0 ? flat[at + 1] : undefined,
  }
})
