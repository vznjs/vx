import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    ci: {
      dependsOn: ['build', 'test'],
    },

    // The Starlight collection is generated from `packages/vx/docs`. That is
    // a read across a project boundary, which the sandbox denies unless the
    // task declares it — so the task declares it: the read grant names the
    // sibling's docs directory, and `workspaceFiles` makes the same files
    // the task's inputs, so an edit there re-keys this task and, through
    // `dependsOn`, `build` and `test`. Every generated page carries a
    // marker and lives beside the hand-written ones, so the outputs are the
    // generated set by name — a hit restores exactly them and never wipes
    // a tracked page.
    import: {
      description: 'generate src/content/docs from packages/vx/docs',
      dependsOn: ['install'],
      exec: {
        command: 'bun scripts/import-docs.ts',
        sandbox: {
          allow: {
            read: ['**/*', '../vx/docs/**'],
            write: ['src/content/docs/**'],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      cache: {
        inputs: {
          files: ['scripts/import-docs.ts'],
          workspaceFiles: ['packages/vx/docs/**'],
        },
        outputs: {
          files: [
            'src/content/docs/architecture.md',
            'src/content/docs/benchmarks.md',
            'src/content/docs/caching.md',
            'src/content/docs/cli.md',
            'src/content/docs/comparison.md',
            'src/content/docs/execution.md',
            'src/content/docs/flows.md',
            'src/content/docs/optimizations.md',
            'src/content/docs/overview.md',
            'src/content/docs/patterns.md',
            'src/content/docs/schema.md',
            'src/content/docs/modules/**',
            'src/content/docs/design/**',
          ],
        },
      },
    },

    test: {
      description: 'bun test — the guide and sidebar pins (needs the imported content)',
      dependsOn: ['install', 'import'],
      exec: {
        command: 'bun test',
        sandbox: {
          allow: {
            read: ['**/*'],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      cache: {
        inputs: {
          files: [
            'tests/**',
            'src/content/docs/**',
            'astro.config.*',
            '.gitignore',
            'package.json',
          ],
        },
        outputs: { files: [] },
      },
    },

    install: {
      dependsOn: ['^build'],
    },

    build: {
      description: 'astro build → dist/',
      dependsOn: ['install', 'import'],
      exec: {
        // Under Bun, not the host's Node: `bun --bun` runs astro's bin on
        // Bun's runtime, which builds the same 133 pages in half the time
        // (18.5 s against 37 s under Node 22, 2026-09-09) and leaves no
        // dependency on whichever Node a CI image ships — astro 6 refuses
        // anything below 22.12, and the Linux gate's docs build had been
        // exiting 1 in 61 ms with no output at all.
        command: 'bun --bun astro build',
        // astro's telemetry does `mkdir ~/.config` before anything else; a
        // sandboxed task may read HOME but not write it, so it is told to
        // stay home.
        env: { define: { ASTRO_TELEMETRY_DISABLED: '1' } },
        sandbox: {
          allow: {
            read: ['**/*'],
            // astro's and vite's caches live under `.astro/` (astro.config.mjs),
            // never under node_modules: a write grant there makes the sandbox
            // punch the read grant into node_modules' children, and bwrap
            // mounts a SYMLINKED child (every package in Bun's isolated
            // layout) as a plain directory — astro then could not resolve
            // its own `yargs-parser` (Linux CI, 2026-09-05 → 09-09).
            write: ['dist/**', '.astro/**'],
            // A static build binds no port; `localBinding` belongs to `dev`
            // and `preview` below, which serve.
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            machLookup: ['com.apple.SystemConfiguration.DNSConfiguration'],
          },
        },
      },
      cache: {
        // The generated pages are gitignored, so `**/*` does not see them;
        // `import`'s key does (its inputs are the docs), and it cascades
        // through `dependsOn`. This used to name `docs/**` at the workspace
        // root — a path that stopped existing when core moved under
        // `packages/`, so a docs edit never re-keyed the build.
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: ['dist/**'] },
      },
    },

    dev: {
      description: 'astro dev server (persistent)',
      dependsOn: ['install'],
      exec: {
        command: 'bun --bun astro dev',
        env: { define: { ASTRO_TELEMETRY_DISABLED: '1' } },
        persistent: { readyWhen: 'Local' },
        timeout: 120000,
        sandbox: {
          allow: {
            read: ['**/*'],
            write: ['.astro/**'],
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            machLookup: ['com.apple.SystemConfiguration.DNSConfiguration'],
            localBinding: true,
          },
        },
      },
    },

    preview: {
      description: 'serve the built dist/ (persistent)',
      dependsOn: ['build'],
      exec: {
        command: 'bun --bun astro preview',
        env: { define: { ASTRO_TELEMETRY_DISABLED: '1' } },
        persistent: { readyWhen: 'Local' },
        timeout: 120000,
        sandbox: {
          allow: {
            read: ['**/*'],
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            machLookup: ['com.apple.SystemConfiguration.DNSConfiguration'],
            localBinding: true,
          },
        },
      },
    },
  },
})
