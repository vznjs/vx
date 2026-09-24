import { defineProject } from '@vzn/vx'

// The Learn page's scheduler simulator (item 685) runs vx-bench's simulator
// over vx's own ranking code, so the site's build bundles, and its test
// imports, three files outside this project. Core and the history plugin are
// devDependencies, whose directories the sandbox grants by itself; vx-bench
// is not, so its file is granted by name. All three are inputs: an edit to
// any of them changes the schedules the page draws.
const SIM_SOURCES = [
  'packages/vx-bench/schedule-policy.ts',
  'packages/vx/src/graph/priorities.ts',
  'packages/vx-schedule-history/src/critical-path.ts',
]
const SIM_READ = '../vx-bench/schedule-policy.ts'

// The choosing page (item 689) links each vx guarantee to the test row that
// holds it, and learn-choosing.test.ts reads each file for that row's title,
// so a renamed row or a moved file fails the site's test instead of leaving
// a dead link. Granted by name and keyed as inputs, like the sim sources.
const CHOOSING_PROOFS = [
  'packages/vx/tests/config.test.ts',
  'packages/vx/tests/sandbox-runtime.unsafe.test.ts',
  'packages/vx/tests/task-hash-derive.test.ts',
  'packages/vx/tests/plugin-pipeline.test.ts',
  'packages/vx/tests/layered-cache.test.ts',
  'packages/vx-reapi/tests/exec-e2e.test.ts',
  'packages/vx-migrate/tests/turbo.test.ts',
]

export default defineProject({
  tasks: {
    ci: {
      dependsOn: ['lint.oxfmt', 'build', 'test'],
    },

    // The site's code is formatted like every package's. Its Markdown is
    // not: oxfmt rewrites code fragments in prose into multi-line objects
    // and moves spaces into inline code at wrap points, so the package's
    // `.oxfmtrc.json` ignores `.md` and `.mdx` (item 693; the root ignore
    // named the whole package, no task checked it, and six code files had
    // drifted).
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

    // `build` because the demo pin (tests/demo-islands.test.ts) reads what
    // the site shipped: whether a widget's no-JavaScript fallback is there is
    // a fact about the built HTML, not about any source file.
    // `dist/` is not an input here; `build`'s key reaches this one through
    // `dependsOn`, and a hit on `build` restores `dist/` before this runs.
    //
    // learn-architecture.test.ts reads across project boundaries, and says
    // so here: it type-checks src/examples/ against core's types, reads
    // `VxPlugin`'s source for the hook declarations the explorer shows, and
    // calls every first-party plugin factory to hold the explorer's
    // first-party column to the hooks each one fills. The reads go through
    // the packages this one links (package.json), and their keys arrive
    // through `install` (`^build` folds each linked package's `source`,
    // item 687), so a change to a hook, a type or a plugin's hooks re-keys
    // this task.
    test: {
      description:
        'bun test — the guide, sidebar, demo and Learn pins (needs the imported content and dist/)',
      dependsOn: ['install', 'import', 'build'],
      exec: {
        command: 'bun test',
        sandbox: {
          allow: {
            read: [
              '**/*',
              SIM_READ,
              '../vx/src/**',
              '../vx-github/src/**',
              '../vx-lockfile/src/**',
              '../vx-mcp/src/**',
              '../vx-migrate/src/**',
              '../vx-otel/src/**',
              '../vx-reapi/src/**',
              '../vx-schedule-history/src/**',
              ...CHOOSING_PROOFS.map((p) => `../${p.slice('packages/'.length)}`),
            ],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      cache: {
        inputs: {
          files: [
            'tests/**',
            'src/content/docs/**',
            // demo-islands.test.ts and learn-architecture.test.ts import the
            // widgets' model to hold the built pages to it.
            'src/components/demos/model/**',
            // The playground rows: its glob and xxh3 against Bun's, and the
            // shipped bundle against a fresh build.
            'src/playground/**',
            'scripts/build-playground.ts',
            'src/examples/**',
            'astro.config.*',
            '.gitignore',
            'package.json',
          ],
          workspaceFiles: [...SIM_SOURCES, ...CHOOSING_PROOFS],
        },
        outputs: { files: [] },
      },
    },

    install: {
      dependsOn: ['^build'],
    },

    // The playground's planner (roadmap W9, item 695): core's planner source
    // behind the browser shim, bundled by Bun into `public/`, which astro
    // copies into `dist/` as it is. Bun and not the site's Vite, so the file
    // core's parity rows build (with this script's own function) is the file
    // the site ships. The bundle IS core's source, read across the project
    // boundary by relative import. Core is a devDependency, whose directory
    // the sandbox grants by itself (the stub's export names come from core's
    // own `node_modules` that way), but the read is named so the config says
    // what the bundle is made of; its key arrives through `install` (core's
    // `source`, item 687).
    'build.playground': {
      description: 'bundle the playground planner → public/playground/planner.js',
      dependsOn: ['install'],
      exec: {
        command: 'bun scripts/build-playground.ts',
        sandbox: {
          allow: {
            read: ['**/*', '../vx/src/**'],
            write: ['public/playground/**'],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      cache: {
        inputs: { files: ['scripts/build-playground.ts', 'src/playground/**', 'package.json'] },
        outputs: { files: ['public/playground/planner.js'] },
      },
    },

    build: {
      description: 'astro build → dist/',
      dependsOn: ['install', 'import', 'build.playground'],
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
            // The pipeline explorer shows each hook as core declares it, read
            // from `VxPlugin`'s source at build time (PipelineExplorer.astro);
            // its key arrives through `install` (core's `source`, item 687).
            read: ['**/*', SIM_READ, '../vx/src/orchestrator/plugin.ts'],
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
          workspaceFiles: SIM_SOURCES,
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
            read: ['**/*', SIM_READ],
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
