import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'
import { defineCollection } from 'astro:content'
import { blogSchema } from 'starlight-blog/schema'

export const collections = {
  // Blog posts live in the docs collection under blog/; the extension adds
  // their frontmatter (date, authors, tags, excerpt, cover).
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({ extend: (context) => blogSchema(context) }),
  }),
}
