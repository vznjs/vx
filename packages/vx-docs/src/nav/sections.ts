// The site's places (design/site-short-2026-09.md § The shape, plus the
// feature pages): the Docs and the Reference each have a sidebar of their
// own; the Blog, Releases, Features and the landing ('home', no place in the
// top nav) have none. Every page is a Starlight page, so one header, search
// and theme serve them all. The landing is the story; the Guide it replaced
// redirects there.
//
// Starlight has one sidebar. SIDEBAR is it, as two top-level groups whose
// labels are the section names; route-data.ts shows a page only the group its
// section owns. Internals (modules/, design/, overview, architecture,
// optimizations, patterns, flows) are in no group: the one way in is the
// "Internals (for contributors)" page at the end of the Reference.

import type { StarlightUserConfig } from '@astrojs/starlight/types'

export type SectionId = 'home' | 'features' | 'docs' | 'reference' | 'blog' | 'releases'

declare global {
  namespace App {
    interface Locals {
      /** Which place a page belongs to (route-data.ts). */
      vxSection: SectionId
    }
  }
}

/** The top navigation, in order. `href` is under the site's base. */
export const SECTIONS: readonly { id: SectionId; label: string; href: string }[] = [
  { id: 'features', label: 'Features', href: 'features/' },
  { id: 'docs', label: 'Docs', href: 'quickstart/' },
  { id: 'reference', label: 'Reference', href: 'cli/' },
  { id: 'blog', label: 'Blog', href: 'blog/' },
  { id: 'releases', label: 'Releases', href: 'releases/' },
]

type SidebarItem = NonNullable<StarlightUserConfig['sidebar']>[number]

/** Each sidebar section's items, keyed by the label its top-level group carries. */
const SIDEBAR_GROUPS: Record<'Docs' | 'Reference', SidebarItem[]> = {
  // Eight pages (design/site-short-2026-09.md § The shape, plus
  // Troubleshooting and Upgrading), each the goal in one line and short sections, then
  // the playground; the landing's diagram teaches the ideas.
  Docs: [
    { label: 'Quickstart', link: '/quickstart/' },
    { label: 'Configure', link: '/guides/configure/' },
    { label: 'Sandboxing', link: '/guides/sandboxing/' },
    { label: 'CI and remote', link: '/guides/ci/' },
    { label: 'Migrate', link: '/guides/migrate/' },
    { label: 'Plugins', link: '/guides/plugins/' },
    { label: 'AI agents', link: '/guides/agents/' },
    { label: 'Built for agents', link: '/concepts/ai-first/' },
    { label: 'Troubleshooting', link: '/guides/troubleshooting/' },
    { label: 'Upgrading to 1.0', link: '/guides/upgrading/' },
    { label: 'Try it', link: '/playground/' },
  ],
  // Short groups in plain words; Plugins is each published plugin's README.
  // The caching deep dive and "What a run does" are reference only; the
  // Docs' caching page links the first.
  Reference: [
    {
      label: 'CLI',
      items: [
        { label: 'Commands', link: '/cli/' },
        { label: 'Every feature', link: '/all-features/' },
        { label: 'What a run does', link: '/execution/' },
      ],
    },
    {
      label: 'Config',
      items: [
        { label: 'vx.config.ts', link: '/schema/' },
        { label: 'Caching in depth', link: '/caching/' },
        { label: '@vzn/vx API', link: '/api/' },
        { label: 'Security model', link: '/security/' },
      ],
    },
    {
      label: 'Benchmarks',
      items: [
        { label: 'The numbers', link: '/benchmarks/' },
        { label: 'Why vx is fast', link: '/concepts/why-vx-is-fast/' },
      ],
    },
    {
      label: 'Compare',
      items: [
        { label: 'vx, Turborepo, Nx, Bazel', link: '/compare/' },
        { label: 'vx vs Turborepo', link: '/compare/turborepo/' },
        { label: 'vx vs Nx', link: '/compare/nx/' },
        { label: 'vx vs Turborepo vs Nx', link: '/comparison/' },
        { label: 'Turbo / Nx parity map', link: '/parity/' },
        { label: 'Turbo / Nx config support', link: '/compare/turbo-nx-support/' },
        { label: 'Upstream bug ledger', link: '/upstream-ledger/' },
      ],
    },
    {
      label: 'Plugins',
      items: [
        { label: '@vzn/vx-ci', link: '/plugins/vx-ci/' },
        { label: '@vzn/vx-lockfile', link: '/plugins/vx-lockfile/' },
        { label: '@vzn/vx-mcp', link: '/plugins/vx-mcp/' },
        { label: '@vzn/vx-migrate', link: '/plugins/vx-migrate/' },
        { label: '@vzn/vx-otel', link: '/plugins/vx-otel/' },
        { label: '@vzn/vx-reapi', link: '/plugins/vx-reapi/' },
        { label: '@vzn/vx-schedule-history', link: '/plugins/vx-schedule-history/' },
      ],
    },
    { label: 'Glossary', link: '/glossary/' },
    { label: 'Internals (for contributors)', link: '/internals/' },
  ],
}

/** The sidebar Starlight is configured with (astro.config.mjs). */
export const SIDEBAR: SidebarItem[] = Object.entries(SIDEBAR_GROUPS).map(([label, items]) => ({
  label,
  items,
}))

/** The section a group label names. */
export const GROUP_SECTION: Record<string, SectionId> = {
  Docs: 'docs',
  Reference: 'reference',
}
