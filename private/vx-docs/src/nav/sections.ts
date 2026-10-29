// The site's places (design/site-short-2026-09.md § The shape, plus the
// feature pages, plus Guides as Bun's docs have them): the Docs, the Guides
// and the Reference each have a sidebar of their own; the Blog, Releases, Features and the landing ('home', no place in the
// top nav) have none. Every page is a Starlight page, so one header, search
// and theme serve them all. The landing is the story; the Guide it replaced
// redirects there.
//
// Starlight has one sidebar. SIDEBAR is it, as three top-level groups whose
// labels are the section names; route-data.ts shows a page only the group its
// section owns. Internals (modules/, design/, overview, architecture,
// optimizations, patterns, flows) are in no group: pages that explain them
// link them.

import type { StarlightUserConfig } from '@astrojs/starlight/types'

export type SectionId = 'home' | 'features' | 'docs' | 'guides' | 'reference' | 'blog' | 'releases'

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
  { id: 'docs', label: 'Docs', href: 'docs/' },
  { id: 'guides', label: 'Guides', href: 'guides/' },
  { id: 'reference', label: 'Reference', href: 'cli/' },
  { id: 'blog', label: 'Blog', href: 'blog/' },
  { id: 'releases', label: 'Releases', href: 'releases/' },
]

type SidebarItem = NonNullable<StarlightUserConfig['sidebar']>[number]

