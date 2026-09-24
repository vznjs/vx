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
  // One page per job, each page the goal, the steps, the config and its
  // common problems. The Guide teaches why; a Docs page links its chapter.
  Docs: [
    {
      label: 'Get started',
      items: [
        { label: 'Quickstart', link: '/quickstart/' },
        { label: 'Add vx to an existing repo', link: '/add-to-existing-repo/' },
        { label: 'From Turborepo', link: '/migrate/from-turborepo/' },
        { label: 'From Nx', link: '/migrate/from-nx/' },
      ],
    },
    {
      label: 'Configure',
      items: [
        { label: 'Tasks and dependencies', link: '/guides/tasks/' },
        { label: 'Caching', link: '/guides/caching/' },
        { label: 'Environment variables', link: '/guides/environment-variables/' },
        { label: 'Sandboxing tasks', link: '/guides/sandboxing/' },
        { label: 'Dev & long-running tasks', link: '/guides/dev-tasks/' },
        { label: 'Lockfile-aware caching', link: '/guides/lockfiles/' },
        { label: 'Workspace configuration', link: '/guides/workspace-config/' },
      ],
    },
    {
      label: 'Run',
      items: [
        { label: 'Running & filtering tasks', link: '/guides/running-tasks/' },
        { label: 'Continuous integration', link: '/guides/ci/' },
        { label: 'Remote caching', link: '/guides/remote-caching/' },
        { label: 'Remote execution', link: '/guides/remote-execution/' },
      ],
    },
    {
      label: 'Extend',
      items: [
        { label: 'Writing a vx plugin', link: '/guides/plugins/' },
        { label: 'OpenTelemetry traces & metrics', link: '/guides/otel-bridge/' },
        { label: 'vx mcp — AI agents', link: '/guides/mcp/' },
      ],
    },
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
        { label: 'vx, Turborepo, Nx, Bazel', link: '/learn/choosing/' },
        { label: 'vx vs Turborepo vs Nx', link: '/comparison/' },
        { label: 'Turbo / Nx parity map', link: '/parity/' },
      ],
    },
    { label: 'Glossary', link: '/learn/glossary/' },
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
