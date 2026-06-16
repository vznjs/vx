import { defineProject } from '../../src/index.ts'

export default defineProject({
  tasks: {
    // Regenerate the Starlight content collection from the repo's `docs/`
    // tree. Deliberately UNCACHED: it writes generated pages into
    // `src/content/docs/`, a directory that also holds tracked,
    // hand-authored pages — declaring it as an output would let
    // output-cleaning wipe those. The step is idempotent and fast.
    import: {
      description: 'generate Starlight content from docs/ (codegen)',
      exec: { command: 'bun scripts/import-docs.ts' },
    },

    build: {
      description: 'astro build → dist/',
      dependsOn: ['import'],
      exec: { command: 'astro build' },
      cache: {
        inputs: {
          files: ['**/*'],
          workspaceFiles: ['docs/**'],
        },
        outputs: { files: ['dist/**'] },
      },
    },

    dev: {
      description: 'astro dev server (persistent)',
      dependsOn: ['import'],
      exec: {
        command: 'astro dev',
        persistent: { readyWhen: 'Local' },
        timeout: 120000,
      },
    },

    preview: {
      description: 'serve the built dist/ (persistent)',
      dependsOn: ['build'],
      exec: {
        command: 'astro preview',
        persistent: { readyWhen: 'Local' },
        timeout: 120000,
      },
    },
  },
})