/** Each sidebar section's items, keyed by the label its top-level group carries. */
const SIDEBAR_GROUPS: Record<'Docs' | 'Guides' | 'Reference', SidebarItem[]> = {
  // One feature per page, grouped by area (as Bun's docs are; org style
  // guide); the landing's diagram teaches the ideas.
  Docs: [
    {
      label: 'Get started',
      items: [
        { label: 'What is vx?', link: '/docs/' },
        { label: 'Quickstart', link: '/quickstart/' },
        { label: 'Upgrading to 1.0', link: '/guides/upgrading/' },
        { label: 'AI agents', link: '/docs/agents/' },
      ],
    },
    {
      label: 'Configure',
      items: [
        { label: 'Workspace', link: '/docs/workspace/' },
        { label: 'Tasks', link: '/docs/tasks/' },
        { label: 'Caching', link: '/docs/caching/' },
        { label: 'Environment variables', link: '/docs/environment-variables/' },
        { label: 'Dev servers', link: '/docs/dev-servers/' },
      ],
    },
    {
      label: 'Run',
      items: [
        { label: 'Running tasks', link: '/docs/running-tasks/' },
        { label: 'Sandboxing', link: '/docs/sandboxing/' },
        { label: 'CI', link: '/docs/ci/' },
      ],
    },
    // Everything that is not core (2026-10-26): each plugin, the
    // servers they talk to, and how to write one.
    {
      label: 'Plugins',
      items: [
        { label: 'Plugins', link: '/docs/plugins/' },
        { label: 'Lockfiles', link: '/docs/lockfiles/' },
        { label: 'Remote cache', link: '/docs/remote-cache/' },
        { label: 'Distributed task execution', link: '/docs/distributed-task-execution/' },
        { label: 'Remote execution', link: '/docs/remote-execution/' },
        { label: 'Servers', link: '/docs/servers/' },
        { label: 'Cache server', link: '/docs/servers/cache/' },
        { label: 'History server', link: '/docs/servers/history/' },
        { label: 'DTE server', link: '/docs/servers/dte/' },
        { label: 'Write a plugin', link: '/docs/writing-plugins/' },
      ],
    },
  ],
  // One task per page, titled as the task, grouped by area (as Bun's guides
  // are; org style guide). guides/index.mdx lists the same pages.
  Guides: [
    { label: 'All guides', link: '/guides/' },
    {
      label: 'Get started',
      items: [{ label: 'Migrate from Turborepo, Nx or Vite Task', link: '/guides/migrate/' }],
    },
    {
      label: 'Caching',
      items: [
        { label: 'Find why a task missed the cache', link: '/guides/caching/why-a-task-missed/' },
        { label: 'Clear the local cache', link: '/guides/caching/clean-the-cache/' },
      ],
    },
    {
      label: 'Running',
      items: [
        { label: 'Run only what changed', link: '/guides/running/run-what-changed/' },
        { label: "Run one project's tasks", link: '/guides/running/run-one-project/' },
      ],
    },
    {
      label: 'CI',
      items: [{ label: 'Fail CI when the lock is stale', link: '/guides/ci/check-the-lock/' }],
    },
    {
      label: 'Debugging',
      items: [
        { label: 'Troubleshooting', link: '/guides/troubleshooting/' },
        { label: 'Explore the task graph', link: '/guides/graph-explorer/' },
      ],
    },
  ],
  // Short groups in plain words; Plugins is each published plugin's README.
  // The caching deep dive and "What a run does" are reference only; the
  // Docs' caching page links the first.
  Reference: [
    {
      label: 'CLI',
      items: [
        { label: 'Commands', link: '/cli/' },
        { label: 'vx run', link: '/cli/run/' },
        { label: 'vx watch', link: '/cli/watch/' },
        { label: 'vx show', link: '/cli/show/' },
        { label: 'vx why', link: '/cli/why/' },
        { label: 'vx last', link: '/cli/last/' },
        { label: 'vx info', link: '/cli/info/' },
        { label: 'vx lock', link: '/cli/lock/' },
        { label: 'vx cache clean', link: '/cli/cache/' },
        { label: 'vx init', link: '/cli/init/' },
        { label: 'vx upgrade', link: '/cli/upgrade/' },
        { label: 'vx docs', link: '/cli/docs/' },
        { label: 'vx completions', link: '/cli/completions/' },
        { label: 'Plugin commands', link: '/cli/plugin-commands/' },
        { label: 'Environment variables', link: '/cli/environment-variables/' },
        { label: 'Output format', link: '/cli/output/' },
        { label: 'Every feature', link: '/all-features/' },
        { label: 'What a run does', link: '/execution/' },
      ],
    },
    {
      label: 'Config',
      items: [
        { label: 'vx.config.ts', link: '/schema/' },
        { label: 'exec', link: '/schema/exec/' },
        { label: 'exec.sandbox', link: '/schema/sandbox/' },
        { label: 'dependsOn', link: '/schema/depends-on/' },
        { label: 'inputs', link: '/schema/inputs/' },
        { label: 'cache', link: '/schema/cache/' },
        { label: '.vx/workspace.ts', link: '/schema/workspace/' },
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
        { label: 'On real repos', link: '/compare/real-repos/' },
      ],
    },
    {
      label: 'Compare',
      items: [
        { label: 'vx, Turborepo, Nx, Bazel', link: '/compare/' },
        { label: 'vx vs Turborepo', link: '/compare/turborepo/' },
        { label: 'vx vs Nx', link: '/compare/nx/' },
        { label: 'vx vs Turborepo vs Nx', link: '/comparison/' },
        { label: 'Parity map for Turbo and Nx', link: '/parity/' },
        { label: 'Config support for Turbo and Nx', link: '/compare/turbo-nx-support/' },
        { label: 'Upstream bug ledger', link: '/upstream-ledger/' },
      ],
    },
    {
      label: 'Plugins',
      items: [
        { label: '@vzn/vx-ci', link: '/plugins/vx-ci/' },
        { label: '@vzn/vx-lockfile', link: '/plugins/vx-lockfile/' },
        { label: '@vzn/vx-migrate', link: '/plugins/vx-migrate/' },
        { label: '@vzn/vx-otel', link: '/plugins/vx-otel/' },
        { label: '@vzn/vx-reapi', link: '/plugins/vx-reapi/' },
        { label: '@vzn/vx-history', link: '/plugins/vx-history/' },
        { label: '@vzn/vx-cache', link: '/plugins/vx-cache/' },
        { label: '@vzn/vx-cache-server', link: '/plugins/vx-cache-server/' },
        { label: '@vzn/vx-history-server', link: '/plugins/vx-history-server/' },
        { label: '@vzn/vx-devtools', link: '/plugins/vx-devtools/' },
        { label: '@vzn/vx-dte', link: '/plugins/vx-dte/' },
        { label: '@vzn/vx-dte-server', link: '/plugins/vx-dte-server/' },
      ],
    },
    {
      label: 'Protocols',
      items: [{ label: 'Switchboard', link: '/switchboard/' }],
    },
    { label: 'Glossary', link: '/glossary/' },
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
  Guides: 'guides',
  Reference: 'reference',
}
