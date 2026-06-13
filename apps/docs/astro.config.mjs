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
          label: 'Start here',
          items: [
            { label: 'Introduction', link: '/overview/' },
            { label: 'Getting started', link: '/getting-started/' },
            { label: 'Why vx', link: '/differentiators/' },
          ],
        },
        {
          label: 'Core concepts',
          items: [
            { label: 'Architecture', link: '/architecture/' },
            { label: 'Execution lifecycle', link: '/execution/' },
            { label: 'Caching', link: '/caching/' },
            { label: 'Flows', link: '/flows/' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Configuration patterns', link: '/patterns/' },
            { label: 'Optimizations', link: '/optimizations/' },
            { label: 'Benchmarks', link: '/benchmarks/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', link: '/cli/' },
            { label: 'Config schema', link: '/schema/' },
            { label: 'vs Turbo / Nx', link: '/comparison/' },
          ],
        },
        {
          label: 'Modules',
          collapsed: true,
          items: [{ autogenerate: { directory: 'modules' } }],
        },
        {
          label: 'Design notes',
          collapsed: true,
          items: [{ autogenerate: { directory: 'design' } }],
        },
      ],
    }),
  ],
})
