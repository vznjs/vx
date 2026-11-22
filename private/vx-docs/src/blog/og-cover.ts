// A shared post's card shows its cover, not the site's. Kept out of
// src/nav/ because `astro:content` has types only after astro generates them,
// and the lint task type-checks src/nav/.

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { StarlightRouteData } from '@astrojs/starlight/route-data'
import { imageUrl } from '../images.js'

// An essay's drawn cover is HTML; its 1200×630 render ships under
// public/blog/covers/<slug>.png (#3340) for link previews.
// Astro builds from the package root; a module URL points into the bundle.
const COVERS = path.resolve('public/blog/covers')

export async function ogCover(route: StarlightRouteData, site: URL | undefined): Promise<void> {
  // A post's search snippet and link preview are its excerpt: with no
  // `description`, Starlight gave all 120 posts and releases the site's.
  const { description, excerpt } = route.entry.data
  if (description === undefined && excerpt !== undefined)
    for (const h of route.head)
      if (h.attrs?.['name'] === 'description' || h.attrs?.['property'] === 'og:description')
        h.attrs = { ...h.attrs, content: excerpt }
  const cover = route.entry.data.cover
  const og = route.head.find((h) => h.attrs?.['property'] === 'og:image')!
  const alt = route.head.find((h) => h.attrs?.['property'] === 'og:image:alt')!
  if (cover) {
    const name = cover.image.replace(/^.*\//, '').replace(/\.png$/, '')
    og.attrs = { ...og.attrs, content: new URL(imageUrl(`blog/${name}`, 1200, 'png'), site).href }
    alt.attrs = { ...alt.attrs, content: cover.alt }
    return
  }
  const slug = route.id.replace(/^blog\//, '')
  if (slug === route.id || !existsSync(path.join(COVERS, `${slug}.png`))) return
  og.attrs = {
    ...og.attrs,
    content: new URL(
      `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}blog/covers/${slug}.png`,
      site,
    ).href,
  }
  alt.attrs = { ...alt.attrs, content: route.entry.data.title }
}
