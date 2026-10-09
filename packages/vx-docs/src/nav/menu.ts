// The header's dropdowns: under each place in SECTIONS, the pages a
// reader most often wants from it. The Blog's and Releases' panels list
// their newest posts instead (components/starlight/Header.astro).

import { CATEGORIES } from '../features/features.js'
import type { SectionId } from './sections.js'

export type MenuLink = { label: string; href: string; line?: string }

export const MENU: Partial<Record<SectionId, MenuLink[]>> = {
  features: [
    ...CATEGORIES.map((c) => ({ label: c.title, href: `features/#${c.id}`, line: c.line })),
    { label: 'Every feature, one line each', href: 'all-features/' },
  ],
  docs: [
    { label: 'Quickstart', href: 'quickstart/', line: 'Install, configure, cached in a minute.' },
    { label: 'Configure', href: 'guides/configure/', line: 'Tasks, inputs, outputs, env.' },
    {
      label: 'Sandboxing',
      href: 'guides/sandboxing/',
      line: 'A task touches only what it declares.',
    },
    { label: 'CI and remote', href: 'guides/ci/', line: 'Affected runs, remote cache, execution.' },
    { label: 'Migrate', href: 'guides/migrate/', line: 'From Turborepo or Nx in one command.' },
    { label: 'AI agents', href: 'guides/agents/', line: 'vx mcp, JSON output, vx why.' },
    { label: 'Plugins', href: 'guides/plugins/', line: 'Every stage is a seam.' },
    { label: 'Playground', href: 'playground/', line: 'The planner, in your browser.' },
  ],
  reference: [
    { label: 'Commands', href: 'cli/', line: 'Every verb and flag.' },
    { label: 'vx.config.ts', href: 'schema/', line: 'Every config key.' },
    { label: 'Caching in depth', href: 'caching/', line: 'How a key is made.' },
    { label: 'Benchmarks', href: 'benchmarks/', line: 'vx against Turborepo and Nx.' },
    { label: 'Compare', href: 'compare/', line: 'vx, Turborepo, Nx, Bazel.' },
    { label: 'Security model', href: 'security/', line: 'What a task and a cache can reach.' },
  ],
}
