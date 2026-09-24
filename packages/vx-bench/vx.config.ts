import { defineProject } from '@vzn/vx'

// The site's playground files the research tools in playground-spike/
// import (item 695), granted by name and keyed as inputs.
const PLAYGROUND = [
  'packages/vx-docs/scripts/build-playground.ts',
  'packages/vx-docs/src/playground/**',
  'packages/vx-docs/tests/glob-fuzz.ts',
]

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    ci: {
      dependsOn: ['lint', 'test', 'check.site'],
    },

    // The landing page's benchmark rows, the benchmarks doc's stress
    // section and the README's benchmark sentence are generated from
    // results.json by update-site.ts; `--check` fails when any drifted.
    // All three live outside this project, so the task declares the
    // three reads and folds the three files as inputs.
    'check.site': {
      description: 'update-site.ts --check: the site matches results.json',
      dependsOn: ['install'],
      exec: {
        command: 'bun update-site.ts --check',
        sandbox: {
          allow: {
            read: [
              '**/*',
              '../vx-docs/src/pages/index.astro',
              '../vx/docs/benchmarks.md',
              '../../README.md',
            ],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      cache: {
        inputs: {
          files: ['update-site.ts', 'results.json'],
          workspaceFiles: [
            'packages/vx-docs/src/pages/index.astro',
            'packages/vx/docs/benchmarks.md',
            'README.md',
          ],
        },
        outputs: { files: [] },
      },
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    // The type-check follows playground-spike/'s imports into the site's
    // playground, so it declares that read and keys on those files.
    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: {
        command: 'oxlint --type-aware --type-check',
        sandbox: {
          allow: {
            read: ['**/*', ...PLAYGROUND.map((p) => p.replace(/^packages\//, '../'))],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: [
            '*.ts',
            'tests/**',
            'playground-spike/**/*.ts',
            'package.json',
            '.oxlintrc.json',
            'tsconfig.json',
          ],
          workspaceFiles: PLAYGROUND,
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      exec: {
        command: 'oxfmt --check .',
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    test: {
      description: 'bun test',
      exec: {
        command: 'bun test',
        sandbox: {
          allow: {
            read: ['**/*'],
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
          },
        },
      },
      dependsOn: ['install'],
      cache: {
        inputs: { files: ['*.ts', 'tests/**', 'package.json'] },
        outputs: { files: [] },
      },
    },
  },
})
