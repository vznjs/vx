import { satteri } from '@astrojs/markdown-satteri'
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import { readdirSync } from 'node:fs'
import { SIDEBAR } from './src/nav/sections.ts'
import { bench } from './src/plugins/bench.ts'
import { dataCharts } from './src/plugins/data-charts.ts'
import { mermaid } from './src/plugins/mermaid.ts'

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
    // Starlight's <Steps> and <Tabs> parse markdown at render time with
    // satteri, a native module: bundled into a page chunk, it looks for its
    // platform binding beside the chunk and finds none. Kept external, it
    // needs to be the site's own dependency (package.json) to resolve.
    build: { rollupOptions: { external: ['satteri'] } },
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
    '/docs/relay/': `${root}docs/servers/dte/`,
    '/docs/distributed-runs/': `${root}docs/distributed-task-execution/`,
    '/introduction/': `${root}quickstart/`,
    '/features/fastest/': `${root}features/benchmarks/`,
    '/features/vx-prune/': `${root}features/`,
    '/blog/vx-prune/': `${root}blog/`,
    '/blog/prune-production/': `${root}blog/`,
    '/add-to-existing-repo/': `${root}quickstart/`,
    '/guides/tasks/': `${root}docs/tasks/`,
    '/guides/task-dependencies/': `${root}docs/tasks/`,
    '/guides/caching/': `${root}docs/caching/`,
    '/guides/trusting-the-cache/': `${root}docs/caching/`,
    '/guides/environment-variables/': `${root}docs/environment-variables/`,
    '/guides/dev-tasks/': `${root}docs/dev-servers/`,
    '/guides/workspace-config/': `${root}docs/workspace/`,
    // Configure split into one page per feature (2026-10-23).
    '/guides/configure/': `${root}docs/workspace/`,
    '/guides/ci/': `${root}docs/ci/`,
    '/guides/sandboxing/': `${root}docs/sandboxing/`,
    '/guides/agents/': `${root}docs/agents/`,
    '/guides/plugins/': `${root}docs/plugins/`,
    '/guides/lockfiles/': `${root}docs/lockfiles/`,
    '/guides/running-tasks/': `${root}docs/running-tasks/`,
    '/guides/remote-caching/': `${root}docs/remote-cache/`,
    '/guides/remote-execution/': `${root}docs/remote-execution/`,
    '/guides/extensibility/': `${root}docs/plugins/`,
    '/guides/otel-bridge/': `${root}docs/plugins/#opentelemetry`,
    '/guides/mcp/': `${root}docs/agents/`,
    '/concepts/ai-first/': `${root}docs/agents/`,
    '/plugins/vx-mcp/': `${root}docs/agents/`,
    '/migrate/from-turborepo/': `${root}guides/migrate/#turborepo`,
    '/migrate/from-nx/': `${root}guides/migrate/#nx`,
    '/concepts/how-vx-works/': `${root}#plugins`,
    '/learn/what-is-task-orchestration/': `${root}#tasks`,
    '/learn/caching/': `${root}#cache`,
    '/learn/correctness/': `${root}#sandbox`,
    '/learn/scheduling/': `${root}#parallel`,
    '/learn/architecture/': `${root}#plugins`,
    '/learn/extending/': `${root}#plugins`,
    '/learn/playground/': `${root}quickstart/`,
    '/learn/labs/': `${root}quickstart/`,
    '/playground/': `${root}quickstart/`,
    '/blog/the-playground/': `${root}quickstart/`,
    '/features/playground/': `${root}quickstart/`,
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
    '/guide/try-it/': `${root}quickstart/`,
    '/guide/labs/': `${root}quickstart/`,
    '/benchmarks/real-repos/': `${root}benchmarks/`,
    // The blog's old listing pages (starlight-blog's pagination and author
    // page): the index now holds every post.
    '/blog/2/': `${root}blog/`,
    '/blog/3/': `${root}blog/`,
    '/blog/4/': `${root}blog/`,
    '/blog/5/': `${root}blog/`,
    '/blog/authors/vzn/': `${root}blog/`,
    // Posts folded into the one they repeated (blog is a knowledge base, 2026-10-13).
    '/blog/errors-that-say-the-fix/': `${root}blog/error-codes/#each-code-says-the-fix`,
    '/blog/schedule-strategy/': `${root}blog/scheduling-strategies/#pick-the-guess`,
    // Release notes moved out of the blog into their own section.
    '/blog/tags/release/': `${root}releases/`,
    '/blog/tags/essays/': `${root}blog/`,
    ...Object.fromEntries(
      readdirSync(new URL('./src/content/docs/releases/', import.meta.url))
        .filter((f) => f.endsWith('.md'))
        .map((f) => [`/blog/${f.slice(0, -3)}/`, `${root}releases/${f.slice(0, -3)}/`]),
    ),
  },
  // Astro's native Markdown pipeline, MDX included. A remark plugin moves
  // every page onto the JS `unified()` one: 10 s of a cold build's 17 s
  // content sync (2026-10-23).
  markdown: {
    processor: satteri({
      // bench first: the charts read the figures it fills in.
      mdastPlugins: [bench, mermaid, dataCharts],
      // `--filter` stays two hyphens, never an en dash.
      features: { smartPunctuation: { dashes: false } },
    }),
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
        baseUrl: 'https://github.com/vznjs/vx/edit/main/private/vx-docs/',
      },
      // Two sidebars (Docs, Reference) from one: src/nav/sections.ts
      // defines them as top-level groups, and src/nav/route-data.ts shows a
      // page only its own section's group.
      sidebar: SIDEBAR,
      routeMiddleware: './src/nav/route-data.ts',
    }),
  ],
})
