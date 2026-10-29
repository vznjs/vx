import { defineProject } from '@vzn/vx'

// The choosing page (item 689) links each vx guarantee to the test row that
// holds it, and compare.test.ts reads each file for that row's title,
// so a renamed row or a moved file fails the site's test instead of leaving
// a dead link. Granted by name and keyed as inputs.
const PROOFS = [
  'packages/vx/tests/config.test.ts',
  'packages/vx/tests/sandbox-runtime.unsafe.test.ts',
  'packages/vx/tests/task-hash-derive.test.ts',
  'packages/vx/tests/plugin-pipeline.test.ts',
  'packages/vx/tests/layered-cache.test.ts',
  'packages/vx-reapi/tests/exec-e2e.test.ts',
  'packages/vx-migrate/tests/turbo.test.ts',
]

// What `import` generates from packages/vx/docs: a hit restores only these,
// so a page missing here vanishes from the site on a hit. Pinned to the
// .gitignore manifest by tests/sidebar-coverage.test.ts.
const IMPORTED = [
  'src/content/docs/all-features.md',
  'src/content/docs/api.md',
  'src/content/docs/architecture.md',
  'src/content/docs/benchmarks.md',
  'src/content/docs/caching.md',
  'src/content/docs/cli.md',
  'src/content/docs/compare/turbo-nx-support.md',
  'src/content/docs/comparison.md',
  'src/content/docs/execution.md',
  'src/content/docs/flows.md',
  'src/content/docs/optimizations.md',
  'src/content/docs/overview.md',
  'src/content/docs/parity.md',
  'src/content/docs/patterns.md',
  'src/content/docs/schema.md',
  'src/content/docs/security.md',
  'src/content/docs/switchboard.md',
  'src/content/docs/upstream-ledger.md',
  'src/content/docs/modules/**',
  'src/content/docs/design/**',
  'src/content/docs/plugins/**',
  'src/content/docs/cli/**',
  'src/content/docs/schema/**',
]
// A key reads no other task's outputs (`vx lock`, X-54): each
// arrives through that task's key and `dependsOn`. All three are gitignored,
// so no key read them before either.
const NOT_GENERATED = [...IMPORTED, 'public/_img/**', 'dist/**'].map((g) => `!${g}`)

