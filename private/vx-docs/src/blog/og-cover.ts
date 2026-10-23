// A shared post's card shows its cover, not the site's. Kept out of
// src/nav/ because `astro:assets` has types only after astro generates them,
// and the lint task type-checks src/nav/.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { getImage } from 'astro:assets'
import type { StarlightRouteData } from '@astrojs/starlight/route-data'

// An essay's drawn cover is HTML; its 1200×630 render ships under
// public/blog/covers/<slug>.png (#3340) for link previews.
// Astro builds from the package root; a module URL points into the bundle.
const COVERS = path.resolve('public/blog/covers')

export async function ogCover(route: StarlightRouteData, site: URL | undefined): Promise<void> {
  const cover = route.entry.data.cover
  const og = route.head.find((h) => h.attrs?.['property'] === 'og:image')!
  const alt = route.head.find((h) => h.attrs?.['property'] === 'og:image:alt')!
  if (cover) {
    const img = await getImage({ src: cover.image, width: 1200, format: 'png' })
    og.attrs = { ...og.attrs, content: new URL(img.src, site).href }
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
