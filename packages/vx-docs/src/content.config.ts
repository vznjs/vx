import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'
import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'
import { blogSchema } from 'starlight-blog/schema'

export const collections = {
  // Blog posts live in the docs collection under blog/; the extension adds
  // their frontmatter (date, authors, tags, excerpt, cover). A Guide chapter
  // (guide/) adds its number and the problem it opens with; the header reads
  // both from src/guide/chapters.ts, and tests/guide.test.ts holds the two
  // to agree.
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: (context) =>
        blogSchema(context).extend({
          chapter: z.number().int().min(1).optional(),
          problem: z.string().optional(),
        }),
    }),
  }),
}
