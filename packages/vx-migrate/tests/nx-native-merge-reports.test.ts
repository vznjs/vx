// `@nx/playwright:merge-reports`, the `e2e-ci--merge-reports` Nx infers
// beside atomized Playwright specs, was a failing placeholder. It is
// `playwright merge-reports` on the blob dir from the project dir,
// skipped when the dir is missing, as Nx skips it.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const TODO =
  "@nx/playwright:merge-reports read the blob reporter's outputDir from the Playwright config — the line uses its default, blob-report; check it"
const LINE =
  'if [ -d blob-report ]; then playwright merge-reports blob-report --config playwright.config.ts; fi'
const e2e = { projectRel: 'apps/shop-e2e', projectName: 'shop-e2e' }

describe('@nx/playwright:merge-reports', () => {
  it('merges the blob dir with the config, from the project dir', () => {
    expect(
      nativeExecutorCommand(
        '@nx/playwright:merge-reports',
        { config: 'playwright.config.ts', expectedSuites: 2 },
        e2e,
      ),
    ).toEqual({ command: LINE, env: {}, todos: [TODO] })
  })

  it('no config is no line', () => {
    expect(nativeExecutorCommand('@nx/playwright:merge-reports', {}, e2e)).toBe(null)
  })

  it('the inferred merge-reports task is the line, cached on its report', async () => {
    const graph = {
      nodes: {
        'shop-e2e': {
          name: 'shop-e2e',
          data: {
            root: 'apps/shop-e2e',
            targets: {
              'e2e-ci--merge-reports': {
                executor: '@nx/playwright:merge-reports',
                continuous: false,
                cache: true,
                inputs: ['default', '^production'],
                outputs: ['{projectRoot}/playwright-report'],
                options: { config: 'playwright.config.ts', expectedSuites: 2 },
              },
            },
          },
        },
      },
      dependencies: { 'shop-e2e': [] },
    }
    const meta: ProjectMeta = {
      name: 'shop-e2e',
      dir: '/w/apps/shop-e2e',
      packageJson: { name: 'shop-e2e' },
      configPath: null,
    }
    const mapped = await mapNxWorkspace('/w', [meta], parseNxGraph(JSON.stringify(graph), 'g'), {
      persistentTodo: 'p',
      cacheable: new Set(),
      nativeExecutors: true,
    })
    const task = mapped.projects[0]!.tasks.find((t) => t.name === 'e2e-ci--merge-reports')!
    expect((task.task!['exec'] as { command: string }).command).toBe(LINE)
    expect(task.task!['exec']).not.toHaveProperty('persistent')
    expect((task.task!['cache'] as { outputs: unknown }).outputs).toEqual({
      files: ['playwright-report'],
    })
    expect(task.todos).toContain(TODO)
  })
})
