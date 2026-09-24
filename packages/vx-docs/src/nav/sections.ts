// The site's four places (design/site-redo-2026-09.md § The site around the
// story): the Guide, the Docs and the Reference each have a sidebar of their
// own, and the Blog has the one starlight-blog gives it.
//
// Starlight has one sidebar. SIDEBAR is it, as three top-level groups whose
// labels are the section names; route-data.ts shows a page only the group its
// section owns. Internals (modules/, design/, overview, architecture,
// optimizations, patterns, flows) are in no group: the one way in is the
// "Internals (for contributors)" page at the end of the Reference.

import type { StarlightUserConfig } from '@astrojs/starlight/types'
import { CHAPTERS } from '../guide/chapters.js'

export type SectionId = 'guide' | 'docs' | 'reference' | 'blog'

declare global {
  namespace App {
    interface Locals {
      /** Which of the four places the page belongs to (route-data.ts). */
      vxSection: SectionId
    }
  }
}

/** The top navigation, in order. `href` is under the site's base. */
export const SECTIONS: readonly { id: SectionId; label: string; href: string }[] = [
  { id: 'guide', label: 'Guide', href: 'guide/why/' },
  { id: 'docs', label: 'Docs', href: 'quickstart/' },
  { id: 'reference', label: 'Reference', href: 'cli/' },
  { id: 'blog', label: 'Blog', href: 'blog/' },
]

type SidebarItem = NonNullable<StarlightUserConfig['sidebar']>[number]

/** Each sidebar section's items, keyed by the label its top-level group carries. */
const SIDEBAR_GROUPS: Record<'Guide' | 'Docs' | 'Reference', SidebarItem[]> = {
  Guide: CHAPTERS.map((c) => ({ label: c.title, link: `/guide/${c.slug}/` })),
  // Six pages (design/site-short-2026-09.md § The shape), each the goal in
  // one line and short sections; the landing's diagram teaches the ideas.
  Docs: [
    { label: 'Quickstart', link: '/quickstart/' },
    { label: 'Configure', link: '/guides/configure/' },
    { label: 'Sandboxing', link: '/guides/sandboxing/' },
    { label: 'CI and remote', link: '/guides/ci/' },
    { label: 'Migrate', link: '/guides/migrate/' },
    { label: 'Plugins', link: '/guides/plugins/' },
  ],
  // Four short groups in plain words. The caching deep dive and "What a run
  // does" are reference only; the Docs' caching page links the first.
  Reference: [
    {
      label: 'CLI',
      items: [
        { label: 'Commands', link: '/cli/' },
        { label: 'What a run does', link: '/execution/' },
      ],
    },
    {
      label: 'Config',
      items: [
        { label: 'vx.config.ts', link: '/schema/' },
        { label: 'Caching in depth', link: '/caching/' },
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
        { label: 'vx vs Turborepo vs Nx', link: '/comparison/' },
        { label: 'Turbo / Nx parity map', link: '/parity/' },
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
  Guide: 'guide',
  Docs: 'docs',
  Reference: 'reference',
}
