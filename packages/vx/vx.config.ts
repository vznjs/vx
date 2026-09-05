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

    // The suite runs as FOUR parallel processes (tests/helpers/shard.ts
    // deals the files longest-first by cost), each its own cached task.
    // One process took ~145 s; four take ~40 s wall on ten cores, and
    // separate processes are stricter than one — a spy or global leaked by
    // one file cannot reach another shard, which a single process hid once.
    //
    // Every shard declares the SAME inputs, deliberately: the shard helper
    // reads the whole tests/ directory to deal the files, so a file added
    // anywhere can move any shard's list. The helper runs `bun test` with
    // --preload tests/setup.ts (a global cwd-restore guard, so a chdir'ing
    // suite can never leak its cwd into the next file) and gives a file
    // marked `@vx-shard-isolate` a process of its own — `bun test` pins
    // descriptors per imported module, and one fixture importing 2 000
    // configs hits the macOS cap for every file after it. The child env is
    // isolated, so the sandbox
    // gate's switch has to be forwarded explicitly (tests/helpers/sandbox-gate.ts)
    // AND folded into the key — a green artifact from a run that SKIPPED
    // the sandbox tests must not restore into one that requires them.
    // The suite reads outside its own project: the doc-drift tests assert
    // `docs/cli.md` / `docs/schema.md` and `package-boundaries` scans every
    // sibling's `src/`; declared by name, not `docs/**`.
    test: {
      description: 'bun test against the tests/ tree (four shards)',
      dependsOn: ['test.0', 'test.1', 'test.2', 'test.3'],
    },

    'test.0': {
      description: 'bun test, shard 0 of 4 (tests/helpers/shard.ts)',
      exec: {
        command: 'bun tests/helpers/shard.ts run 4 0',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json'],
          workspaceFiles: [
            'docs/cli.md',
            'docs/schema.md',
            'packages/*/src/**',
            'packages/*/package.json',
          ],
          env: ['VX_REQUIRE_SANDBOX'],
        },
        outputs: { files: [] },
      },
    },

    'test.1': {
      description: 'bun test, shard 1 of 4 (tests/helpers/shard.ts)',
      exec: {
        command: 'bun tests/helpers/shard.ts run 4 1',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json'],
          workspaceFiles: [
            'docs/cli.md',
            'docs/schema.md',
            'packages/*/src/**',
            'packages/*/package.json',
          ],
          env: ['VX_REQUIRE_SANDBOX'],
        },
        outputs: { files: [] },
      },
    },

    'test.2': {
      description: 'bun test, shard 2 of 4 (tests/helpers/shard.ts)',
      exec: {
        command: 'bun tests/helpers/shard.ts run 4 2',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json'],
          workspaceFiles: [
            'docs/cli.md',
            'docs/schema.md',
            'packages/*/src/**',
            'packages/*/package.json',
          ],
          env: ['VX_REQUIRE_SANDBOX'],
        },
        outputs: { files: [] },
      },
    },

    'test.3': {
      description: 'bun test, shard 3 of 4 (tests/helpers/shard.ts)',
      exec: {
        command: 'bun tests/helpers/shard.ts run 4 3',
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json'],
          workspaceFiles: [
            'docs/cli.md',
            'docs/schema.md',
            'packages/*/src/**',
            'packages/*/package.json',
          ],
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
          // This project only: `.oxlintrc.json` and `tsconfig.json` live
          // HERE now, so the linter's own config invalidates the task
          // through a project-relative glob and nothing reaches the root.
          // Siblings lint themselves the same way.
          files: ['src/**', 'tests/**', 'package.json', '.oxlintrc.json', 'tsconfig.json'],
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
          // `**/*` already covers `.oxfmtrc.json`, which lives here.
          files: ['**/*'],
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
