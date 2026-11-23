// The header's dropdowns: under each place in SECTIONS, the pages a
// reader most often wants from it. The Blog's and Releases' panels list
// their newest posts instead (components/starlight/Header.astro).

import { CATEGORIES } from '../features/features.js'
import type { SectionId } from './sections.js'

export type MenuLink = { label: string; href: string; line?: string }

export const MENU: Partial<Record<SectionId, MenuLink[]>> = {
  features: [
    ...CATEGORIES.map((c) => ({ label: c.title, href: `features/${c.id}/`, line: c.line })),
    { label: 'Every feature, one line each', href: 'all-features/' },
  ],
  docs: [
    { label: 'Quickstart', href: 'quickstart/', line: 'Install, configure, cached in a minute.' },
    {
      label: 'Distributed task execution',
      href: 'docs/distributed-task-execution/',
      line: 'One run spread over the machines your CI starts.',
    },
    { label: 'Caching', href: 'docs/caching/', line: 'Inputs, outputs, and what the key holds.' },
    {
      label: 'Find why a task missed the cache',
      href: 'docs/caching/why-a-task-missed/',
      line: 'vx why names the input that moved.',
    },
    { label: 'CI', href: 'docs/ci/', line: 'GitHub Actions, GitLab, affected runs.' },
    {
      label: 'Migrate from Turborepo, Nx or Vite Task',
      href: 'docs/migrate/',
      line: 'Convert your config in one command.',
    },
    { label: 'Commands', href: 'cli/', line: 'Every verb and flag.' },
    { label: 'vx.config.ts', href: 'schema/', line: 'Every config key.' },
  ],
}
