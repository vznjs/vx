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

    // setup -> install -> build. `setup` is the workspace install, and there
    // is exactly ONE of it for the whole repo — dependency installation is a
    // workspace concern, not a per-project one, so every project's `install`
    // names the same task rather than declaring its own. (Bazel solves this
    // the same way: `npm_translate_lock` is evaluated once as an external
    // repository and every target depends on that single result. Per-project
    // installs are not expressible here anyway — identical definitions still
    // get different cache keys, since the key folds the task id and the
    // project's package.json, so N projects would mean N installs.)
    install: {
      dependsOn: ['@vzn/vx#setup', '^build'],
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
