import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    // The gate for this project. Without it `vx run ci --all` — which is what
    // CI invokes — covered only core, so a change to `packages/vx` that broke
    // `astro build` left BOTH workflows green: the ci gate never built the
    // site, and docs.yml only triggers on `docs/**` / `apps/docs/**` paths.
    // The breakage would surface on whatever unrelated docs commit came next.
    // The dependency is real and the cache proves it — editing a core source
    // file moves this project's build key through `^build`, so this costs a
    // rebuild exactly when core or the docs actually change.
    ci: {
      dependsOn: ['build'],
    },

    // Regenerate the Starlight content collection from the repo's `docs/`
    // tree. Deliberately UNCACHED: it writes generated pages into
    // `src/content/docs/`, a directory that also holds tracked,
    // hand-authored pages — declaring it as an output would let
    // output-cleaning wipe those. The step is idempotent and fast.
    import: {
      description: 'generate Starlight content from docs/ (codegen)',
      exec: { command: 'bun scripts/import-docs.ts' },
    },

    // install -> build, ordering only. The install itself is the agent
    // pool's `prepare`, run once against the shared workspace.
    install: {
      dependsOn: ['^build'],
    },

    build: {
      description: 'astro build → dist/',
      dependsOn: ['install', 'import'],
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
