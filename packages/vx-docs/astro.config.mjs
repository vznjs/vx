import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
// The blog: announcement posts under /blog/, an RSS feed, authors and
// tags, rendered in Starlight's own chrome. Posts are Markdown files in
// src/content/docs/blog/ (see README.md § Writing a blog post). The
// plugin is the maintained Starlight blog (HiDeoo); hand-rolling the
// index, pagination, RSS and structured data would be a second copy of
// what it already does for this exact Starlight version.
import starlightBlog from 'starlight-blog'
import { SIDEBAR } from './src/nav/sections.ts'
import remarkMermaid from './src/plugins/remark-mermaid.mjs'

// GitHub Pages project site: https://vznjs.github.io/vx/
// `base` is overridable via env so a custom domain (base '/') still builds.
const site = process.env.SITE_URL ?? 'https://vznjs.github.io'
const base = process.env.BASE_PATH ?? '/vx'
const root = base.replace(/\/?$/, '/')

export default defineConfig({
  // Both caches under `.astro/`, not node_modules: see the `build` task's
  // sandbox grants in vx.config.ts for why a write under node_modules breaks
  // module resolution inside the Linux sandbox.
  cacheDir: './.astro/cache',
  // `satteri` (starlight-blog's Markdown engine) loads a native binding at
  // runtime; bundled into a prerender chunk under dist/ that `require` has
  // nowhere to resolve from in Bun's isolated install layout. Kept external
  // — and declared here so it resolves from this package — it loads from
  // its real path in the store, where its platform package is linked.
  //
  // `import.meta.main` is Bun's "this file is the entry point", and no module
  // the site bundles ever is. The scheduler simulator imports
  // packages/vx-bench/schedule-policy.ts, whose report runs only under it:
  // defined false, the report and its `process` calls are dropped from the
  // browser bundle instead of shipped as dead code.
  vite: {
    cacheDir: './.astro/vite',
    ssr: { external: ['satteri'] },
    define: { 'import.meta.main': 'false' },
  },
  site,
  base,
  trailingSlash: 'always',
  // Docs pages merged into another page, and one that became a Guide
  // chapter (design/site-redo-2026-09.md): the old URL lands on the new
  // one. tests/redirects.test.ts holds every URL the old sidebar linked.
  // Astro puts the base on the old path but not on the target.
  redirects: {
    '/introduction/': `${root}quickstart/`,
    '/guides/trusting-the-cache/': `${root}guides/caching/`,
    '/guides/task-dependencies/': `${root}guides/tasks/`,
    '/guides/extensibility/': `${root}guides/plugins/`,
    '/concepts/how-vx-works/': `${root}guide/inside-vx/`,
  },
  // `remarkPlugins` runs on the `unified()` processor from
  // `@astrojs/markdown-remark`, an optional peer since Astro 7 that the
  // site declares itself: without it the build refuses to start (CI,
  // 2026-09-10), and a stale copy in the store hid that locally.
  markdown: {
    remarkPlugins: [remarkMermaid],
  },
  integrations: [
    starlight({
      title: 'vx',
      description:
        'A content-addressed cache and task scheduler for JavaScript monorepos, built Bun-native.',
      logo: {
        src: './src/assets/logo.svg',
        alt: 'vx',
        replacesTitle: false,
      },
      favicon: '/favicon.svg',
      // The site's chrome: the four places in the header (and atop the phone
      // menu), the chapter header and Next card on Guide pages, the landing's
      // fonts, and dark as the default theme.
      components: {
        Head: './src/components/Head.astro',
        Header: './src/components/starlight/Header.astro',
        Sidebar: './src/components/starlight/Sidebar.astro',
        PageTitle: './src/components/starlight/PageTitle.astro',
        Footer: './src/components/starlight/Footer.astro',
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
      },
      customCss: ['./src/styles/theme.css'],
      plugins: [
        starlightBlog({
          title: 'Blog',
          prefix: 'blog',
          // The header's own nav links the blog (src/nav/sections.ts).
          navigation: 'none',
          postCount: 10,
          recentPostCount: 5,
          authors: {
            vzn: { name: 'vzn', title: 'vx maintainer', url: 'https://github.com/vznjs' },
          },
        }),
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/vznjs/vx' }],
      // Hand-authored pages live here; imported pages carry their own
      // `editUrl` (scripts/import-docs.ts) pointing at packages/vx/docs/.
      editLink: {
        baseUrl: 'https://github.com/vznjs/vx/edit/main/packages/vx-docs/',
      },
      // Three sidebars (Guide, Docs, Reference) from one: src/nav/sections.ts
      // defines them as top-level groups, and src/nav/route-data.ts shows a
      // page only its own section's group.
      sidebar: SIDEBAR,
      routeMiddleware: './src/nav/route-data.ts',
    }),
  ],
})