export default defineProject({
  tasks: {
    ci: {
      dependsOn: ['lint', 'build', 'test'],
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    // The site's TypeScript is type-checked like every package's (item 702):
    // `bun test` and astro's build only transpile, so a type error in a
    // widget's model or a test failed nothing. The directories
    // are named, not `.`: a type-checker pointed at a directory holding a
    // symlinked node_modules walks it. `src/content/`, `src/llms/` and
    // `src/blog/` are left out: they import `astro:content`, whose types
    // exist only after astro generates them; src/env.d.ts gives the rest of
    // astro's types. They are inputs all the same, as the files checked
    // import them. The check follows the tests' imports across the boundary
    // into core's source (a devDependency, its key through `install`).
    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: {
        command:
          'oxlint --type-aware --type-check astro.config.mjs scripts src/components src/features src/nav src/pages src/plugins tests',
        sandbox: {
          allow: {
            read: ['**/*', '../../packages/vx/src/**'],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      dependsOn: ['install'],
      inputs: {
        files: [
          'astro.config.mjs',
          'scripts/**',
          'src/env.d.ts',
          'src/blog/**',
          'src/components/**',
          'src/features/**',
          'src/llms/**',
          'src/nav/**',
          'src/pages/**',
          'src/plugins/**',
          'tests/**',
          'package.json',
          '.oxlintrc.json',
          'tsconfig.json',
        ],
      },
      cache: {
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
      inputs: {
        files: ['**/*', ...NOT_GENERATED],
      },
      cache: {
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
      description:
        'generate src/content/docs from packages/vx/docs, the plugin READMEs and the relay protocol',
      dependsOn: ['install'],
      exec: {
        command: 'bun scripts/import-docs.ts',
        sandbox: {
          allow: {
            read: [
              '**/*',
              '../../packages/vx/docs/**',
              '../../packages/vx-*/README.md',
              '../../packages/vx-*/package.json',
              '../../packages/vx-dte-server/PROTOCOL.md',
            ],
            write: ['src/content/docs/**'],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      inputs: {
        files: ['scripts/import-docs.ts'],
        workspaceFiles: [
          'packages/vx/docs/**',
          'packages/vx-*/README.md',
          'packages/vx-*/package.json',
          'packages/vx-dte-server/PROTOCOL.md',
        ],
      },
      cache: {
        outputs: { files: IMPORTED },
      },
    },

    // `build` because the page pins (landing, sidebar, redirects, links)
    // read what the site shipped: whether a widget's
    // no-JavaScript fallback is there is a fact about the built HTML, not
    // about any source file. `dist/` is not an input here; `build`'s key
    // reaches this one through `dependsOn`, and a hit on `build` restores
    // `dist/` before this runs.
    //
    // Three rows read across project boundaries through packages this one
    // links (package.json), whose keys arrive through `install`
    // (`^build` folds each linked package's `source`, item 687): the CI
    // guide's job summary is rendered by `@vzn/vx-ci`, the plugins
    // guide's snippets type-check against `@vzn/vx-history`, and every
    // page's config blocks against the plugins they call.
    test: {
      description:
        'bun test — the landing, sidebar, redirect, diagram, compare and site-link pins (needs the imported content and dist/)',
      dependsOn: ['install', 'import', 'build'],
      exec: {
        command: 'bun test --only-failures',
        // Bun's transpiler cache writes under HOME, outside the sandbox's grants.
        env: { define: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', VX_CACHE_DIR: '.vx/cache' } },
        sandbox: {
          allow: {
            read: [
              '**/*',
              '../../packages/vx/src/**',
              // config-snippets.test.ts checks each page's plugin call
              // against the plugin's source.
              ...['cache', 'ci', 'dte', 'history', 'lockfile', 'migrate', 'otel'].map(
                (p) => `../../packages/vx-${p}/src/**`,
              ),
              ...PROOFS.map((p) => `../../${p}`),
              // reference-pages.test.ts maps the one-page references' ids to their pages.
              '../../packages/vx/docs/cli.md',
              '../../packages/vx/docs/schema.md',
            ],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      inputs: {
        files: [
          'tests/**',
          'src/content/docs/**',
          // The compare pins import the widgets' model to hold the built
          // pages to it.
          'src/components/demos/model/**',
          // sidebar-coverage.test.ts imports the sidebars; diagram-kit.test.ts
          // reads the kit's styles, the widgets' and the theme's tokens, and
          // with landing.test.ts the landing's picture.
          'src/nav/**',
          // features.test.ts holds the feature data's copy, commands and
          // config examples, and its images on disk.
          'src/features/**',
          'src/assets/features/**',
          'src/components/guide/**',
          'src/components/landing/**',
          'src/components/Demo.astro',
          'src/components/demos/widget.css',
          'src/styles/theme.css',
          'astro.config.*',
          '.gitignore',
          'package.json',
          'scripts/**',
          ...NOT_GENERATED,
        ],
        workspaceFiles: [...PROOFS, 'packages/vx/docs/cli.md', 'packages/vx/docs/schema.md'],
      },
      cache: {
        outputs: { files: [] },
      },
    },

    install: {
      dependsOn: ['^build'],
    },

    // The images, resized before the build and keyed on the images alone:
    // a page edit never re-encodes them, and on a miss they encode beside
    // `import` instead of inside `build`.
    'build.images': {
      description: 'resize src/assets/{blog,features} → public/_img/',
      dependsOn: ['install'],
      exec: {
        command: 'bun scripts/build-images.ts',
        sandbox: {
          allow: {
            read: ['**/*'],
            write: ['public/_img/**'],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      inputs: {
        files: [
          'scripts/build-images.ts',
          'src/assets/blog/**',
          'src/assets/features/**',
          'package.json',
        ],
      },
      cache: {
        outputs: { files: ['public/_img/**'] },
      },
    },

    build: {
      description: 'astro build → dist/',
      dependsOn: ['install', 'import', 'build.images'],
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
      // The generated pages are gitignored, so `**/*` does not see them;
      // `import`'s key does (its inputs are the docs), and it cascades
      // through `dependsOn`. This used to name `docs/**` at the workspace
      // root — a path that stopped existing when core moved under
      // `packages/`, so a docs edit never re-keyed the build.
      inputs: {
        files: ['**/*', ...NOT_GENERATED],
      },
      cache: {
        outputs: { files: ['dist/**'] },
      },
    },

    // The site's part of main's `release`.
    release: { dependsOn: ['deploy.pages'] },
    // Main's deploy, a task of the run (2026-10-24): once the site's
    // own checks pass it goes live beside the rest of the run. The Pages
    // actions ran after the whole run, 33 s of main's workflow. The job's
    // tokens it passes through work from any worker (ci.yml).
    'deploy.pages': {
      description: 'deploy dist/ to GitHub Pages (GitHub Actions only)',
      dependsOn: ['ci'],
      exec: {
        command: 'bun scripts/deploy-pages.ts',
        env: {
          passThrough: [
            'ACTIONS_RUNTIME_TOKEN',
            'ACTIONS_RESULTS_URL',
            'ACTIONS_ID_TOKEN_REQUEST_URL',
            'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
            'GITHUB_TOKEN',
            'GITHUB_REPOSITORY',
            'GITHUB_SHA',
            'GITHUB_API_URL',
          ],
          secret: ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'GITHUB_TOKEN'],
        },
        sandbox: {
          allow: {
            read: ['**/*'],
            network: [
              '*.actions.githubusercontent.com',
              '*.blob.core.windows.net',
              'api.github.com',
            ],
          },
        },
      },
    },

    dev: {
      description: 'astro dev server (persistent)',
      dependsOn: ['install', 'build.images'],
      exec: {
        command: 'bun --bun astro dev',
        env: { define: { ASTRO_TELEMETRY_DISABLED: '1' } },
        persistent: { readyWhen: 'Local' },
        timeout: '2m',
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
        timeout: '2m',
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
