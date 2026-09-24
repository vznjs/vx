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
// The landing page's one guarantee (item 709) cites the sandbox file, and
// landing.test.ts reads it the same way.
const CHOOSING_PROOFS = [
  'packages/vx/tests/config.test.ts',
  'packages/vx/tests/sandbox-runtime.unsafe.test.ts',
  'packages/vx/tests/task-hash-derive.test.ts',
  'packages/vx/tests/plugin-pipeline.test.ts',
  'packages/vx/tests/layered-cache.test.ts',
  'packages/vx-reapi/tests/exec-e2e.test.ts',
  'packages/vx-migrate/tests/turbo.test.ts',
]

// The Guide's chapters link each claim about vx to the test row that holds
// it, inside each chapter's "How we know this is true", and
// tests/guide-page.ts reads each linked file for the row's title, as the
// choosing page's rows do. Granted by name and keyed, like the lists above.
const GUIDE_PROOFS = [
  'packages/vx/tests/config.test.ts',
  'packages/vx/tests/package-graph.test.ts',
  'packages/vx/tests/task-graph.test.ts',
  'packages/vx/tests/scheduler.test.ts',
  'packages/vx/tests/cgroup.test.ts',
  'packages/vx/tests/show-info.test.ts',
  'packages/vx/tests/git-subdir-workspace.test.ts',
  'packages/vx/tests/execute-task.test.ts',
  'packages/vx/tests/git-oid.test.ts',
  'packages/vx/tests/sandbox-request.test.ts',
  'packages/vx-schedule-history/tests/schedule-history.test.ts',
  'packages/vx-bench/tests/schedule-policy.test.ts',
]
const PROOFS = [...new Set([...CHOOSING_PROOFS, ...GUIDE_PROOFS])]

export default defineProject({
  tasks: {
    ci: {
      dependsOn: ['lint', 'build', 'test'],
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    // The site's TypeScript is type-checked like every package's (item 702):
    // `bun test` and astro's build only transpile, so a type error in the
    // playground, a widget's model or a test failed nothing. The directories
    // are named, not `.`: a type-checker pointed at a directory holding a
    // symlinked node_modules walks it. `src/content/` is left out, being
    // Markdown and a `content.config.ts` whose `astro:content` types exist
    // only after astro generates them. The check follows imports across the
    // boundary: the playground into core's source (a devDependency, its key
    // through `install`), the scheduler simulator into vx-bench's policy file
    // (granted by name and keyed, like the sim sources).
    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: {
        command:
          'oxlint --type-aware --type-check astro.config.mjs scripts src/components src/examples src/guide src/nav src/pages src/playground src/plugins tests',
        sandbox: {
          allow: {
            read: ['**/*', SIM_READ, '../vx/src/**'],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: [
            'astro.config.mjs',
            'scripts/**',
            'src/components/**',
            'src/examples/**',
            'src/guide/**',
            'src/nav/**',
            'src/pages/**',
            'src/playground/**',
            'src/plugins/**',
            'tests/**',
            'package.json',
            '.oxlintrc.json',
            'tsconfig.json',
          ],
          workspaceFiles: SIM_SOURCES,
        },
        outputs: { files: [] },
      },
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
        'bun test — the Guide, sidebar, redirect, diagram, demo, Learn and site-link pins (needs the imported content and dist/)',
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
              ...PROOFS.map((p) => `../${p.slice('packages/'.length)}`),
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
            // learn-playground.test.ts and learn-checkpoints.test.ts read the
            // elements' source for the markup they query.
            'src/components/demos/playground.ts',
            'src/components/demos/checkpoint.ts',
            // guide.test.ts and sidebar-coverage.test.ts import the Guide's
            // chapter list and the sidebars; diagram-kit.test.ts reads the
            // kit's styles and the theme's tokens.
            'src/guide/**',
            'src/nav/**',
            'src/components/guide/**',
            'src/styles/theme.css',
            // The playground rows: its glob and xxh3 against Bun's, and the
            // shipped bundle against a fresh build.
            'src/playground/**',
            'scripts/build-playground.ts',
            'src/examples/**',
            'astro.config.*',
            '.gitignore',
            'package.json',
          ],
          workspaceFiles: [...SIM_SOURCES, ...PROOFS],
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
        // Under Bun, prerender included. `bun --bun` runs astro's bin on Bun,
        // but astro prerenders in a CHILD process it starts as `node`, and
        // `bun --bun` redirects that only through a shim it writes under
        // `/tmp/bun-node-*`, which this sandbox cannot write: on Linux CI the
        // prerender ran under the PATH's Node (no global `Worker`, item 700),
        // and a box whose shim already existed ran Bun and saw nothing. So the
        // command gives the build its own `node` → `bun` link in `.astro/bin`
        // (already a write grant) ahead of PATH. Probed without a host shim:
        // the prerender reports `typeof Bun` `undefined` before, `object`
        // after; min of three interleaved sandboxed builds, 17.2 s before and
        // 14.5 s after (item 708). Build-time code still must not assume Bun:
        // astro 6 refuses a Node below 22.12 wherever it does run on Node.
        command:
          'mkdir -p .astro/bin && ln -sf "$(command -v bun)" .astro/bin/node && PATH="$PWD/.astro/bin:$PATH" bun --bun astro build',
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

    // A Learn page's checkpoint computes its answer as the page renders, with
    // the playground's bundle (Checkpoint.astro), so the dev server needs it
    // as the build does.
    dev: {
      description: 'astro dev server (persistent)',
      dependsOn: ['install', 'build.playground'],
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
