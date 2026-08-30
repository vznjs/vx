import { defineProject } from './src/index.ts'

export default defineProject({
  tasks: {
    // CI gate = fast feedback: lint + test. The four cross-compiled release
    // binaries are still `release.yml`'s job, but they DO reach the gate now,
    // pulled in through apps/docs' `install` -> `^build`. That used to be
    // refused here on the grounds that fanning all four out alongside lint +
    // test starves the ubuntu runner and OOM-kills a darwin cross-compile;
    // that is no longer true and the evidence is a green run — docs.yml built
    // all four on ubuntu-latest in 1.1-1.8s each, and the full gate with them
    // included passes. Re-measure before re-adding a restriction.
    ci: {
      dependsOn: ['lint', 'test'],
    },

    install: {
      dependsOn: ['^build'],
    },

    // install -> build. Dependencies are NOT installed by a task any more:
    // the agent pool's `prepare` runs the install once against the workspace
    // every agent shares, and a lockfile change already re-keys every task
    // through the workspace fingerprint. `install` is now purely ordering —
    // this project's dependencies are built before it is.
    build: {
      dependsOn: ['install', 'build.bun'],
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    test: {
      description: 'bun test against the tests/ tree',
      // Scope to ./tests so workspace-member tests (packages/**/tests/) stay
      // isolated to their own packages — `bun test` without a path scans
      // recursively, and a bare `tests/` filter substring-matches a package's
      // own tests dir too. The leading `./` anchors the scan to the root
      // tests/ dir only. `bun test` from a clean root still runs everything.
      // --preload wires a global cwd-restore guard (tests/setup.ts) so a
      // chdir'ing suite can never leak its cwd into the next file — Bun shares
      // one process across files and does NOT restore cwd at the boundary.
      exec: {
        command: 'bun test --preload ./tests/setup.ts ./tests/',
        // The child env is isolated, so the sandbox gate's switch has to be
        // forwarded explicitly (see tests/helpers/sandbox-gate.ts).
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json'],
          // The suite reads outside its own project, and both reaches are
          // load-bearing rather than incidental: the doc-drift tests assert
          // `docs/cli.md` and `docs/schema.md` against the parser and the
          // loader, and `package-boundaries` scans every sibling's `src/`.
          // Undeclared, editing `docs/cli.md` left this task on a cache hit
          // and the drift test never re-ran — the exact thing it exists to
          // catch. Remote execution is what surfaced it: locally the files
          // are on disk whether declared or not.
          // Named exactly, not `docs/**`: the two files the drift tests read
          // are the only ones that matter, and a broad glob would put the
          // 1 MB decision-log archive in every action's input tree and re-run
          // the whole suite whenever the log gains an entry.
          workspaceFiles: [
            'docs/cli.md',
            'docs/schema.md',
            'packages/*/src/**',
            'packages/*/package.json',
          ],
          // Folded into the KEY as well, which passThrough alone does not do.
          // Without it a green artifact from a run that SKIPPED the 21 sandbox
          // tests restores into a run that was supposed to require them — the
          // hole in the fix, not a nicety.
          env: ['VX_REQUIRE_SANDBOX'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      // Runs HERE, over this project's files. Since core moved out of the
      // root that is 225 of the repo's 426 files — the rest is covered by the
      // sibling packages linting THEMSELVES, not by this task reaching out of
      // its own directory. A task that climbs to the workspace root hardcodes
      // how deep it sits and breaks the project boundary; every project owns
      // its own lint instead.
      exec: { command: 'oxlint --type-aware --type-check' },
      dependsOn: ['install'],
      cache: {
        inputs: {
          // `package.json` is folded into every task's key by core, but the
          // KEY is not the input set — it has to be declared to be shipped,
          // and the type checker follows `src/version.ts`'s `../package.json`
          // import and the `@vzn/vx` self-reference into the members' own
          // manifests.
          files: ['src/**', 'tests/**', 'package.json'],
          // The command scans the whole tree, but project-relative globs
          // stop at project boundaries — without these, a change confined to
          // a sibling package rides a stale lint cache hit. `bench/`, the
          // linter config and the tsconfig sit at the workspace ROOT and are
          // root-anchored for the same reason: declared project-relative they
          // resolved to paths that do not exist, so editing `.oxlintrc.json`
          // did not invalidate this task — and a remotely executed action got
          // no tsconfig, which tsgolint reports as ~900 phantom "Cannot find
          // name 'process'" errors rather than as a missing file.
          // The linter's config and the tsconfig live at the workspace root,
          // outside every project-relative glob. Declared as INPUTS — which
          // is what `workspaceFiles` is for — so editing them invalidates
          // this task. The command still runs HERE, in this project.
          workspaceFiles: ['.oxlintrc.json', 'tsconfig.json'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      // Same as lint.oxlint: this project's files only, with the siblings
      // covering their own.
      exec: { command: 'oxfmt --check .' },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['**/*'],
          // Same boundary gap as lint.oxlint: `oxfmt --check .` scans the
          // workspace-member packages too (ui/deploy are oxfmt-ignored), and
          // its config lives at the root, outside every project-relative glob.
          workspaceFiles: ['.oxfmtrc.json'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt.fix': {
      description: 'oxfmt . — rewrite formatting in place',
      exec: { command: 'oxfmt .' },
    },

    'build.bun': {
      description: 'compile standalone binaries for every target',
      dependsOn: [
        'build.bun.linux-x64',
        'build.bun.linux-arm64',
        'build.bun.darwin-x64',
        'build.bun.darwin-arm64',
      ],
    },

    // Cross-target standalone binaries. One task per (os, arch) so
    // each gets its own cache slot. `dist/` is wiped before each
    // build by output cleaning, so the binary on disk always matches
    // the cached one.
    'build.bun.linux-x64': {
      description: 'compile standalone binary (linux x64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-x64 src/bin.ts --outfile dist/vx-linux-x64',
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-linux-x64'] },
      },
    },
    'build.bun.linux-arm64': {
      description: 'compile standalone binary (linux arm64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-arm64 src/bin.ts --outfile dist/vx-linux-arm64',
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-linux-arm64'] },
      },
    },
    'build.bun.darwin-x64': {
      description: 'compile standalone binary (darwin x64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-x64 src/bin.ts --outfile dist/vx-darwin-x64',
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-darwin-x64'] },
      },
    },
    'build.bun.darwin-arm64': {
      description: 'compile standalone binary (darwin arm64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-arm64 src/bin.ts --outfile dist/vx-darwin-arm64',
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-darwin-arm64'] },
      },
    },
  },
})
