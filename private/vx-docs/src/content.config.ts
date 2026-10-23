import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'
import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'

export const collections = {
  // Blog posts live in the docs collection under blog/, so Starlight renders
  // their bodies (search, code frames, diagrams); these are a post's own
  // fields, read by src/blog/posts.ts.
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: () =>
        z.object({
          date: z.date().optional(),
          authors: z.array(z.string()).optional(),
          tags: z.array(z.string()).optional(),
          excerpt: z.string().optional(),
          // A PNG under src/assets/blog/, resized by `build.images`.
          cover: z.object({ image: z.string(), alt: z.string() }).optional(),
        }),
    }),
  }),
}
