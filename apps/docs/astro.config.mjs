import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import remarkMermaid from './src/plugins/remark-mermaid.mjs'

// GitHub Pages project site: https://vznjs.github.io/vx/
// `base` is overridable via env so a custom domain (base '/') still builds.
const site = process.env.SITE_URL ?? 'https://vznjs.github.io'
const base = process.env.BASE_PATH ?? '/vx'

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  // `remarkPlugins` is deprecated in Astro 6 in favor of a `unified()`
  // processor from `@astrojs/markdown-remark`, but that package isn't
  // resolvable from the config and pinning its version against Astro is
  // fragile. The array form still works and only logs a future-major notice.
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
      components: {
        Head: './src/components/Head.astro',
      },
      customCss: ['./src/styles/theme.css'],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/vznjs/vx' },
      ],
      editLink: {
        baseUrl: 'https://github.com/vznjs/vx/edit/main/docs/',
      },
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Introduction', link: '/introduction/' },
            { label: 'Quickstart', link: '/quickstart/' },
            { label: 'Add vx to an existing repo', link: '/add-to-existing-repo/' },
          ],
        },
        {
          label: 'Build your monorepo',
          items: [
            { label: 'Configuring tasks', link: '/guides/tasks/' },
            { label: 'Caching tasks', link: '/guides/caching/' },
            { label: 'Task dependencies', link: '/guides/task-dependencies/' },
            { label: 'Running & filtering tasks', link: '/guides/running-tasks/' },
            { label: 'Dev & long-running tasks', link: '/guides/dev-tasks/' },
            { label: 'Environment variables', link: '/guides/environment-variables/' },
            { label: 'Remote caching', link: '/guides/remote-caching/' },
            { label: 'Continuous integration', link: '/guides/ci/' },
          ],
        },
        {
          label: 'Migrate to vx',
          items: [
            { label: 'From Turborepo', link: '/migrate/from-turborepo/' },
            { label: 'From Nx', link: '/migrate/from-nx/' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'How vx works', link: '/concepts/how-vx-works/' },
            { label: 'Why vx is fast', link: '/concepts/why-vx-is-fast/' },
            { label: 'Caching deep dive', link: '/caching/' },
            { label: 'Execution lifecycle', link: '/execution/' },
            { label: 'vx vs Turborepo vs Nx', link: '/comparison/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', link: '/cli/' },
            { label: 'Configuration', link: '/schema/' },
            { label: 'Benchmarks', link: '/benchmarks/' },
          ],
        },
        {
          label: 'Internals',
          collapsed: true,
          items: [
            { label: 'Architecture', link: '/architecture/' },
            { label: 'Optimizations', link: '/optimizations/' },
            { label: 'Shared patterns with Turbo / Nx', link: '/patterns/' },
            { label: 'Diagrams', link: '/flows/' },
            {
              label: 'Module reference',
              collapsed: true,
              items: [{ autogenerate: { directory: 'modules' } }],
            },
            {
              label: 'Design notes',
              collapsed: true,
              items: [{ autogenerate: { directory: 'design' } }],
            },
          ],
        },
      ],
    }),
  ],
})
