// The site's places: one Docs section (M 2026-11-23: guides, docs and
// reference are all docs) with a sidebar; the Blog, Releases, Features,
// Conformance and the landing ('home', no place in the top nav) have none.
// Every page is a Starlight page, so one header, search and theme serve them
// all.
//
// Starlight has one sidebar. SIDEBAR is it, as one top-level group, Docs;
// route-data.ts shows it on every docs page. Internals (modules/, design/,
// overview, architecture, optimizations, patterns, flows) are in no group:
// pages that explain them link them.

import type { StarlightUserConfig } from '@astrojs/starlight/types'

export type SectionId = 'home' | 'docs' | 'conformance' | 'blog' | 'releases'

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
  { id: 'docs', label: 'Docs', href: 'docs/' },
  { id: 'conformance', label: 'Conformance', href: 'conformance/' },
  { id: 'blog', label: 'Blog', href: 'blog/' },
  { id: 'releases', label: 'Releases', href: 'releases/' },
]

type SidebarItem = NonNullable<StarlightUserConfig['sidebar']>[number]

/**
 * The one Docs sidebar (M 2026-11-23: "merge guides and docs", "merge
 * references into docs as well"). Its order is the path a new user walks:
 * start, define tasks, cache them, run them on CI, then spread CI over many
 * machines; each area's how-to pages sit beside its doc, and the full
 * reference closes the list. The key features are not first; earlier pages
 * point to them (M 08:07: "you need to guide people to them").
 */
const SIDEBAR_GROUPS: Record<'Docs', SidebarItem[]> = {
  Docs: [
    // The story (M 2026-11-23 18:47: "like a story to explore"; 18:58: the
    // structure may change completely): each group is a chapter the reader
    // walks in order, and each page ends on the next one. Small how-to pages
    // fold into their chapter page as Patterns; an entry marked FOLD goes
    // with its page.
    {
      label: 'Start here',
      items: [
        { label: 'What is vx?', link: '/docs/' },
        { label: 'Quickstart', link: '/quickstart/' },
        { label: 'Move an existing workspace to vx', link: '/docs/migrate/' },
        { label: 'Work with AI agents', link: '/docs/agents/' },
        { label: 'Upgrading vx', link: '/docs/upgrading/' },
      ],
    },
    {
      label: 'Set up the workspace',
      items: [
        { label: 'Workspace', link: '/docs/workspace/' },
        { label: 'Lockfiles', link: '/docs/lockfiles/' },
      ],
    },
    {
      label: 'Define tasks',
      items: [
        { label: 'Tasks', link: '/docs/tasks/' },
        { label: 'Environment variables', link: '/docs/environment-variables/' },
        { label: 'Dev servers', link: '/docs/dev-servers/' },
      ],
    },
    {
      label: 'Run tasks',
      items: [
        { label: 'Running tasks', link: '/docs/running-tasks/' },
        // FOLD these four into Running tasks
        { label: 'Run only what changed', link: '/docs/running/run-what-changed/' },
        { label: "Run one project's tasks", link: '/docs/running/run-one-project/' },
        { label: 'Stop at the first failure', link: '/docs/running/stop-at-the-first-failure/' },
        { label: 'Set a time limit on a task', link: '/docs/running/set-a-time-limit/' },
        { label: 'Explore the task graph', link: '/docs/graph-explorer/' },
      ],
    },
    {
      label: 'Cache results',
      items: [
        { label: 'Caching', link: '/docs/caching/' },
        { label: 'Find why a task missed the cache', link: '/docs/caching/why-a-task-missed/' },
        { label: 'Sandboxing', link: '/docs/sandboxing/' },
      ],
    },
    {
      label: 'Run on CI',
      items: [
        { label: 'CI', link: '/docs/ci/' },
        { label: 'Run the same checks locally and on CI', link: '/docs/ci/run-a-pipeline/' },
        { label: 'Remote cache', link: '/docs/remote-cache/' },
        { label: 'Cache server', link: '/docs/servers/cache/' },
      ],
    },
    {
      label: 'Distributed task execution',
      items: [
        { label: 'Distributed task execution', link: '/docs/distributed-task-execution/' },
        {
          label: 'Try distributed task execution on your machine',
          link: '/docs/distributed-task-execution/try-on-your-machine/',
        },
        {
          label: 'Spread a CI run over several machines',
          link: '/docs/distributed-task-execution/spread-ci-over-machines/',
        },
        {
          label: 'Run one task on a different machine',
          link: '/docs/distributed-task-execution/run-a-task-on-its-own-machine/',
        },
        {
          label: 'Give heavy tasks a bigger machine',
          link: '/docs/distributed-task-execution/add-bigger-machines/',
        },
        { label: 'DTE server', link: '/docs/servers/dte/' },
      ],
    },
    // Everything that is not core (2026-10-26): each plugin, the
    // servers they talk to, and how to write one.
    {
      label: 'Extend vx',
      items: [
        { label: 'Plugins', link: '/docs/plugins/' },
        { label: 'Remote execution', link: '/docs/remote-execution/' },
        { label: 'Servers', link: '/docs/servers/' },
        { label: 'History server', link: '/docs/servers/history/' },
        { label: 'Write a plugin', link: '/docs/writing-plugins/' },
      ],
    },
    {
      label: 'CLI reference',
      items: [
        { label: 'Commands', link: '/cli/' },
        { label: 'vx run', link: '/cli/run/' },
        { label: 'vx watch', link: '/cli/watch/' },
        { label: 'vx pipeline', link: '/cli/pipeline/' },
        { label: 'vx show', link: '/cli/show/' },
        { label: 'vx why', link: '/cli/why/' },
        { label: 'vx last', link: '/cli/last/' },
        { label: 'vx info', link: '/cli/info/' },
        { label: 'vx lock', link: '/cli/lock/' },
        { label: 'vx cache clean', link: '/cli/cache/' },
        { label: 'vx init', link: '/cli/init/' },
        { label: 'vx upgrade', link: '/cli/upgrade/' },
        { label: 'vx docs', link: '/cli/docs/' },
        { label: 'vx help, vx version', link: '/cli/help/' },
        { label: 'vx completions', link: '/cli/completions/' },
        { label: 'Plugin commands', link: '/cli/plugin-commands/' },
        { label: 'Environment variables', link: '/cli/environment-variables/' },
        { label: 'Output format', link: '/cli/output/' },
        { label: 'Every feature', link: '/all-features/' },
        { label: 'What a run does', link: '/execution/' },
      ],
    },
    {
      label: 'Config reference',
      items: [
        { label: 'vx.config.ts', link: '/schema/' },
        { label: 'exec', link: '/schema/exec/' },
        { label: 'exec.sandbox', link: '/schema/sandbox/' },
        { label: 'dependsOn', link: '/schema/depends-on/' },
        { label: 'inputs', link: '/schema/inputs/' },
        { label: 'outputs', link: '/schema/outputs/' },
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
        { label: 'On real workspaces', link: '/compare/real-repos/' },
      ],
    },
    {
      label: 'Compare',
      items: [
        { label: 'vx vs Turborepo', link: '/compare/turborepo/' },
        { label: 'vx vs Nx', link: '/compare/nx/' },
        { label: 'vx vs Turborepo vs Nx', link: '/comparison/' },
        { label: 'Parity map for Turbo and Nx', link: '/parity/' },
        { label: 'Config support for Turbo and Nx', link: '/compare/turbo-nx-support/' },
        { label: 'Upstream bug ledger', link: '/upstream-ledger/' },
      ],
    },
    {
      label: 'Plugin reference',
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
}
