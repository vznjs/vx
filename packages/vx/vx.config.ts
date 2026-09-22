import { defineProject } from '@vzn/vx'

// The core suite runs as this many parallel `bun test` processes, the files
// dealt by recorded weight (scripts/test-shard.ts). Many processes is not
// only speed: `bun test` pins ~2 descriptors per imported module and macOS
// caps a process at 10 240, so the whole suite in one process does not
// clear the cap. Twelve, not the four cores of the smallest box it runs
// on: an oversubscribed box finishes in the same wall time as eight, a
// twelve-core one in two thirds of it.
export const SHARD_COUNT = 12
const SHARDS = Array.from({ length: SHARD_COUNT }, (_, i) => i + 1)
const shardTask = (i: number) => ({
  description: `bun test, shard ${i} of ${SHARD_COUNT} (dealt by scripts/test-shard.ts)`,
  dependsOn: ['install'],
  exec: {
    command: `bun test $(bun scripts/test-shard.ts ${i} ${SHARD_COUNT})`,
    env: { passThrough: ['VX_REQUIRE_SANDBOX', 'VX_REQUIRE_WATCH_EVENTS', 'VX_REQUIRE_NONROOT'] },
    sandbox: {
      allow: {
        // The root README states counts the suite pins (the hook count,
        // item 283): a read across the project boundary, declared here
        // and made an input below so a README edit re-keys the shards.
        read: ['**/*', '../../README.md'],
        systemInfo: ['vfs.disk-space'],
        machLookup: ['com.apple.FSEvents'],
      },
    },
  },
  cache: {
    inputs: {
      files: ['**/*'],
      workspaceFiles: ['README.md'],
    },
    outputs: { files: [] as string[] },
  },
})
const shardTasks = Object.fromEntries(SHARDS.map((i) => [`test.bun.shard-${i}`, shardTask(i)]))

export default defineProject({
  tasks: {
    ...shardTasks,
    ci: {
      dependsOn: ['lint', 'test', 'check.binary'],
    },

    // `check.bun` sits under install so that every shard, the unsafe suite,
    // the lint tasks and the binary check wait on it: a gate below the Bun
    // floor stops here, in under a second, instead of an hour later with
    // the runtime's verdicts (scripts/bun-floor.ts says which).
    install: {
      dependsOn: ['^build', 'check.bun'],
    },

    'check.bun': {
      description: 'refuse a Bun below the floor (engines.bun) before any shard starts',
      exec: {
        command: 'bun scripts/bun-floor.ts',
        sandbox: {
          allow: {
            read: ['scripts/bun-floor.ts', 'src/util/bun-version.ts'],
          },
        },
      },
      // Uncached on purpose: the runtime's version is not a key input, and a
      // hit recorded under 1.4.2 must not answer for a later run under 1.3.11.
    },

    // Core is consumed as source: what a dependant's `install` pulls
    // through `^build` is what it needs from its deps, and for core that
    // is nothing — an explicit empty group says so, and keeps the
    // convention visible. The four release targets are `build.bun`
    // (release.yml), and `check.binary` proves the one this host can run.
    build: {
      description:
        'nothing to build — core is consumed as source; the release binaries are build.bun',
      dependsOn: [],
    },

    'check.binary': {
      description:
        'compile the host binary the way release.yml does; it must launch and report the manifest version',
      dependsOn: ['install'],
      exec: {
        command: 'bun scripts/check-binary.ts',
        sandbox: {
          allow: {
            read: ['**/*'],
            write: ['dist/**'],
            systemInfo: ['vfs.disk-space'],
          },
          ignore: {
            write: ['*.bun-build'],
          },
        },
      },
      cache: {
        inputs: {
          files: ['src/**', 'package.json', 'scripts/check-binary.ts'],
        },
        outputs: { files: [] },
      },
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    test: {
      dependsOn: ['test.bun'],
    },

    'test.bun': {
      description: 'bun test',
      // The pattern form: the shards are generated above, so a spread cannot
      // name them for the key check; `*` expands at graph build.
      dependsOn: ['test.bun.shard-*', 'test.bun.unsafe'],
    },

    'test.bun.unsafe': {
      description: 'bun test — the files a sandbox cannot host',
      dependsOn: ['install'],
      exec: {
        command: 'bun test ./tests/*.unsafe.test.ts',
        env: {
          passThrough: [
            'VX_REQUIRE_SANDBOX',
            'VX_REQUIRE_WATCH_EVENTS',
            'VX_REQUIRE_NONROOT',
            'VX_SMALL_DISK',
          ],
        },
      },
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      dependsOn: ['install'],
      exec: {
        command: 'oxlint --type-aware --type-check',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
          },
        },
      },
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      dependsOn: ['install'],
      exec: {
        command: 'oxfmt --check .',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
          },
        },
      },
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt.fix': {
      description: 'oxfmt . — rewrite formatting in place',
      exec: {
        command: 'oxfmt .',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['.'],
          },
        },
      },
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

    'build.bun.linux-x64': {
      description: 'compile standalone binary (linux x64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-x64 src/bin.ts --outfile dist/vx-linux-x64',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-linux-x64'],
          },
          ignore: {
            write: ['*.bun-build'],
          },
        },
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
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-linux-arm64'],
          },
          ignore: {
            write: ['*.bun-build'],
          },
        },
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
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-darwin-x64'],
          },
          ignore: {
            write: ['*.bun-build'],
          },
        },
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
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-darwin-arm64'],
          },
          ignore: {
            write: ['*.bun-build'],
          },
        },
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-darwin-arm64'] },
      },
    },
  },
})
