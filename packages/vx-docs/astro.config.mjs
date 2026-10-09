import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import { readdirSync } from 'node:fs'
import { SIDEBAR } from './src/nav/sections.ts'
import remarkDataCharts from './src/plugins/data-charts.ts'
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
  vite: {
    cacheDir: './.astro/vite',
    // The site has no PostCSS config. Without an inline one Vite searches
    // every parent up to the workspace root, reading the root package.json
    // the build's sandbox hides: Linux answers ENOENT and the search goes
    // on, macOS's seatbelt answers EPERM and the build failed.
    css: { postcss: {} },
  },
  site,
  base,
  trailingSlash: 'always',
  // Docs pages the six took in, the old Learn pages, and the Guide's
  // chapters, which the landing's one picture replaced
  // (design/site-short-2026-09.md): the old URL lands on the new page and
  // section, and a chapter on the landing's line for the idea it taught.
  // Each old URL goes straight to where it ends, never through another
  // redirect. tests/redirects.test.ts holds every URL the old sidebar and
  // the Guide linked. Astro puts the base on the old path but not on the
  // target.
  redirects: {
    '/introduction/': `${root}quickstart/`,
    '/add-to-existing-repo/': `${root}quickstart/#an-existing-repo`,
    '/guides/tasks/': `${root}guides/configure/#tasks-and-dependencies`,
    '/guides/task-dependencies/': `${root}guides/configure/#tasks-and-dependencies`,
    '/guides/caching/': `${root}guides/configure/#caching`,
    '/guides/trusting-the-cache/': `${root}guides/configure/#caching`,
    '/guides/environment-variables/': `${root}guides/configure/#environment-variables`,
    '/guides/dev-tasks/': `${root}guides/configure/#dev-tasks`,
    '/guides/workspace-config/': `${root}guides/configure/#workspace-config`,
    '/guides/lockfiles/': `${root}guides/configure/#lockfiles`,
    '/guides/running-tasks/': `${root}guides/ci/#run-and-filter`,
    '/guides/remote-caching/': `${root}guides/ci/#remote-cache`,
    '/guides/remote-execution/': `${root}guides/ci/#remote-execution`,
    '/guides/extensibility/': `${root}guides/plugins/`,
    '/guides/otel-bridge/': `${root}guides/plugins/#opentelemetry`,
    '/guides/mcp/': `${root}guides/plugins/#vx-mcp`,
    '/migrate/from-turborepo/': `${root}guides/migrate/#turborepo`,
    '/migrate/from-nx/': `${root}guides/migrate/#nx`,
    '/concepts/how-vx-works/': `${root}#plugins`,
    '/learn/what-is-task-orchestration/': `${root}#tasks`,
    '/learn/caching/': `${root}#cache`,
    '/learn/correctness/': `${root}#sandbox`,
    '/learn/scheduling/': `${root}#parallel`,
    '/learn/architecture/': `${root}#plugins`,
    '/learn/extending/': `${root}#plugins`,
    '/learn/playground/': `${root}playground/`,
    '/learn/labs/': `${root}playground/`,
    '/learn/choosing/': `${root}compare/`,
    '/learn/glossary/': `${root}glossary/`,
    '/guide/why/': `${root}#one-run`,
    '/guide/tasks/': `${root}#tasks`,
    '/guide/dependencies/': `${root}#tasks`,
    '/guide/concurrency/': `${root}#parallel`,
    '/guide/caching/': `${root}#cache`,
    '/guide/trust/': `${root}#sandbox`,
    '/guide/affected/': `${root}#changed`,
    '/guide/many-machines/': `${root}#extensible`,
    '/guide/inside-vx/': `${root}#plugins`,
    '/guide/try-it/': `${root}playground/`,
    '/guide/labs/': `${root}playground/`,
    '/benchmarks/real-repos/': `${root}benchmarks/`,
    // The blog's old listing pages (starlight-blog's pagination and author
    // page): the index now holds every post.
    '/blog/2/': `${root}blog/`,
    '/blog/3/': `${root}blog/`,
    '/blog/4/': `${root}blog/`,
    '/blog/5/': `${root}blog/`,
    '/blog/authors/vzn/': `${root}blog/`,
    // Release notes moved out of the blog into their own section.
    '/blog/tags/release/': `${root}releases/`,
    '/blog/tags/essays/': `${root}blog/`,
    ...Object.fromEntries(
      readdirSync(new URL('./src/content/docs/releases/', import.meta.url))
        .filter((f) => f.endsWith('.md'))
        .map((f) => [`/blog/${f.slice(0, -3)}/`, `${root}releases/${f.slice(0, -3)}/`]),
    ),
  },
  // `remarkPlugins` runs on the `unified()` processor from
  // `@astrojs/markdown-remark`, an optional peer since Astro 7 that the
  // site declares itself: without it the build refuses to start (CI,
  // 2026-09-10), and a stale copy in the store hid that locally.
  markdown: {
    remarkPlugins: [remarkMermaid, remarkDataCharts],
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
      // The card a shared link shows (X, Slack, Discord): Starlight writes
      // og:title, og:description and twitter:card, never an image.
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: `${site}${root}og.png` } },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:alt',
            content: 'vx: a faster runner for your Turborepo or Nx repo',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'alternate',
            type: 'application/rss+xml',
            title: 'vx | Blog',
            href: `${site}${root}blog/rss.xml`,
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'alternate',
            type: 'application/rss+xml',
            title: 'vx | Releases',
            href: `${site}${root}releases/rss.xml`,
          },
        },
      ],
      // The site's chrome: the places in the header (and atop the phone
      // menu), the landing's fonts, and dark as the default theme. The blog's
      // and releases' posts take a hero and related posts here
      // (src/components/blog/); their indexes, tag pages and feeds are
      // src/pages/blog/ and src/pages/releases/.
      components: {
        Head: './src/components/Head.astro',
        Footer: './src/components/starlight/Footer.astro',
        Header: './src/components/starlight/Header.astro',
        PageTitle: './src/components/starlight/PageTitle.astro',
        Sidebar: './src/components/starlight/Sidebar.astro',
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
      },
      customCss: ['./src/styles/theme.css', './src/styles/charts.css', './src/styles/blog.css'],
      // A code block wraps rather than scrolls: on a phone the end of a
      // command hid past the edge, and nothing said it was there.
      expressiveCode: { defaultProps: { wrap: true } },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/vznjs/vx' },
        { icon: 'blueSky', label: 'Bluesky', href: 'https://bsky.app/profile/vzn-vx.bsky.social' },
        // Starlight has no dev.to icon; a pen reads as "articles".
        { icon: 'pen', label: 'dev.to', href: 'https://dev.to/vzn-vx' },
        { icon: 'rss', label: 'RSS', href: `${site}${root}blog/rss.xml` },
      ],
      // Hand-authored pages live here; imported pages carry their own
      // `editUrl` (scripts/import-docs.ts) pointing at packages/vx/docs/.
      editLink: {
        baseUrl: 'https://github.com/vznjs/vx/edit/main/packages/vx-docs/',
      },
      // Two sidebars (Docs, Reference) from one: src/nav/sections.ts
      // defines them as top-level groups, and src/nav/route-data.ts shows a
      // page only its own section's group.
      sidebar: SIDEBAR,
      routeMiddleware: './src/nav/route-data.ts',
    }),
  ],
})
