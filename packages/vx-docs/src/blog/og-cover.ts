// A shared post's card shows its cover, not the site's. Kept out of
// src/nav/ because `astro:assets` has types only after astro generates them,
// and the lint task type-checks src/nav/.

import { getImage } from 'astro:assets'
import type { StarlightRouteData } from '@astrojs/starlight/route-data'

export async function ogCover(route: StarlightRouteData, site: URL | undefined): Promise<void> {
  const cover = route.entry.data.cover
  if (!cover) return
  const img = await getImage({ src: cover.image, width: 1200, format: 'png' })
  const og = route.head.find((h) => h.attrs?.['property'] === 'og:image')!
  og.attrs = { ...og.attrs, content: new URL(img.src, site).href }
  const alt = route.head.find((h) => h.attrs?.['property'] === 'og:image:alt')!
  alt.attrs = { ...alt.attrs, content: cover.alt }
}
